local util = require("timi.util")
local T = {}
T.__index = T
local P = {VIEW = 1024, SEND = 2048, MANAGE_CHANNELS = 16, MANAGE_MESSAGES = 8192, MANAGE_THREADS = 2^34, CREATE_PRIVATE_THREADS = 2^36, SEND_THREADS = 2^38, HISTORY = 65536, ATTACH = 32768, EMBED = 16384, MANAGE_GUILD = 32}
local function row(items) return util.row(items) end
local function button(id, label, style) return util.button(id, label, style or 2) end
local function embed(title, description) return {color = 8421504, title = title, description = description} end
local function has_manager(i) return util.has_permission(i, P.MANAGE_GUILD) end
local function allowed_roles(i) return ((i.member or {}).roles or {}) end

function T.new(rest, store, interactions)
  return setmetatable({rest = rest, store = store, interactions = interactions, cooldowns = {}, closing = {}}, T)
end
function T:ticket_text(x)
  return table.concat({
    "**Ticket Panel Configuration**", "", "**Panel title:** " .. x.panel_title,
    "**Panel description:** " .. x.panel_description, "**Open button:** " .. x.open_label,
    "**Ticket message:** " .. x.ticket_message, "**Close button:** " .. x.close_label,
    "**Category:** " .. x.category_name, "**Support role:** " .. util.mention_role(x.support_role_id),
    "**Transcript channel:** " .. util.mention_channel(x.transcript_channel_id),
    "**Panel channel:** " .. (x.panel_channel_id == "" and "Current channel" or util.mention_channel(x.panel_channel_id)),
    "", "Edit a setting, then publish. This configuration response stays in place."
  }, "\n")
end
function T:settings_components()
  return {row({button("ticket:edit-panel", "Edit panel"), button("ticket:edit-ticket", "Edit ticket message"), button("ticket:edit-category", "Edit category")}),
    row({button("ticket:edit-access", "Edit support and transcript"), button("ticket:publish", "Publish panel", 1)})}
end
function T:public_payload(settings)
  return {embeds = {embed(settings.panel_title, settings.panel_description)}, components = {row({button("ticket:open", settings.open_label, 1)})}, allowed_mentions = {parse = {}}}
end
function T:refresh(settings)
  for _, panel in ipairs(settings.published_panels or {}) do
    local ok, err = pcall(function() self.rest:patch("/channels/" .. panel.channel_id .. "/messages/" .. panel.message_id, self:public_payload(settings)) end)
    if not ok then util.log("warn", "Could not refresh ticket panel: " .. tostring(err)) end
  end
end
function T:publish(guild, channel, settings)
  local destination = settings.panel_channel_id ~= "" and settings.panel_channel_id or channel
  local existing
  for _, panel in ipairs(settings.published_panels or {}) do if panel.channel_id == destination then existing = panel end end
  if existing then self.rest:patch("/channels/" .. destination .. "/messages/" .. existing.message_id, self:public_payload(settings))
  else
    local sent = self.rest:post("/channels/" .. destination .. "/messages", self:public_payload(settings))
    settings.published_panels[#settings.published_panels + 1] = {channel_id = destination, message_id = sent.id}
  end
  settings.panel_channel_id = destination
  self.store.data.tickets[guild] = settings; self.store:save()
  return destination
end
function T:find_channel(guild, name, kind)
  for _, channel in ipairs(self.rest:get("/guilds/" .. guild .. "/channels") or {}) do
    if channel.name == name and (kind == nil or channel.type == kind) then return channel end
  end
end
function T:setup(interaction)
  local guild, actor = util.guild_id(interaction), util.user_id(interaction)
  local channels = self.rest:get("/guilds/" .. guild .. "/channels") or {}
  local category
  for _, channel in ipairs(channels) do if channel.type == 4 and string.lower(channel.name or "") == "ticket" then category = channel end end
  if not category then self.rest:post("/guilds/" .. guild .. "/channels", {name = "ticket", type = 4, reason = "Timi ticket setup"}) end
  for _, name in ipairs({"timi-logs", "timi-confirmations"}) do
    for _, channel in ipairs(channels) do
      if channel.type == 0 and channel.name == name then
        return self.interactions:finish(interaction, "A channel named #" .. name .. " already exists. Rename or remove it, then retry. Existing permissions were not changed.", {})
      end
    end
  end
  local guild_info, me = self.rest:get("/guilds/" .. guild), self.rest:get("/users/@me")
  local roles = self.rest:get("/guilds/" .. guild .. "/roles") or {}
  local overwrites = {{id = guild, type = 0, allow = "0", deny = tostring(P.VIEW)}}
  for _, role in ipairs(roles) do
    if role.id ~= guild then
      if #overwrites >= 98 then
        return self.interactions:finish(interaction, "This server has too many roles to safely make the Timi channels private. Remove unused roles and retry.", {})
      end
      overwrites[#overwrites + 1] = {id = role.id, type = 0, allow = "0", deny = tostring(P.VIEW)}
    end
  end
  local allowed_users = {}
  for _, user_id in ipairs({guild_info.owner_id, actor, me.id}) do
    if user_id and not allowed_users[user_id] then
      allowed_users[user_id] = true
      local allow = P.VIEW + P.SEND + P.HISTORY
      if user_id == me.id then allow = allow + P.EMBED + P.ATTACH + P.MANAGE_MESSAGES end
      overwrites[#overwrites + 1] = {id = user_id, type = 1, allow = tostring(allow), deny = "0"}
    end
  end
  local logs = self.rest:post("/guilds/" .. guild .. "/channels", {name = "timi-logs", type = 0, topic = "Private moderation logs for Timi.", permission_overwrites = overwrites})
  local confirmations = self.rest:post("/guilds/" .. guild .. "/channels", {name = "timi-confirmations", type = 0, topic = "Private setup confirmations for Timi.", permission_overwrites = overwrites})
  local mods = self.store:mods(guild); mods.log_channel_id = logs.id; self.store:save()
  self.rest:post("/channels/" .. confirmations.id .. "/messages", {content = "Timi setup completed by <@" .. actor .. ">. Private log channel: <#" .. logs.id .. ">."})
  return self.interactions:finish(interaction, "Setup complete. Created <#" .. logs.id .. ">, <#" .. confirmations.id .. ">, and the ticket category. Configure the ticket name, support role, description, button label, category, transcript channel and panel destination.",
    {row({button("ticket:wizard-start", "Configure ticket system", 1)})})
end
function T:command(interaction, name)
  local guild, channel = util.guild_id(interaction), util.channel_id(interaction)
  if not has_manager(interaction) then return self.interactions:finish(interaction, "You need Manage Server permission.", {}) end
  if name == "ticket-setup" then return self:setup(interaction)
  elseif name == "ticket-panel" then
    local destination = self:publish(guild, channel, self.store:ticket(guild))
    return self.interactions:finish(interaction, "Ticket panel published or updated in <#" .. destination .. ">.", {})
  elseif name == "ticket-settings" then
    local settings = self.store:ticket(guild)
    return self.interactions:finish(interaction, self:ticket_text(settings), self:settings_components())
  end
end
function T:open(interaction)
  local guild, user, now = util.guild_id(interaction), util.user_id(interaction), util.monotonic_ms()
  local key = guild .. ":" .. user
  if self.cooldowns[key] and now - self.cooldowns[key] < 10000 then return self.interactions:finish(interaction, "Please wait a few seconds before opening another ticket.", {}) end
  self.cooldowns[key] = now
  local settings, channels = self.store:ticket(guild), self.rest:get("/guilds/" .. guild .. "/channels") or {}
  for _, channel in ipairs(channels) do if channel.type == 0 and channel.topic == "timi-ticket-owner:" .. user then return self.interactions:finish(interaction, "You already have an open ticket: <#" .. channel.id .. ">.", {}) end end
  local category
  for _, channel in ipairs(channels) do if channel.type == 4 and string.lower(channel.name or "") == string.lower(settings.category_name) then category = channel end end
  if not category then category = self.rest:post("/guilds/" .. guild .. "/channels", {name = settings.category_name, type = 4}) end
  local roles = self.rest:get("/guilds/" .. guild .. "/roles") or {}
  local support_exists = settings.support_role_id == ""
  for _, role in ipairs(roles) do if role.id == settings.support_role_id and not role.managed then support_exists = true end end
  if not support_exists then return self.interactions:finish(interaction, "The configured support role no longer exists or is managed. Update /ticket-settings before opening tickets.", {}) end
  local member, me = self.rest:get("/guilds/" .. guild .. "/members/" .. user), self.rest:get("/users/@me")
  local channel_name = "ticket-" .. util.clean_channel_name((member.user or {}).username or "member")
  local overwrites = {}
  for _, role in ipairs(roles) do
    if role.id ~= guild and role.id ~= settings.support_role_id then overwrites[#overwrites + 1] = {id = role.id, type = 0, allow = "0", deny = tostring(P.VIEW)} end
  end
  local extra = settings.support_role_id == "" and 3 or 4
  if #overwrites + extra > 100 then return self.interactions:finish(interaction, "This server has too many roles to safely create a private ticket channel. Discord allows at most 100 permission overwrites.", {}) end
  overwrites[#overwrites + 1] = {id = guild, type = 0, allow = "0", deny = tostring(P.VIEW)}
  if settings.support_role_id ~= "" then overwrites[#overwrites + 1] = {id = settings.support_role_id, type = 0, allow = tostring(P.VIEW + P.SEND + P.HISTORY + P.ATTACH + P.EMBED + P.SEND_THREADS), deny = "0"} end
  overwrites[#overwrites + 1] = {id = user, type = 1, allow = tostring(P.VIEW + P.SEND + P.HISTORY + P.ATTACH + P.EMBED + P.SEND_THREADS), deny = "0"}
  overwrites[#overwrites + 1] = {id = me.id, type = 1, allow = tostring(P.VIEW + P.SEND + P.HISTORY + P.MANAGE_CHANNELS + P.MANAGE_MESSAGES + P.MANAGE_THREADS + P.CREATE_PRIVATE_THREADS + P.SEND_THREADS + P.EMBED), deny = "0"}
  local created = self.rest:post("/guilds/" .. guild .. "/channels", {name = channel_name:sub(1, 100), type = 0, parent_id = category.id, topic = "timi-ticket-owner:" .. user, permission_overwrites = overwrites, reason = "Timi ticket opened by member"})
  local ticket_id = created.id
  local ticket_embed = embed(settings.panel_title, settings.ticket_message)
  ticket_embed.fields = {{name = "Priority", value = "Normal", inline = true}}
  local ok, sent = pcall(function()
    return self.rest:post("/channels/" .. ticket_id .. "/messages", {
      content = "<@" .. user .. ">", embeds = {ticket_embed},
      components = {row({button("ticket:close", settings.close_label), button("ticket:priority", "Set priority", 1)})},
      allowed_mentions = {users = {user}}
    })
  end)
  if not ok then pcall(function() self.rest:delete("/channels/" .. ticket_id) end); error("Could not post the initial ticket message: " .. tostring(sent)) end
  local thread_note = ""
  local thread_ok, thread = pcall(function()
    return self.rest:post("/channels/" .. ticket_id .. "/threads", {name = "staff-" .. channel_name:sub(1, 90), type = 12, auto_archive_duration = 1440, invitable = false})
  end)
  if thread_ok and thread and thread.id then
    pcall(function() self.rest:post("/channels/" .. thread.id .. "/messages", {content = "Private staff discussion for <#" .. ticket_id .. ">. The ticket owner cannot see this thread."}) end)
    if settings.support_role_id ~= "" then
      local after = ""
      while true do
        local path = "/guilds/" .. guild .. "/members?limit=1000" .. (after ~= "" and "&after=" .. after or "")
        local ok_members, members = pcall(function() return self.rest:get(path) end)
        if not ok_members or type(members) ~= "table" or #members == 0 then break end
        for _, candidate in ipairs(members) do
          if util.array_contains(candidate.roles or {}, settings.support_role_id) and candidate.user and candidate.user.id then
            pcall(function() self.rest:put("/channels/" .. thread.id .. "/thread-members/" .. candidate.user.id, nil) end)
          end
        end
        after = ((members[#members] or {}).user or {}).id or ""
        if #members < 1000 or after == "" then break end
      end
    end
    thread_note = " A private staff thread was created: <#" .. thread.id .. ">."
  else thread_note = " The ticket is open, but Timi could not create its private staff thread. Check Create Private Threads and Send Messages in Threads permissions." end
  self:log(guild, "Ticket opened. Member: <@" .. user .. ">. Channel: <#" .. ticket_id .. ">.")
  return self.interactions:finish(interaction, "Your ticket has been created: <#" .. ticket_id .. ">." .. thread_note, {})
end
function T:log(guild, message)
  local settings, channel = self.store:mods(guild), ""
  channel = settings.log_channel_id
  if channel == "" then local found = self:find_channel(guild, "timi", 0); channel = found and found.id or "" end
  if channel ~= "" then
    local ok, err = pcall(function() self.rest:post("/channels/" .. channel .. "/messages", {content = message, allowed_mentions = {parse = {}}}) end)
    if not ok then util.log("warn", "Ticket audit log failed: " .. tostring(err)) end
  end
end
function T:transcript(guild, channel)
  local settings = self.store:ticket(guild)
  if settings.transcript_channel_id == "" then return end
  local messages, before = {}, nil
  while #messages < 1000 do
    local remaining = math.min(100, 1000 - #messages)
    local path = "/channels/" .. channel .. "/messages?limit=" .. tostring(remaining) .. (before and "&before=" .. before or "")
    local ok, batch = pcall(function() return self.rest:get(path) end)
    if not ok or type(batch) ~= "table" or #batch == 0 then break end
    for _, message in ipairs(batch) do messages[#messages + 1] = message end
    before = batch[#batch].id
    if #batch < remaining then break end
  end
  table.sort(messages, function(a, b) return tostring(a.timestamp or "") < tostring(b.timestamp or "") end)
  local chunk = "Transcript for ticket <#" .. channel .. ">\n"
  for _, message in ipairs(messages) do
    local content = message.content ~= "" and message.content or "(no text content)"
    local attachments = {}
    for _, file in ipairs(message.attachments or {}) do attachments[#attachments + 1] = tostring(file.filename or "attachment") .. ": " .. tostring(file.url or "") end
    if #attachments > 0 then content = content .. "\nAttachments: " .. table.concat(attachments, " | ") end
    local line = "[" .. tostring(message.timestamp or "time unknown") .. "] " .. tostring((message.author or {}).username or "unknown") .. ": " .. content
    if #chunk + #line > 1750 then self.rest:post("/channels/" .. settings.transcript_channel_id .. "/messages", {content = chunk, allowed_mentions = {parse = {}}}); chunk = "" end
    chunk = chunk .. line:sub(1, 1700) .. "\n"
  end
  if chunk ~= "" then
    if #messages >= 1000 then chunk = chunk .. "\nTranscript limited to the latest 1,000 messages." end
    self.rest:post("/channels/" .. settings.transcript_channel_id .. "/messages", {content = chunk:sub(1, 1990), allowed_mentions = {parse = {}}})
  end
end
function T:component(interaction, custom)
  local guild, channel, user = util.guild_id(interaction), util.channel_id(interaction), util.user_id(interaction)
  local manager = has_manager(interaction)
  if custom == "ticket:open" then return self:open(interaction) end
  if custom == "ticket:close" or custom == "ticket:confirm-close" or custom == "ticket:cancel-close" then
    local info = self.rest:get("/channels/" .. channel)
    local owner = tostring(info.topic or ""):match("^timi%-ticket%-owner:(%d+)$")
    if not owner then return self.interactions:finish(interaction, "This is not a Timi ticket channel.", {}) end
    if user ~= owner and not manager then return self.interactions:finish(interaction, "Only the ticket owner or a server manager can close this ticket.", {}) end
    if custom == "ticket:close" then return self.interactions:finish(interaction, "Are you sure you want to close this ticket?", {row({button("ticket:confirm-close", "Yes, close it"), button("ticket:cancel-close", "Cancel")})}) end
    if custom == "ticket:cancel-close" then return self.interactions:finish(interaction, "Ticket closure cancelled.", {}) end
    local key = guild .. ":" .. channel
    if self.closing[key] then return self.interactions:finish(interaction, "This ticket is already closing.", {}) end
    self.closing[key] = true
    local ok, err = pcall(function()
      local transcript_ok, transcript_err = pcall(function() self:transcript(guild, channel) end)
      if not transcript_ok then util.log("warn", "Ticket transcript failed for " .. channel .. ": " .. tostring(transcript_err)) end
      self:log(guild, "Ticket closed. Channel: <#" .. channel .. ">. Closed by: <@" .. user .. ">.")
      self.rest:delete("/channels/" .. channel)
    end)
    self.closing[key] = nil
    if not ok then
      util.log("error", "Ticket close failed for channel " .. channel .. ": " .. tostring(err))
      return self.interactions:finish(interaction, "Timi could not close this ticket. The ticket is still open; check the bot's channel permissions and try again.", {})
    end
    return self.interactions:finish(interaction, "Ticket closed.", {})
  end
  if custom == "ticket:priority" then
    local settings = self.store:ticket(guild)
    local staff = settings.support_role_id ~= "" and util.array_contains(allowed_roles(interaction), settings.support_role_id)
    if not staff and not manager then return self.interactions:finish(interaction, "Only support staff can change ticket priority.", {}) end
    local message_id = ((interaction.message or {}).id or "")
    return self.interactions:finish(interaction, "Choose the priority for this ticket.", {row({{type = 3, custom_id = "ticket:priority-select:" .. message_id, placeholder = "Select priority", min_values = 1, max_values = 1, options = {
      {label = "Low", value = "low", description = "Routine request"},
      {label = "Normal", value = "normal", description = "Standard support request", default = true},
      {label = "High", value = "high", description = "Needs attention soon"},
      {label = "Urgent", value = "urgent", description = "Time-sensitive issue"}
    }}})})
  end
  if custom:match("^ticket:priority%-select:") then
    local settings = self.store:ticket(guild)
    local staff = settings.support_role_id ~= "" and util.array_contains(allowed_roles(interaction), settings.support_role_id)
    if not staff and not manager then return self.interactions:finish(interaction, "Only support staff can change ticket priority.", {}) end
    local priority = ((interaction.data or {}).values or {})[1]
    local names, icons = {low = "Low", normal = "Normal", high = "High", urgent = "Urgent"}, {low = "🟢", normal = "🟡", high = "🟠", urgent = "🔴"}
    if not names[priority] then return self.interactions:finish(interaction, "Choose a valid priority level.", {}) end
    local message_id = custom:match("^ticket:priority%-select:(%d+)$")
    if not message_id then return self.interactions:finish(interaction, "This ticket priority control is invalid.", {}) end
    local current = self.rest:get("/channels/" .. channel)
    local current_name = tostring(current.name or "ticket")
    for _, icon in ipairs({"🟢", "🟡", "🟠", "🔴"}) do
      local prefix = icon .. "-"
      if current_name:sub(1, #prefix) == prefix then current_name = current_name:sub(#prefix + 1); break end
    end
    self.rest:patch("/channels/" .. channel, {name = (icons[priority] .. "-" .. current_name):sub(1, 100)})
    local message = self.rest:get("/channels/" .. channel .. "/messages/" .. message_id)
    local first = message.embeds and message.embeds[1]
    if first then
      first.fields = first.fields or {}
      local found = false
      for _, field in ipairs(first.fields) do if field.name == "Priority" then field.value = names[priority]; found = true end end
      if not found then first.fields[#first.fields + 1] = {name = "Priority", value = names[priority], inline = true} end
      self.rest:patch("/channels/" .. channel .. "/messages/" .. message_id, {embeds = {first}})
    end
    return self.interactions:finish(interaction, "Ticket priority set to **" .. names[priority] .. "**.", {})
  end
  if custom == "ticket:wizard-start" or custom == "ticket:wizard-continue" or custom == "ticket:edit-panel" or custom == "ticket:edit-ticket" or custom == "ticket:edit-category" or custom == "ticket:edit-access" then
    if not manager then return self.interactions:finish(interaction, "You need Manage Server permission to configure tickets.", {}) end
    local x = self.store:ticket(guild)
    if custom == "ticket:wizard-start" then
      return self.interactions:show_modal(interaction, util.modal("ticket:wizard-stage1", "Ticket setup - 1 of 2", {
        util.text_input("ticket-name", "Ticket panel name", x.panel_title, false, 200), util.text_input("support-role", "Support role ID", x.support_role_id, false, 22),
        util.text_input("description", "Panel description", x.panel_description, true, 1000), util.text_input("button-label", "Open button label", x.open_label, false, 80),
        util.text_input("category", "Ticket category name", x.category_name, false, 100)
      }))
    elseif custom == "ticket:wizard-continue" then
      return self.interactions:show_modal(interaction, util.modal("ticket:wizard-stage2", "Ticket setup - 2 of 2", {
        util.text_input("ticket-message", "Message shown inside tickets", x.ticket_message, true, 1000),
        util.text_input("transcript-channel", "Transcript channel ID (optional)", x.transcript_channel_id, false, 22, false),
        util.text_input("panel-channel", "Panel channel ID (blank = this channel)", x.panel_channel_id, false, 22, false)
      }))
    elseif custom == "ticket:edit-panel" then
      return self.interactions:show_modal(interaction, util.modal("ticket:modal-panel", "Customize Ticket Panel", {
        util.text_input("title", "Panel title", x.panel_title, false, 200), util.text_input("description", "Panel description", x.panel_description, true, 1000),
        util.text_input("open-label", "Open button label", x.open_label, false, 80)
      }))
    elseif custom == "ticket:edit-ticket" then
      return self.interactions:show_modal(interaction, util.modal("ticket:modal-ticket", "Customize Ticket Message", {
        util.text_input("message", "Message inside each ticket", x.ticket_message, true, 1000), util.text_input("close-label", "Close button label", x.close_label, false, 80)
      }))
    elseif custom == "ticket:edit-category" then
      return self.interactions:show_modal(interaction, util.modal("ticket:modal-category", "Customize Ticket Category", {util.text_input("category", "Category name", x.category_name, false, 100)}))
    end
    return self.interactions:show_modal(interaction, util.modal("ticket:modal-access", "Support and Transcript", {
      util.text_input("support-role", "Support role ID (blank for none)", x.support_role_id, false, 22, false),
      util.text_input("transcript", "Transcript channel ID (blank for none)", x.transcript_channel_id, false, 22, false),
      util.text_input("panel-channel", "Panel channel ID (blank for current)", x.panel_channel_id, false, 22, false)
    }))
  end
  if custom == "ticket:publish" then
    if not manager then return self.interactions:finish(interaction, "You need Manage Server permission to configure tickets.", {}) end
    local destination = self:publish(guild, channel, self.store:ticket(guild))
    return self.interactions:finish(interaction, "Ticket panel published or updated in <#" .. destination .. ">.", {})
  end
  return self.interactions:finish(interaction, "This ticket control is no longer available.", {})
end
function T:modal(interaction, custom, fields)
  local guild = util.guild_id(interaction)
  if not has_manager(interaction) then return self.interactions:finish(interaction, "You need Manage Server permission to edit ticket settings.", {}) end
  local x = self.store:ticket(guild)
  if custom == "ticket:wizard-stage1" then
    x.panel_title, x.support_role_id = util.trim(fields["ticket-name"]), util.trim(fields["support-role"])
    x.panel_description, x.open_label, x.category_name = util.trim(fields.description), util.trim(fields["button-label"]), util.trim(fields.category)
    if x.panel_title == "" or x.panel_description == "" or x.open_label == "" or x.category_name == "" or (x.support_role_id ~= "" and not util.is_snowflake(x.support_role_id)) then
      return self.interactions:finish(interaction, "Complete every required field. The support role must be a valid Discord role ID.", {})
    end
    self.store.data.tickets[guild] = x; self.store:save()
    return self.interactions:finish(interaction, "First part saved. Continue with the transcript and panel destination.", {row({button("ticket:wizard-continue", "Continue setup", 1)})})
  elseif custom == "ticket:wizard-stage2" then
    x.ticket_message, x.transcript_channel_id, x.panel_channel_id = util.trim(fields["ticket-message"]), util.trim(fields["transcript-channel"]), util.trim(fields["panel-channel"])
    if x.ticket_message == "" or (x.transcript_channel_id ~= "" and not util.is_snowflake(x.transcript_channel_id)) or (x.panel_channel_id ~= "" and not util.is_snowflake(x.panel_channel_id)) then
      return self.interactions:finish(interaction, "Enter a ticket message and valid numeric channel IDs. Leave optional channel IDs blank to use defaults.", {})
    end
  elseif custom == "ticket:modal-panel" then
    x.panel_title, x.panel_description, x.open_label = util.trim(fields.title), util.trim(fields.description), util.trim(fields["open-label"])
  elseif custom == "ticket:modal-ticket" then
    x.ticket_message, x.close_label = util.trim(fields.message), util.trim(fields["close-label"])
  elseif custom == "ticket:modal-category" then
    x.category_name = util.trim(fields.category)
  elseif custom == "ticket:modal-access" then
    x.support_role_id, x.transcript_channel_id, x.panel_channel_id = util.trim(fields["support-role"]), util.trim(fields.transcript), util.trim(fields["panel-channel"])
    for _, value in ipairs({x.support_role_id, x.transcript_channel_id, x.panel_channel_id}) do
      if value ~= "" and not util.is_snowflake(value) then return self.interactions:finish(interaction, "Role and channel IDs must be valid numeric Discord IDs.", {}) end
    end
  else return self.interactions:finish(interaction, "This ticket form is no longer available.", {}) end
  if x.panel_title == "" or x.panel_description == "" or x.open_label == "" or x.ticket_message == "" or x.close_label == "" or x.category_name == "" then
    return self.interactions:finish(interaction, "Ticket settings must contain text.", {})
  end
  self.store.data.tickets[guild] = x; self.store:save(); self:refresh(x)
  return self.interactions:finish(interaction, self:ticket_text(x), self:settings_components())
end

return T

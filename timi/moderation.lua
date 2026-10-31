local util = require("./util")
local M = {}
M.__index = M
local function row(items) return util.row(items) end
local function button(id, label, style) return util.button(id, label, style or 2) end
local function is_manager(i) return util.has_permission(i, 32) end
local function has_bit(value, flag) return math.floor(value / flag) % 2 == 1 end

function M.new(rest, store, interactions)
  return setmetatable({rest = rest, store = store, interactions = interactions, spam = {}, warning_retention = 30 * 86400000}, M)
end
function M:text(x)
  return table.concat({"**Timi Moderation Settings**", "", "**Module:** " .. (x.enabled and "Active" or "Inactive"),
    "**Sanction:** " .. x.sanction, "**Timeout duration:** " .. tostring(x.timeout_minutes) .. " minute(s)",
    "**Log channel:** " .. util.mention_channel(x.log_channel_id), "**Action duration:** " .. tostring(x.action_duration_seconds) .. " second(s)",
    "**Maximum messages:** " .. tostring(x.max_message_count), "**Block Discord invites:** " .. tostring(x.block_invites),
    "**Block mass mentions:** " .. tostring(x.block_mass_mentions), "**Block excessive caps:** " .. tostring(x.block_excessive_caps)}, "\n")
end
function M:components(x)
  return {row({button(x.enabled and "modpanel:disable" or "modpanel:enable", x.enabled and "Disable" or "Enable", x.enabled and 4 or 3), button("modpanel:sanction", "Edit sanction"), button("modpanel:log", "Set log channel")}),
    row({button("modpanel:duration", "Action duration"), button("modpanel:max-count", "Max messages")}),
    row({button("modpanel:invites", "Toggle invites"), button("modpanel:mentions", "Toggle mentions"), button("modpanel:caps", "Toggle caps")})}
end
function M:refresh(guild, x)
  if not x.panel_channel_id or x.panel_channel_id == "" or not x.panel_message_id or x.panel_message_id == "" then return end
  local ok, err = pcall(function() self.rest:patch("/channels/" .. x.panel_channel_id .. "/messages/" .. x.panel_message_id, {content = self:text(x), components = self:components(x)}) end)
  if not ok then util.log("warn", "Could not update moderation panel: " .. tostring(err)) end
end
function M:command(interaction)
  if not is_manager(interaction) then return self.interactions:finish(interaction, "You need Manage Server permission to change moderation settings.", {}) end
  local guild, channel = util.guild_id(interaction), util.channel_id(interaction)
  local x = self.store:mods(guild)
  if x.panel_channel_id ~= "" and x.panel_message_id ~= "" then
    local ok = pcall(function() self.rest:patch("/channels/" .. x.panel_channel_id .. "/messages/" .. x.panel_message_id, {content = self:text(x), components = self:components(x)}) end)
    if ok then return self.interactions:finish(interaction, "The existing moderation settings panel was updated.", {}) end
    x.panel_channel_id, x.panel_message_id = "", ""
  end
  local sent = self.rest:post("/channels/" .. channel .. "/messages", {content = self:text(x), components = self:components(x)})
  x.panel_channel_id, x.panel_message_id = channel, sent.id
  self.store.data.moderation[guild] = x; self.store:save()
  return self.interactions:finish(interaction, "A persistent moderation settings panel was created in this channel.", {})
end
function M:component(interaction, custom)
  if not is_manager(interaction) then return self.interactions:finish(interaction, "You need Manage Server permission to edit moderation settings.", {}) end
  local guild, x = util.guild_id(interaction), self.store:mods(util.guild_id(interaction))
  if custom == "modpanel:sanction" then
    return self.interactions:show_modal(interaction, util.modal("modpanel:sanction-modal", "Edit applied sanction", {
      util.text_input("sanction", "Sanction: timeout, kick, ban, delete", x.sanction, false, 12),
      util.text_input("timeout-minutes", "Timeout duration in minutes", tostring(x.timeout_minutes), false, 5)}))
  elseif custom == "modpanel:duration" or custom == "modpanel:max-count" then
    local duration = custom == "modpanel:duration"
    return self.interactions:show_modal(interaction, util.modal(duration and "modpanel:duration-modal" or "modpanel:max-count-modal", duration and "Edit action duration" or "Edit max message count", {
      util.text_input("value", duration and "Action duration in seconds" or "Maximum message count", tostring(duration and x.action_duration_seconds or x.max_message_count), false, 3)}))
  elseif custom == "modpanel:log" then
    return self.interactions:finish(interaction, "Select the channel where moderation logs should be sent.", {row({{type = 8, custom_id = "modpanel:log-select", placeholder = "Select a log channel", channel_types = {0}, min_values = 1, max_values = 1}})})
  elseif custom == "modpanel:enable" or custom == "modpanel:disable" then x.enabled = custom == "modpanel:enable"
  elseif custom == "modpanel:log-select" then
    local selected = ((interaction.data or {}).values or {})[1] or ""
    if not util.is_snowflake(selected) then return self.interactions:finish(interaction, "Select a valid text channel.", {}) end
    x.log_channel_id = selected
  elseif custom == "modpanel:invites" then x.block_invites = not x.block_invites
  elseif custom == "modpanel:mentions" then x.block_mass_mentions = not x.block_mass_mentions
  elseif custom == "modpanel:caps" then x.block_excessive_caps = not x.block_excessive_caps
  else return self.interactions:finish(interaction, "This moderation control is no longer available.", {}) end
  self.store.data.moderation[guild] = x; self.store:save(); self:refresh(guild, x)
  return self.interactions:finish(interaction, self:text(x), self:components(x))
end
function M:modal(interaction, custom, fields)
  if not is_manager(interaction) then return self.interactions:finish(interaction, "You need Manage Server permission to edit moderation settings.", {}) end
  local guild, x = util.guild_id(interaction), self.store:mods(util.guild_id(interaction))
  if custom == "modpanel:sanction-modal" then
    local action, minutes = string.lower(util.trim(fields.sanction)), tonumber(fields["timeout-minutes"]) or 0
    if action ~= "timeout" and action ~= "kick" and action ~= "ban" and action ~= "delete" then return self.interactions:finish(interaction, "Use timeout, kick, ban, or delete.", {}) end
    if minutes < 1 or minutes > 40320 then return self.interactions:finish(interaction, "Timeout must be 1–40320 minutes.", {}) end
    x.sanction, x.timeout_minutes = action, minutes
  elseif custom == "modpanel:duration-modal" or custom == "modpanel:max-count-modal" then
    local n = tonumber(fields.value) or 0
    if custom == "modpanel:duration-modal" then
      if n < 1 or n > 60 then return self.interactions:finish(interaction, "Action duration must be 1–60 seconds.", {}) end
      x.action_duration_seconds = n
    else
      if n < 1 or n > 100 then return self.interactions:finish(interaction, "Max message count must be 1–100.", {}) end
      x.max_message_count = n
    end
  else return self.interactions:finish(interaction, "This moderation form is no longer available.", {}) end
  self.store.data.moderation[guild] = x; self.store:save(); self:refresh(guild, x)
  return self.interactions:finish(interaction, self:text(x), self:components(x))
end
local function member_is_exempt(rest, guild, member)
  local roles = rest:get("/guilds/" .. guild .. "/roles") or {}
  for _, role in ipairs(roles) do
    if role.id == guild or util.array_contains(member.roles or {}, role.id) then
      local permissions = tonumber(role.permissions or "0") or 0
      if has_bit(permissions, 8192) or has_bit(permissions, 8) then return true end
    end
  end
  return false
end
function M:warn(guild, user, reason_text)
  local cases, now, max_id = self.store.data.moderation_cases[guild] or {}, util.now_ms(), 0
  local kept = {}
  for _, case in ipairs(cases) do
    if case.type ~= "warning" or now - (case.created_at or now) <= self.warning_retention then
      kept[#kept + 1] = case
      if tonumber(case.id) and tonumber(case.id) > max_id then max_id = tonumber(case.id) end
    end
  end
  local id = max_id + 1
  kept[#kept + 1] = {id = id, type = "warning", user_id = user, moderator_id = "timi", reason = reason_text, created_at = now, automatic = true}
  self.store.data.moderation_cases[guild] = kept; self.store:save()
  return id
end
function M:log(guild, channel, content)
  local settings, target = self.store:mods(guild), ""
  target = settings.log_channel_id
  if target == "" then for _, c in ipairs(self.rest:get("/guilds/" .. guild .. "/channels") or {}) do if c.type == 0 and c.name == "timi" then target = c.id end end end
  if target ~= "" then pcall(function() self.rest:post("/channels/" .. target .. "/messages", {content = content, allowed_mentions = {parse = {}}}) end) end
end
function M:message(message)
  if not message.guild_id or (message.author or {}).bot then return end
  local guild, user = message.guild_id, message.author.id
  if not guild or not user then return end
  local owner = self.rest:get("/guilds/" .. guild)
  if owner and owner.owner_id == user then return end
  local settings = self.store:mods(guild)
  if not settings.enabled then return end
  local member = message.member or self.rest:get("/guilds/" .. guild .. "/members/" .. user)
  if member_is_exempt(self.rest, guild, member) then return end
  local content, lower = tostring(message.content or ""), string.lower(tostring(message.content or ""))
  for _, word in ipairs(self.store.data.automod_words[guild] or {}) do
    if word ~= "" and lower:find(string.lower(word), 1, true) then
      local why = "blocked word or phrase: " .. word
      self.rest:delete("/channels/" .. message.channel_id .. "/messages/" .. message.id)
      local record = self.store:member(guild, user)
      record.suspicious = record.suspicious + 1; record.last_suspicious = util.now_ms(); record.last_reason = why
      local warning = self:warn(guild, user, why)
      self:log(guild, message.channel_id, "AutoMod removed a message from <@" .. user .. "> in <#" .. message.channel_id .. ">. Automatic warning #" .. warning .. ". Reason: " .. why .. ".")
      return
    end
  end
  local now, key = util.monotonic_ms(), guild .. ":" .. message.channel_id .. ":" .. user
  local entries = self.spam[key] or {}; self.spam[key] = entries
  local normalized, links = util.normalize_message(content), 0
  for _ in content:gmatch("https?://%S+") do links = links + 1 end
  local invite = lower:find("discord.gg/", 1, true) or lower:find("discord.com/invite/", 1, true) or lower:find("discordapp.com/invite/", 1, true)
  local letters, uppercase = 0, 0
  for char in content:gmatch("%a") do letters = letters + 1; if char:match("%u") then uppercase = uppercase + 1 end end
  local caps = letters >= 12 and uppercase / letters >= 0.75
  local mentions = #(message.mentions or {}) + #(message.mention_roles or {})
  entries[#entries + 1] = {id = message.id, at = now, content = normalized, links = links}
  local kept = {}
  for _, item in ipairs(entries) do if now - item.at <= 20000 then kept[#kept + 1] = item end end
  while #kept > 100 do table.remove(kept, 1) end
  self.spam[key] = kept
  local recent, repeated, rapid_links, message_ids = 0, false, 0, {}
  for _, item in ipairs(kept) do
    if now - item.at <= 8000 then
      recent, rapid_links = recent + 1, rapid_links + item.links
      message_ids[#message_ids + 1] = item.id
      if item.id ~= message.id and #normalized >= 4 and util.jaccard(normalized, item.content) >= 0.88 then repeated = true end
    end
  end
  local why
  if recent >= math.max(2, settings.max_message_count) then why = "message burst"
  elseif repeated then why = "repeated or near-identical message"
  elseif settings.block_mass_mentions and (message.mention_everyone or mentions >= 5) then why = message.mention_everyone and "mass mention (@everyone or @here)" or "mention spam"
  elseif settings.block_invites and invite then why = "unapproved Discord invite link"
  elseif settings.block_excessive_caps and caps then why = "excessive capital letters"
  elseif links >= 4 then why = "link spam"
  elseif rapid_links >= 5 then why = "rapid link posting" end
  if not why then return end
  self.spam[key] = nil
  local record = self.store:member(guild, user)
  record.suspicious = record.suspicious + 1; record.last_suspicious = util.now_ms(); record.last_reason = why
  local warning = self:warn(guild, user, why)
  if #message_ids >= 2 and #message_ids <= 100 then
    pcall(function() self.rest:post("/channels/" .. message.channel_id .. "/messages/bulk-delete", {messages = message_ids}) end)
  else
    pcall(function() self.rest:delete("/channels/" .. message.channel_id .. "/messages/" .. message.id) end)
  end
  local action = "messages deleted"
  if settings.sanction == "timeout" then
    local until_time = os.date("!%Y-%m-%dT%H:%M:%SZ", os.time() + settings.timeout_minutes * 60)
    if pcall(function() self.rest:patch("/guilds/" .. guild .. "/members/" .. user, {communication_disabled_until = until_time, reason = why}) end) then action = "timed out for " .. tostring(settings.timeout_minutes) .. " minute(s)" end
  elseif settings.sanction == "kick" then
    if pcall(function() self.rest:delete("/guilds/" .. guild .. "/members/" .. user) end) then action = "kicked" end
  elseif settings.sanction == "ban" then
    if pcall(function() self.rest:put("/guilds/" .. guild .. "/bans/" .. user, {delete_message_seconds = math.min(60, settings.action_duration_seconds)}) end) then action = "banned" end
  end
  self:log(guild, message.channel_id, "Anti-spam action: " .. action .. ". Automatic warning #" .. warning .. " issued to <@" .. user .. ">. Channel: <#" .. message.channel_id .. ">. Reason: " .. why .. ".")
end

return M

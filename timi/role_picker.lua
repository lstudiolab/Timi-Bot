local util = require("./util")
local R = {}
R.__index = R

local function row(items) return util.row(items) end
local function button(id, label, style) return util.button(id, label, style or 2) end

function R.new(rest, store, interactions, verification)
  return setmetatable({rest = rest, store = store, interactions = interactions, verification = verification}, R)
end

function R:is_owner(guild, user)
  local info = self.rest:get("/guilds/" .. guild)
  return info.owner_id == user
end

function R:command(interaction)
  local guild, user = util.guild_id(interaction), util.user_id(interaction)
  if not self:is_owner(guild, user) then return self.interactions:finish(interaction, "Only the server owner can create role picker menus.", {}) end
  return self.interactions:finish(interaction, "**Role picker setup**\n\nCreate a self-service role menu. Configure its appearance, choose the allowed roles, then publish.", {
    row({button("rolepicker:start", "Configure role picker", 1)})
  })
end

function R:component(interaction, custom)
  local guild, user, channel = util.guild_id(interaction), util.user_id(interaction), util.channel_id(interaction)
  if custom == "rolepicker:start" then
    return self.interactions:show_modal(interaction, util.modal("rolepicker:details", "Role picker settings", {
      util.text_input("rp-title", "Menu title", "Choose your roles", false, 100),
      util.text_input("rp-description", "Description", "Select the roles you want.", true, 500),
      util.text_input("rp-placeholder", "Dropdown placeholder", "Select roles...", false, 150),
      util.text_input("rp-footer", "Optional bottom button text", "", false, 80, false),
      util.text_input("rp-footer-channel", "Optional bottom button channel ID", "", false, 22, false)
    }))
  end
  local draft_id = custom:match("^rolepicker:setup%-roles:(.+)$")
  if draft_id then
    local draft = self.store.data.role_picker_drafts[draft_id]
    if not draft or draft.guild_id ~= guild then return self.interactions:finish(interaction, "This setup has expired. Run /setup-role-picker again.", {}) end
    draft.roles = ((interaction.data or {}).values or {})
    if #draft.roles < 1 or #draft.roles > 25 then return self.interactions:finish(interaction, "Select between 1 and 25 roles.", {}) end
    self.store:save()
    local select = {type = 6, custom_id = "rolepicker:setup-roles:" .. draft_id, placeholder = "Choose the roles members can pick", min_values = 1, max_values = 25}
    select.default_values = {}
    for _, role_id in ipairs(draft.roles) do select.default_values[#select.default_values + 1] = {id = role_id, type = "role"} end
    return self.interactions:finish(interaction, "**" .. draft.title .. "**\n" .. draft.description .. "\n\n**Roles included:** " .. #draft.roles .. "\n\nChange the selection or publish this menu.", {
      row({select}), row({button("rolepicker:publish:" .. draft_id, "Publish role menu", 1)})
    })
  end
  draft_id = custom:match("^rolepicker:publish:(.+)$")
  if draft_id then
    local draft = self.store.data.role_picker_drafts[draft_id]
    if not draft or draft.guild_id ~= guild or #(draft.roles or {}) == 0 then return self.interactions:finish(interaction, "Choose at least one role before publishing.", {}) end
    local all_roles = self.rest:get("/guilds/" .. guild .. "/roles") or {}
    local roles = {}
    for _, role_id in ipairs(draft.roles) do
      local role
      for _, candidate in ipairs(all_roles) do if candidate.id == role_id then role = candidate end end
      if not role then return self.interactions:finish(interaction, "One of the selected roles no longer exists. Reopen setup and select roles again.", {}) end
      local ok, message = self.verification:validate_role(guild, role_id, true)
      if not ok then return self.interactions:finish(interaction, message, {}) end
      roles[#roles + 1] = {id = role.id, name = role.name}
    end
    local menu_id = tostring(util.now_ms()) .. "-" .. tostring(interaction.id)
    local menu = {
      id = menu_id, guild_id = guild, channel_id = draft.channel_id, title = draft.title,
      description = draft.description, placeholder = draft.placeholder, footer_text = draft.footer_text,
      footer_channel_id = draft.footer_channel_id, roles = roles, selections = {}
    }
    local payload = self:public_payload(menu)
    local sent = self.rest:post("/channels/" .. menu.channel_id .. "/messages", payload)
    menu.message_id = sent.id
    self.store.data.role_picker_menus[menu_id] = menu
    self.store.data.role_picker_drafts[draft_id] = nil
    self.store:save()
    return self.interactions:finish(interaction, "Role picker menu published in <#" .. draft.channel_id .. ">. You can create another menu with /setup-role-picker.", {})
  end
  local menu_id = custom:match("^rolepicker:menu:(.+)$")
  if menu_id then
    local menu = self.store.data.role_picker_menus[menu_id]
    if not menu or menu.guild_id ~= guild then return self.interactions:finish(interaction, "This role picker is no longer available.", {}) end
    local selected, previous = ((interaction.data or {}).values or {}), (menu.selections[user] or {})
    local add, remove = {}, {}
    for _, role in ipairs(selected) do if not util.array_contains(previous, role) then add[#add + 1] = role end end
    for _, role in ipairs(previous) do if not util.array_contains(selected, role) then remove[#remove + 1] = role end end
    for _, role in ipairs(add) do
      local ok, err = pcall(function() self.rest:put("/guilds/" .. guild .. "/members/" .. user .. "/roles/" .. role, nil) end)
      if not ok then return self.interactions:finish(interaction, "Timi could not assign a selected role. Check Manage Roles and role hierarchy.", {}) end
    end
    for _, role in ipairs(remove) do
      local ok, err = pcall(function() self.rest:delete("/guilds/" .. guild .. "/members/" .. user .. "/roles/" .. role) end)
      if not ok then return self.interactions:finish(interaction, "Timi could not remove a deselected role. Check Manage Roles and role hierarchy.", {}) end
    end
    menu.selections[user] = selected
    self.store:save()
    return self.interactions:finish(interaction, #selected == 0 and "Your role selections have been cleared." or "Your role selections have been updated.", {})
  end
  return self.interactions:finish(interaction, "This role picker control is no longer available.", {})
end

function R:public_payload(menu)
  local options = {}
  for _, role in ipairs(menu.roles or {}) do options[#options + 1] = {label = role.name:sub(1, 100), value = role.id} end
  local components = {row({{type = 3, custom_id = "rolepicker:menu:" .. menu.id, placeholder = (menu.placeholder or "Choose roles"):sub(1, 150), min_values = 0, max_values = math.max(1, math.min(25, #options)), options = options}})}
  if menu.footer_text and menu.footer_text ~= "" and menu.footer_channel_id and menu.footer_channel_id ~= "" then
    components[#components + 1] = row({{type = 2, style = 5, label = menu.footer_text:sub(1, 80), url = "https://discord.com/channels/" .. menu.guild_id .. "/" .. menu.footer_channel_id}})
  end
  return {embeds = {{color = 8421504, title = menu.title, description = menu.description}}, components = components, allowed_mentions = {parse = {}}}
end

function R:modal(interaction, custom, fields)
  if custom ~= "rolepicker:details" then return self.interactions:finish(interaction, "This role picker form is no longer available.", {}) end
  local guild, user, channel = util.guild_id(interaction), util.user_id(interaction), util.channel_id(interaction)
  if not self:is_owner(guild, user) then return self.interactions:finish(interaction, "Only the server owner can configure role picker menus.", {}) end
  local title, description, placeholder = util.trim(fields["rp-title"]), util.trim(fields["rp-description"]), util.trim(fields["rp-placeholder"])
  local footer, footer_channel = util.trim(fields["rp-footer"]), util.trim(fields["rp-footer-channel"])
  if title == "" or description == "" or placeholder == "" then return self.interactions:finish(interaction, "Menu title, description, and placeholder are required.", {}) end
  if footer_channel ~= "" and not util.is_snowflake(footer_channel) then return self.interactions:finish(interaction, "The bottom button channel must be a valid channel ID.", {}) end
  local draft_id = guild .. ":" .. tostring(interaction.id)
  self.store.data.role_picker_drafts[draft_id] = {guild_id = guild, channel_id = channel, title = title, description = description, placeholder = placeholder, footer_text = footer, footer_channel_id = footer_channel, roles = {}}
  self.store:save()
  local roles = self.rest:get("/guilds/" .. guild .. "/roles") or {}
  local count = 0
  for _, role in ipairs(roles) do if role.id ~= guild and not role.managed then count = count + 1 end end
  return self.interactions:finish(interaction, "**" .. title .. "**\n" .. description .. "\n\nChoose which roles members can select. " .. count .. " assignable roles were found. Select up to 25.", {
    row({{type = 6, custom_id = "rolepicker:setup-roles:" .. draft_id, placeholder = "Choose the roles members can pick", min_values = 1, max_values = 25}})
  })
end

return R

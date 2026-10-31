local util = require("timi.util")
local Tickets = require("timi.tickets")
local Moderation = require("timi.moderation")
local Verification = require("timi.verification")
local RolePicker = require("timi.role_picker")
local Embeds = require("timi.embeds")

local Commands = {}
Commands.__index = Commands
local MANAGE_GUILD = "32"

local definitions = {
  {name = "ticket-setup", description = "Create Timi private channels and the ticket category.", default_member_permissions = MANAGE_GUILD},
  {name = "ticket-panel", description = "Create and publish a customizable ticket panel.", default_member_permissions = MANAGE_GUILD},
  {name = "ticket-settings", description = "Edit the settings of your existing ticket panel.", default_member_permissions = MANAGE_GUILD},
  {name = "moderation-settings", description = "Configure Timi moderation and anti-spam protection.", default_member_permissions = MANAGE_GUILD},
  {name = "verify-settings", description = "Configure risk-based verification (server owner only).", options = {
    {type = 8, name = "role", description = "Role granted after passing", required = false},
    {type = 8, name = "required-role", description = "Role required before verifying", required = false},
    {type = 5, name = "clear-required-role", description = "Remove the required-role restriction", required = false},
    {type = 4, name = "min-age-days", description = "Minimum account age in days", min_value = 0, max_value = 3650, required = false},
    {type = 7, name = "review-channel", description = "Channel for manual review", channel_types = {0}, required = false},
    {type = 3, name = "title", description = "Verification panel title", max_length = 200, required = false},
    {type = 3, name = "description", description = "Verification panel description", max_length = 1000, required = false}
  }},
  {name = "verify-panel", description = "Publish the Timi risk-based verification panel."},
  {name = "setup-role-picker", description = "Create a self-service role picker menu (server owner only)."},
  {name = "create-embed", description = "Create and customize a reusable server embed.", default_member_permissions = MANAGE_GUILD},
  {name = "place-embed", description = "Place a saved embed in this channel.", default_member_permissions = MANAGE_GUILD, options = {
    {type = 3, name = "name", description = "Name of the saved embed", required = true, max_length = 24}
  }},
  {name = "edit-embed", description = "Open the editor for a saved embed.", default_member_permissions = MANAGE_GUILD, options = {
    {type = 3, name = "name", description = "Name of the saved embed", required = true, max_length = 24}
  }}
}

function Commands.new(rest, store, interactions, config)
  local self = setmetatable({rest = rest, store = store, interactions = interactions, config = config}, Commands)
  self.tickets = Tickets.new(rest, store, interactions)
  self.moderation = Moderation.new(rest, store, interactions)
  self.verification = Verification.new(rest, store, interactions)
  self.role_picker = RolePicker.new(rest, store, interactions, self.verification)
  self.embeds = Embeds.new(rest, store, interactions)
  return self
end

function Commands:register()
  local path
  if self.config.guild_id then
    path = "/applications/" .. self.config.client_id .. "/guilds/" .. self.config.guild_id .. "/commands"
  else
    path = "/applications/" .. self.config.client_id .. "/commands"
  end
  self.rest:put(path, definitions)
  util.log("info", "Registered " .. #definitions .. " Discord slash commands")
end

function Commands:is_modal_opener(interaction, custom)
  local manager = util.has_permission(interaction, 32)
  if custom == "rolepicker:start" then return true end
  if manager then
    local modal_ids = {
      ["ticket:wizard-start"] = true, ["ticket:wizard-continue"] = true,
      ["ticket:edit-panel"] = true, ["ticket:edit-ticket"] = true,
      ["ticket:edit-category"] = true, ["ticket:edit-access"] = true,
      ["modpanel:sanction"] = true, ["modpanel:duration"] = true, ["modpanel:max-count"] = true
    }
    if modal_ids[custom] then return true end
    local action, name = custom:match("^embed:([^:]+):(.+)$")
    if action and self.store:embed(util.guild_id(interaction), name) and
      (action == "content" or action == "style" or action == "media" or action == "add-field" or action == "remove-field") then
      return true
    end
  end
  return false
end

function Commands:handle(interaction)
  local kind = tonumber(interaction.type)
  if kind == 2 then
    local name = ((interaction.data or {}).name or "")
    if not (name == "create-embed" and util.has_permission(interaction, 32)) then
      self.interactions:defer(interaction)
    end
    if not interaction.guild_id then return self.interactions:finish(interaction, "This command can only be used in a server.", {}) end
    if name == "ticket-setup" or name == "ticket-panel" or name == "ticket-settings" then
      return self.tickets:command(interaction, name)
    elseif name == "moderation-settings" then
      return self.moderation:command(interaction)
    elseif name == "verify-settings" or name == "verify-panel" then
      return self.verification:command(interaction, name)
    elseif name == "setup-role-picker" then
      return self.role_picker:command(interaction)
    elseif name == "create-embed" or name == "edit-embed" or name == "place-embed" then
      return self.embeds:command(interaction, name)
    end
    return self.interactions:finish(interaction, "Unknown command.", {})
  elseif kind == 3 then
    local custom = ((interaction.data or {}).custom_id or "")
    if not self:is_modal_opener(interaction, custom) then self.interactions:defer(interaction) end
    if custom:match("^ticket:") then return self.tickets:component(interaction, custom)
    elseif custom:match("^modpanel:") then return self.moderation:component(interaction, custom)
    elseif custom:match("^verify:") then return self.verification:component(interaction, custom)
    elseif custom:match("^botguard:") then return self.verification:bot_component(interaction, custom)
    elseif custom:match("^rolepicker:") then return self.role_picker:component(interaction, custom)
    elseif custom:match("^embed:") then return self.embeds:component(interaction, custom) end
    return self.interactions:finish(interaction, "This interaction is no longer available.", {})
  elseif kind == 5 then
    self.interactions:defer(interaction)
    local custom = ((interaction.data or {}).custom_id or "")
    local fields = util.walk_components((interaction.data or {}).components)
    if custom:match("^ticket:") then return self.tickets:modal(interaction, custom, fields)
    elseif custom:match("^modpanel:") then return self.moderation:modal(interaction, custom, fields)
    elseif custom:match("^rolepicker:") then return self.role_picker:modal(interaction, custom, fields)
    elseif custom:match("^embed:") then return self.embeds:modal(interaction, custom, fields) end
    return self.interactions:finish(interaction, "This form is no longer available.", {})
  end
end

return Commands

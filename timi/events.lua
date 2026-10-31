local util = require("timi.util")
local Protection = require("timi.protection")
local Recovery = require("timi.recovery")

local Events = {}
Events.__index = Events

function Events.new(rest, store, interactions, commands, config)
  return setmetatable({
    rest = rest, store = store, interactions = interactions, commands = commands, config = config,
    protection = Protection.new(rest, store), recovery = Recovery.new(rest, store)
  }, Events)
end

function Events:ready(data)
  util.log("info", "Timi gateway session is ready")
  for _, guild in ipairs(data.guilds or {}) do
    local ok, err = pcall(function()
      self.protection:ensure_private(guild.id, "timi")
      local channels = self.rest:get("/guilds/" .. guild.id .. "/channels") or {}
      for _, channel in ipairs(channels) do self.recovery:snapshot(channel) end
    end)
    if not ok then util.log("warn", "Could not initialize guild " .. tostring(guild.id) .. ": " .. tostring(err)) end
  end
end

function Events:guild_create(data)
  local guild = data.id
  if not guild then return end
  local ok, err = pcall(function()
    self.protection:ensure_private(guild, "timi")
    local channels = self.rest:get("/guilds/" .. guild .. "/channels") or {}
    for _, channel in ipairs(channels) do self.recovery:snapshot(channel) end
  end)
  if not ok then util.log("warn", "Guild initialization failed for " .. guild .. ": " .. tostring(err)) end
end

function Events:member_remove(data)
  if not data.guild_id or not data.user or not data.user.id then return end
  local record = self.store:member(data.guild_id, data.user.id)
  record.leaves = (record.leaves or 0) + 1
  self.store:save()
end

function Events:handlers()
  return {
    READY = function(data) self:ready(data) end,
    GUILD_CREATE = function(data) self:guild_create(data) end,
    INTERACTION_CREATE = function(data)
      util.spawn(function()
        local ok, err = pcall(function() self.commands:handle(data) end)
        if not ok then
          util.log("error", "Interaction " .. tostring(data.id) .. " failed: " .. tostring(err))
          self.interactions:clear(data)
        end
      end)
    end,
    MESSAGE_CREATE = function(data)
      util.spawn(function()
        local ok, err = pcall(function() self.recovery:backup_message(data) end)
        if not ok then util.log("error", "Message archive failed: " .. tostring(err)) end
        local mod_ok, mod_err = pcall(function() self.commands.moderation:message(data) end)
        if not mod_ok then util.log("error", "Message moderation failed: " .. tostring(mod_err)) end
      end)
    end,
    GUILD_MEMBER_ADD = function(data)
      util.spawn(function()
        local ok, err = pcall(function() self.protection:member_join(data) end)
        if not ok then util.log("error", "Member join protection failed: " .. tostring(err)) end
      end)
    end,
    GUILD_MEMBER_REMOVE = function(data) self:member_remove(data) end,
    CHANNEL_CREATE = function(data) util.spawn(function() self.recovery:snapshot(data) end) end,
    CHANNEL_UPDATE = function(data) util.spawn(function() self.recovery:snapshot(data) end) end,
    CHANNEL_DELETE = function(data)
      util.spawn(function()
        local ok, err = pcall(function() self.recovery:channel_delete(data) end)
        if not ok then util.log("error", "Channel recovery failed: " .. tostring(err)) end
      end)
    end
  }
end

return Events

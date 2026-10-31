local util = require("../timi/util")

local Interactions = {}
Interactions.__index = Interactions

function Interactions.new(rest, config)
  return setmetatable({rest = rest, config = config, callbacks = {}, working = {}}, Interactions)
end

function Interactions:callback(interaction, kind, data)
  local id = tostring(interaction.id)
  if self.callbacks[id] then error("Duplicate Discord interaction acknowledgement prevented: " .. id) end
  self.callbacks[id] = true
  local payload = {type = kind}
  if data then payload.data = data end
  self.rest:request("POST", "/interactions/" .. id .. "/" .. interaction.token .. "/callback", payload, true)
end

function Interactions:edit(interaction, payload)
  local url = "/webhooks/" .. self.config.client_id .. "/" .. interaction.token .. "/messages/@original"
  return self.rest:request("PATCH", url, payload, true)
end

function Interactions:defer(interaction)
  local id = tostring(interaction.id)
  if not self.callbacks[id] then self:callback(interaction, 5, {flags = 64}) end
  local token = interaction.token
  if not self.working[token] then
    self.working[token] = util.monotonic_ms()
    self:edit(interaction, {content = "Working…"})
  end
end

function Interactions:show_modal(interaction, data)
  self:callback(interaction, 9, data)
  self.callbacks[tostring(interaction.id)] = nil
end

function Interactions:finish(interaction, content, components, extra)
  if not self.callbacks[tostring(interaction.id)] then self:defer(interaction) end
  local token = interaction.token
  local started = self.working[token]
  if started then
    local remaining = 5000 - (util.monotonic_ms() - started)
    if remaining > 0 then util.sleep(remaining) end
  end
  local payload = extra or {}
  if content ~= nil then payload.content = content end
  if components ~= nil then payload.components = components end
  local result = self:edit(interaction, payload)
  self.working[token] = nil
  self.callbacks[tostring(interaction.id)] = nil
  return result
end

function Interactions:clear(interaction)
  self.callbacks[tostring(interaction.id)] = nil
  self.working[interaction.token] = nil
end

return Interactions

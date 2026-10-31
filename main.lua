local package_path = "./?.lua;./?/init.lua;./deps/?.lua;./deps/?/init.lua;"
package.path = package_path .. package.path

-- Lit installs third-party modules into ./deps. Add that directory before
-- loading application modules so require("fs"), require("json"), etc. resolve.
local config_module = require("timi.config")
local Store = require("timi.store")
local Rest = require("discord.rest")
local Interactions = require("discord.interactions")
local Gateway = require("discord.gateway")
local util = require("timi.util")
local Commands = require("timi.commands")
local Events = require("timi.events")

local function boot()
  math.randomseed(os.time())
  local config = config_module.load()
  local store = Store.new(config)
  local rest = Rest.new(config)
  local interactions = Interactions.new(rest, config)
  local commands = Commands.new(rest, store, interactions, config)
  local events = Events.new(rest, store, interactions, commands, config)
  commands:register()
  local gateway = Gateway.new(rest, config, events:handlers())
  util.log("info", "Starting Timi Lua runtime")
  gateway:start()
end

util.spawn(function()
  local ok, err = xpcall(boot, debug.traceback)
  if not ok then
    util.log("error", "Timi could not start: " .. tostring(err))
    os.exit(1)
  end
end)

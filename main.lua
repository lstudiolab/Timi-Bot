-- Luvi can execute this entry point with LuaJIT's standard require loader.
-- Lit installs dependencies under ./deps, so include both single-file packages
-- (deps/name.lua) and directory packages (deps/name/init.lua) before imports.
local dependency_paths = "./deps/?.lua;./deps/?/init.lua;"
if not package.path:find("./deps/?.lua", 1, true) then
  package.path = dependency_paths .. package.path
end

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

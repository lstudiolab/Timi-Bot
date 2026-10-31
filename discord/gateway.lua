local websocket = require("coro-websocket")
local json = require("json")
local uv = require("uv")
local util = require("timi.util")

local Gateway = {}
Gateway.__index = Gateway

local function send(write, value)
  local ok, err = write({opcode = 1, payload = json.stringify(value)})
  if not ok and err then error(err or "Gateway websocket write failed") end
end

local function parse_gateway_url(value)
  local host, path = value:match("^wss://([^/]+)(/.*)$")
  if not host then host = value:match("^wss://([^/]+)$"); path = "/" end
  path = path or "/"
  if not path:find("?", 1, true) then path = path .. "?v=10&encoding=json"
  else path = path .. "&v=10&encoding=json" end
  return host, path
end

function Gateway.new(rest, config, handlers)
  return setmetatable({rest = rest, config = config, handlers = handlers, sequence = nil, session_id = nil, resume_url = nil, stopping = false}, Gateway)
end

function Gateway:dispatch(name, data)
  local callback = self.handlers[name]
  if callback then
    util.spawn(function()
      local ok, err = pcall(callback, data)
      if not ok then util.log("error", name .. " event failed: " .. tostring(err)) end
    end)
  end
end

function Gateway:connect_once()
  local gateway_url
  if self.session_id and self.resume_url then gateway_url = self.resume_url
  else
    local response = self.rest:get("/gateway/bot")
    gateway_url = response and response.url
  end
  if not gateway_url then error("Discord did not return a gateway URL") end
  local host, pathname = parse_gateway_url(gateway_url)
  local response, read, write = websocket.connect({host = host, port = 443, tls = true, pathname = pathname, timeout = 15000})
  if not response or response.code ~= 101 then error("Discord gateway websocket handshake failed") end
  util.log("info", "Connected to Discord Gateway")

  local heartbeat_timer, reconnect = nil, false
  local heartbeat_interval, awaiting_ack, identify_sent = nil, false, false
  local function stop_timer()
    if heartbeat_timer and not heartbeat_timer:is_closing() then heartbeat_timer:stop(); heartbeat_timer:close() end
    heartbeat_timer = nil
  end
  local function heartbeat(force)
    if awaiting_ack and not force then reconnect = true; return end
    awaiting_ack = true
    send(write, {op = 1, d = self.sequence})
  end

  while not self.stopping and not reconnect do
    local message = read()
    if not message or message.opcode == 8 then break end
    if message.opcode == 1 then
      local packet = json.parse(message.payload)
      if packet.s ~= nil then self.sequence = packet.s end
      if packet.op == 10 then
        heartbeat_interval = tonumber(packet.d.heartbeat_interval)
        if not identify_sent then
          if self.session_id and self.resume_url == gateway_url then
            send(write, {op = 6, d = {token = self.config.token, session_id = self.session_id, seq = self.sequence}})
          else
            send(write, {op = 2, d = {
              token = self.config.token, intents = 33283,
              properties = {["$os"] = "linux", ["$browser"] = "timi-lua", ["$device"] = "timi-lua"}
            }})
          end
          identify_sent = true
        end
        heartbeat_timer = uv.new_timer()
        local first = math.random(0, math.max(1, heartbeat_interval))
        heartbeat_timer:start(first, heartbeat_interval, function()
          coroutine.wrap(function()
            local ok, err = pcall(heartbeat, false)
            if not ok then util.log("warn", "Gateway heartbeat failed: " .. tostring(err)); reconnect = true end
          end)()
        end)
      elseif packet.op == 11 then
        awaiting_ack = false
      elseif packet.op == 1 then
        heartbeat(true)
      elseif packet.op == 7 then
        reconnect = true
      elseif packet.op == 9 then
        if not packet.d then self.session_id, self.resume_url, self.sequence = nil, nil, nil end
        reconnect = true
        stop_timer()
        util.sleep(math.random(1000, 5000))
      elseif packet.op == 0 then
        local name, data = packet.t, packet.d
        if name == "READY" then
          self.session_id, self.resume_url = data.session_id, data.resume_gateway_url
          util.log("info", "Timi is online as " .. ((data.user or {}).username or "unknown"))
        elseif name == "RESUMED" then
          util.log("info", "Discord Gateway session resumed")
        end
        if name then self:dispatch(name, data) end
      end
    end
    -- WebSocket control frames, including ping/pong, are handled by coro-websocket.
  end
  stop_timer()
  pcall(write, {opcode = 8, payload = ""})
  return reconnect
end

function Gateway:start()
  local delay = 1000
  while not self.stopping do
    local ok, reconnect = pcall(function() return self:connect_once() end)
    if not ok then
      util.log("error", "Gateway disconnected: " .. tostring(reconnect))
      delay = math.min(delay * 2, 30000)
    else
      delay = reconnect and 1000 or math.min(delay * 2, 30000)
    end
    if not self.stopping then util.sleep(delay) end
  end
end

function Gateway:stop() self.stopping = true end
return Gateway

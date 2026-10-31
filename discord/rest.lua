local http = require("coro-http")
local json = require("json")
local util = require("../timi/util")

local Rest = {}
Rest.__index = Rest

local retryable = {GET = true, PUT = true, PATCH = true, DELETE = true}

local function header_value(response, key)
  for _, item in ipairs(response or {}) do
    if string.lower(item[1] or "") == string.lower(key) then return item[2] end
  end
end

local function decode(body)
  if not body or body == "" then return nil end
  local ok, value = pcall(json.parse, body)
  if ok then return value end
  return body
end

function Rest.new(config)
  return setmetatable({config = config}, Rest)
end

function Rest:request(method, path, payload, webhook)
  method = string.upper(method)
  local url
  if path:match("^https?://") then url = path
  else url = self.config.api_base .. path end
  local body = payload and json.stringify(payload) or nil
  local headers = {{"user-agent", "TimiBot/3.0"}, {"accept", "application/json"}}
  if not webhook then headers[#headers + 1] = {"authorization", "Bot " .. self.config.token} end
  if body then headers[#headers + 1] = {"content-type", "application/json"} end

  local max_attempts = retryable[method] and 5 or 1
  for attempt = 1, max_attempts do
    local response, raw = http.request(method, url, headers, body)
    if not response then error("HTTP request failed for " .. path) end
    local status = tonumber(response.code) or 0
    if status == 429 and retryable[method] and attempt < max_attempts then
      local data = decode(raw) or {}
      local delay = tonumber(data.retry_after) or tonumber(header_value(response, "retry-after")) or 1
      delay = math.max(0.25, math.min(delay, 30))
      util.log("warn", "Discord rate limit at " .. path .. "; retrying after " .. delay .. " seconds")
      util.sleep(math.floor(delay * 1000))
    elseif status >= 500 and status <= 599 and retryable[method] and attempt < math.min(max_attempts, 4) then
      util.log("warn", "Discord returned HTTP " .. status .. " at " .. path .. "; retrying")
      util.sleep(500 * (2 ^ (attempt - 1)))
    elseif (status >= 200 and status < 300) or status == 204 then
      return decode(raw)
    else
      local detail = tostring(raw or ""):sub(1, 600)
      error("Discord API HTTP " .. status .. " at " .. path .. ": " .. detail)
    end
  end
  error("Discord API retries exhausted at " .. path)
end

function Rest:get(path) return self:request("GET", path) end
function Rest:post(path, body) return self:request("POST", path, body) end
function Rest:put(path, body) return self:request("PUT", path, body) end
function Rest:patch(path, body) return self:request("PATCH", path, body) end
function Rest:delete(path) return self:request("DELETE", path) end

return Rest

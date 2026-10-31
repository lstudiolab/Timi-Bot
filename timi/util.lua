local M = {}

function M.now_ms() return math.floor(os.time() * 1000) end
function M.monotonic_ms() return math.floor(require("uv").hrtime() / 1000000) end

function M.sleep(ms)
  local uv, co = require("uv"), coroutine.running()
  assert(co, "sleep must run inside a coroutine")
  local timer = uv.new_timer()
  timer:start(ms, 0, function()
    timer:stop(); timer:close()
    local ok, err = coroutine.resume(co)
    if not ok then io.stderr:write("Timi coroutine error: " .. tostring(err) .. "\n") end
  end)
  return coroutine.yield()
end

function M.spawn(fn, ...)
  local args = {...}
  local co = coroutine.create(function() fn(unpack(args)) end)
  local ok, err = coroutine.resume(co)
  if not ok then io.stderr:write("Timi task failed: " .. tostring(err) .. "\n") end
  return co
end

function M.log(level, message)
  local levels = {debug = 1, info = 2, warn = 3, error = 4}
  local configured = (process and process.env and process.env.LOG_LEVEL) or os.getenv("LOG_LEVEL") or "info"
  if (levels[level] or 2) < (levels[configured] or 2) then return end
  io.stdout:write(os.date("!%Y-%m-%dT%H:%M:%SZ") .. " [" .. string.upper(level) .. "] " .. tostring(message) .. "\n")
end

function M.trim(value) return tostring(value or ""):match("^%s*(.-)%s*$") end
function M.is_snowflake(value)
  value = tostring(value or "")
  return #value >= 15 and #value <= 22 and value:match("^%d+$") ~= nil
end
function M.snowflake_time(id)
  local n = tonumber(id)
  if not n then return M.now_ms() end
  return math.floor(n / 4194304) + 1420070400000
end
function M.copy(value, seen)
  if type(value) ~= "table" then return value end
  seen = seen or {}; if seen[value] then return seen[value] end
  local result = {}; seen[value] = result
  for k, v in pairs(value) do result[M.copy(k, seen)] = M.copy(v, seen) end
  return result
end
function M.array_contains(array, value)
  for _, item in ipairs(array or {}) do if item == value then return true end end
  return false
end
function M.split_words(value)
  local out = {}; for word in tostring(value or ""):gmatch("%S+") do out[#out + 1] = word end
  return out
end
function M.jaccard(a, b)
  local left, right = {}, {}
  for _, word in ipairs(M.split_words(a)) do left[word] = true end
  for _, word in ipairs(M.split_words(b)) do right[word] = true end
  local intersection, union = 0, 0
  for word in pairs(left) do union = union + 1; if right[word] then intersection = intersection + 1 end end
  for word in pairs(right) do if not left[word] then union = union + 1 end end
  if union == 0 then return 0 end
  return intersection / union
end
function M.normalize_message(value)
  value = string.lower(tostring(value or ""))
  value = value:gsub("https?://%S+", " url ")
  value = value:gsub("<@!?%d+>", " mention ")
  value = value:gsub("<@&%d+>", " mention ")
  value = value:gsub("<#%d+>", " mention ")
  value = value:gsub("[%p%c]", " "):gsub("%s+", " ")
  return M.trim(value)
end
function M.user_id(interaction) return (((interaction.member or {}).user or interaction.user or {}).id) or "" end
function M.guild_id(interaction) return tostring(interaction.guild_id or "") end
function M.channel_id(interaction) return tostring(interaction.channel_id or "") end
function M.has_permission(interaction, permission)
  local value = tonumber((interaction.member or {}).permissions or "0") or 0
  local function has(flag) return math.floor(value / flag) % 2 == 1 end
  return has(tonumber(permission) or 1) or has(8)
end
function M.option(options, name)
  for _, item in ipairs(options or {}) do if item.name == name then return item.value end end
  return nil
end
function M.walk_components(components, out)
  out = out or {}
  for _, component in ipairs(components or {}) do
    if component.custom_id and component.value ~= nil then out[component.custom_id] = tostring(component.value) end
    M.walk_components(component.components, out)
  end
  return out
end
function M.button(custom_id, label, style) return {type = 2, style = style or 2, custom_id = custom_id, label = label} end
function M.row(components) return {type = 1, components = components} end
function M.text_input(custom_id, label, value, paragraph, max_length, required)
  local item = {type = 4, custom_id = custom_id, label = label, style = paragraph and 2 or 1, required = required ~= false, max_length = max_length or 1000}
  if value ~= nil and value ~= "" then item.value = tostring(value):sub(1, item.max_length) end
  return item
end
function M.modal(custom_id, title, inputs)
  local rows = {}; for _, item in ipairs(inputs or {}) do rows[#rows + 1] = M.row({item}) end
  return {custom_id = custom_id, title = title, components = rows}
end
function M.mention_channel(id)
  if not id or id == "" then return "Not configured" end
  return "<#" .. id .. ">"
end
function M.mention_role(id)
  if not id or id == "" then return "Not configured" end
  return "<@&" .. id .. ">"
end
function M.clean_channel_name(value)
  local name = string.lower(tostring(value or "ticket"))
  name = name:gsub("[^a-z0-9%-]", "-"):gsub("%-+", "-"):gsub("^%-+", ""):gsub("%-+$", "")
  if name == "" then name = "ticket" end
  return name:sub(1, 90)
end

return M

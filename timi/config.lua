local fs = require("fs")
local util = require("./util")

local M = {}

local function read_env(path)
  local values = {}
  local file, err = io.open(path or ".env", "r")
  if not file then
    return values, err
  end

  for line in file:lines() do
    -- Handle UTF-8 BOM on the first line and Windows CRLF files.
    line = line:gsub("^\239\187\191", "")
    line = util.trim(line)

    if line ~= "" and not line:match("^#") then
      line = line:gsub("^export%s+", "")
      local key, value = line:match("^([%w_]+)%s*=%s*(.*)$")
      if key then
        value = util.trim(value)

        -- Remove comments only when they are outside a quoted value.
        local quote = value:sub(1, 1)
        if quote == "\"" or quote == "'" then
          local closing = value:find(quote, 2, true)
          if closing then
            value = value:sub(2, closing - 1)
          else
            value = value:sub(2)
          end
        else
          value = value:gsub("%s+#.*$", "")
          value = util.trim(value)
        end

        values[key] = value
      end
    end
  end

  file:close()
  return values
end

local function get_env(name, file_values)
  -- A real process environment variable takes precedence over the .env file.
  local value
  if process and process.env then
    value = process.env[name]
  end
  if value == nil or value == "" then
    value = os.getenv(name)
  end
  if value == nil or value == "" then
    value = file_values[name]
  end
  return value
end

function M.load()
  local file_values, file_error = read_env(".env")
  local token = get_env("DISCORD_TOKEN", file_values)
  local client_id = get_env("CLIENT_ID", file_values)
  local guild_id = get_env("GUILD_ID", file_values)
  local data_dir = get_env("DATA_DIR", file_values) or "data"

  if not token or token == "" or token == "your_discord_bot_token" then
    local detail = file_error and (" (.env could not be read: " .. tostring(file_error) .. ")") or ""
    error("DISCORD_TOKEN is missing or empty in .env" .. detail)
  end
  if not client_id or not util.is_snowflake(client_id) then
    error("CLIENT_ID must be a valid Discord application ID in .env")
  end
  if guild_id == "" then guild_id = nil end
  if guild_id and not util.is_snowflake(guild_id) then
    error("GUILD_ID must be numeric")
  end

  if not fs.existsSync(data_dir) then
    fs.mkdirSync(data_dir)
  end

  return {
    token = token,
    client_id = client_id,
    guild_id = guild_id,
    data_dir = data_dir,
    api_base = "https://discord.com/api/v10"
  }
end

return M

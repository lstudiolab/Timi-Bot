local fs = require("fs")
local util = require("timi.util")

local M = {}

local function load_env(path)
  local file = io.open(path or ".env", "r")
  if not file then return end
  for line in file:lines() do
    line = util.trim(line)
    if line ~= "" and not line:match("^#") then
      local key, value = line:match("^([%w_]+)%s*=%s*(.*)$")
      if key and os.getenv(key) == nil then
        value = value:gsub("^['\"]", ""):gsub("['\"]$", "")
        -- Luvit exposes process.env; os.setenv is not available on all builds.
        if process and process.env then process.env[key] = value end
      end
    end
  end
  file:close()
end

function M.load()
  load_env(".env")
  local token = (process and process.env and process.env.DISCORD_TOKEN) or os.getenv("DISCORD_TOKEN")
  local client_id = (process and process.env and process.env.CLIENT_ID) or os.getenv("CLIENT_ID")
  local guild_id = (process and process.env and process.env.GUILD_ID) or os.getenv("GUILD_ID")
  local data_dir = (process and process.env and process.env.DATA_DIR) or os.getenv("DATA_DIR") or "data"
  if not token or token == "" or token == "your_discord_bot_token" then
    error("DISCORD_TOKEN is missing from .env")
  end
  if not client_id or not util.is_snowflake(client_id) then
    error("CLIENT_ID must be a valid Discord application ID in .env")
  end
  if guild_id == "" then guild_id = nil end
  if guild_id and not util.is_snowflake(guild_id) then error("GUILD_ID must be numeric") end
  if not fs.existsSync(data_dir) then fs.mkdirSync(data_dir) end
  return {
    token = token,
    client_id = client_id,
    guild_id = guild_id,
    data_dir = data_dir,
    api_base = "https://discord.com/api/v10"
  }
end

return M

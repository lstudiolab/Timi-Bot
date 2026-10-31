local util = require("timi.util")
local P = {}
P.__index = P
local DAY = 86400000
local VIEW, SEND, HISTORY, EMBED, MANAGE_MESSAGES = 1024, 2048, 65536, 16384, 8192

function P.new(rest, store)
  return setmetatable({rest = rest, store = store, bursts = {}, last_raid_alert = {}}, P)
end
function P:find_channel(guild, name)
  for _, channel in ipairs(self.rest:get("/guilds/" .. guild .. "/channels") or {}) do if channel.type == 0 and channel.name == name then return channel.id end end
end
function P:ensure_private(guild, name)
  local info, me = self.rest:get("/guilds/" .. guild), self.rest:get("/users/@me")
  local roles = self.rest:get("/guilds/" .. guild .. "/roles") or {}
  local overwrites = {{id = guild, type = 0, allow = "0", deny = tostring(VIEW)}}
  for _, role in ipairs(roles) do
    if role.id ~= guild then
      if #overwrites >= 98 then error("This server has too many roles to safely create a private Timi security channel") end
      overwrites[#overwrites + 1] = {id = role.id, type = 0, allow = "0", deny = tostring(VIEW)}
    end
  end
  overwrites[#overwrites + 1] = {id = info.owner_id, type = 1, allow = tostring(VIEW + SEND + HISTORY), deny = "0"}
  overwrites[#overwrites + 1] = {id = me.id, type = 1, allow = tostring(VIEW + SEND + HISTORY + EMBED + MANAGE_MESSAGES), deny = "0"}
  local topic = "Private Timi security alerts and bot approval requests. Only the server owner and Timi can view this channel."
  local existing = self:find_channel(guild, name)
  if existing then
    self.rest:patch("/channels/" .. existing, {topic = topic, permission_overwrites = overwrites})
    return existing
  end
  local created = self.rest:post("/guilds/" .. guild .. "/channels", {name = name, type = 0, topic = topic, permission_overwrites = overwrites, reason = "Create private owner-only Timi security channel"})
  return created.id
end
function P:bot_join(guild, bot, name)
  local log = self:ensure_private(guild, "timi")
  for _, channel in ipairs(self.rest:get("/guilds/" .. guild .. "/channels") or {}) do
    if channel.id ~= log then
      pcall(function() self.rest:put("/channels/" .. channel.id .. "/permissions/" .. bot, {type = 1, allow = "0", deny = tostring(VIEW + SEND + HISTORY + 2^20 + 2^21)}) end)
    end
  end
  local sent = self.rest:post("/channels/" .. log .. "/messages", {
    embeds = {{color = 8421504, title = "Bot approval required", description = "Do you agree on giving this bot permission to serve this server?\n\nBot: <@" .. bot .. "> (" .. name .. ")\nAccess: this bot is temporarily restricted while approval is pending."}},
    components = {util.row({util.button("botguard:yes:" .. guild .. ":" .. bot, "Yes", 3), util.button("botguard:no:" .. guild .. ":" .. bot, "No", 4)})}
  })
  self.store.data.pending_bots = self.store.data.pending_bots or {}
  self.store.data.pending_bots[guild .. ":" .. bot] = sent.id
  self.store:save()
end
function P:member_join(member)
  local guild, user = member.guild_id, (member.user or {}).id
  if not guild or not user then return end
  local record = self.store:member(guild, user)
  record.joins, record.last_join = (record.joins or 0) + 1, util.now_ms()
  self.store:save()
  if (member.user or {}).bot then return self:bot_join(guild, user, member.user.username or member.user.global_name or "bot") end
  local info = self.rest:get("/guilds/" .. guild)
  if info.owner_id == user then return end
  local age = util.now_ms() - util.snowflake_time(user)
  if age < 7 * DAY then
    local log = self:ensure_private(guild, "timi")
    local action = "flagged for moderator review"
    if age < 3 * DAY then
      local until_time = os.date("!%Y-%m-%dT%H:%M:%SZ", os.time() + 600)
      local ok = pcall(function() self.rest:patch("/guilds/" .. guild .. "/members/" .. user, {communication_disabled_until = until_time, reason = "Timi new-account safety timeout"}) end)
      action = ok and "temporarily timed out for 10 minutes" or "flagged; timeout could not be applied"
    end
    self.rest:post("/channels/" .. log .. "/messages", {content = "New-account alert: <@" .. user .. "> joined with an account " .. tostring(math.floor(age / DAY)) .. " day(s) old. Action: " .. action .. ".", allowed_mentions = {parse = {}}})
  end
  local now, list = util.monotonic_ms(), self.bursts[guild] or {}
  self.bursts[guild] = list; list[#list + 1] = now
  local kept = {}
  for _, stamp in ipairs(list) do if now - stamp <= 10000 then kept[#kept + 1] = stamp end end
  self.bursts[guild] = kept
  if #kept >= 6 and now - (self.last_raid_alert[guild] or 0) >= 60000 then
    self.last_raid_alert[guild] = now
    local log = self:ensure_private(guild, "timi")
    self.rest:post("/channels/" .. log .. "/messages", {content = "Security alert: " .. #kept .. " members joined within 10 seconds. Possible raid; review the server. No automatic raid punishment was applied.", allowed_mentions = {parse = {}}})
  end
end
return P

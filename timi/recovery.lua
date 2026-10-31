local util = require("./util")
local R = {}
R.__index = R
local WEEK, MAX_MESSAGES = 7 * 86400000, 25000
local MODERATE, MANAGE_ROLES = 2^40, 2^28
local function has_bit(value, flag) return math.floor(value / flag) % 2 == 1 end

function R.new(rest, store) return setmetatable({rest = rest, store = store, deleted = {}}, R) end
function R:snapshot(channel)
  if not channel.guild_id or not channel.id then return end
  local ok, result = pcall(function() return self.rest:get("/channels/" .. channel.id) end)
  if not ok or not result then return end
  self.store.data.channels[channel.guild_id .. ":" .. channel.id] = result
  self.store:queue_save()
end
function R:backup_message(message)
  if not message.guild_id or (message.author or {}).bot then return end
  if (message.content or "") == "" and #(message.attachments or {}) == 0 then return end
  local guild = message.guild_id
  local list = self.store.data.messages[guild] or {}; self.store.data.messages[guild] = list
  local item = {id = message.id, channel_id = message.channel_id, author_id = message.author.id,
    author_tag = message.author.username, content = tostring(message.content or ""):sub(1, 4000),
    timestamp_ms = util.snowflake_time(message.id), attachments = {}}
  for index, attachment in ipairs(message.attachments or {}) do
    if index > 10 then break end
    item.attachments[#item.attachments + 1] = {name = attachment.filename, url = attachment.url, content_type = attachment.content_type, size = attachment.size}
  end
  list[#list + 1] = item
  local kept = {}
  for _, old in ipairs(list) do if item.timestamp_ms - (old.timestamp_ms or item.timestamp_ms) <= WEEK then kept[#kept + 1] = old end end
  while #kept > MAX_MESSAGES do table.remove(kept, 1) end
  self.store.data.messages[guild] = kept
  self.store:queue_save()
end
function R:find_channel(guild)
  for _, channel in ipairs(self.rest:get("/guilds/" .. guild .. "/channels") or {}) do if channel.type == 0 and channel.name == "timi" then return channel.id end end
end
function R:channel_delete(channel)
  local guild, id = channel.guild_id, channel.id
  util.sleep(1200)
  local audit = self.rest:get("/guilds/" .. guild .. "/audit-logs?limit=8&action_type=12")
  local actor
  for _, entry in ipairs((audit or {}).audit_log_entries or {}) do if entry.target_id == id then actor = entry.user_id end end
  if not actor then return end
  local info, me = self.rest:get("/guilds/" .. guild), self.rest:get("/users/@me")
  if actor == info.owner_id or actor == me.id then return end
  local key, now = guild .. ":" .. actor, util.monotonic_ms()
  local entries, ids = self.deleted[guild .. ":" .. actor] or {}, {}
  entries[#entries + 1] = {at = now, id = id}
  local kept = {}
  for _, item in ipairs(entries) do if now - item.at <= 60000 then kept[#kept + 1] = item; ids[#ids + 1] = item.id end end
  self.deleted[key] = kept
  local log = self:find_channel(guild)
  if log then self.rest:post("/channels/" .. log .. "/messages", {content = "Security alert: a moderator or member deleted #" .. tostring(channel.name or "unknown") .. " (" .. id .. "). " .. #ids .. " channel deletion(s) in 60 seconds.", allowed_mentions = {parse = {}}}) end
  if #ids < 3 then return end

  local restored = 0
  for _, deleted_id in ipairs(ids) do
    local snapshot = self.store.data.channels[guild .. ":" .. deleted_id]
    if snapshot then
      local body = {name = snapshot.name, type = snapshot.type, reason = "Timi recovery after repeated channel deletion"}
      for _, field in ipairs({"topic", "parent_id", "position", "permission_overwrites", "nsfw", "rate_limit_per_user", "bitrate", "user_limit"}) do if snapshot[field] ~= nil then body[field] = snapshot[field] end end
      local ok, created = pcall(function() return self.rest:post("/guilds/" .. guild .. "/channels", body) end)
      if ok and created and created.id then
        restored = restored + 1; snapshot.deletedAt = util.now_ms(); self.store:queue_save()
        local archived = {}
        for _, message in ipairs(self.store.data.messages[guild] or {}) do if message.channel_id == deleted_id and message.timestamp_ms >= util.now_ms() - WEEK then archived[#archived + 1] = message end end
        table.sort(archived, function(a, b) return a.timestamp_ms < b.timestamp_ms end)
        for _, message in ipairs(archived) do
          local names = {}
          for _, file in ipairs(message.attachments or {}) do names[#names + 1] = tostring(file.name or "attachment") .. ": " .. tostring(file.url or "") end
          local suffix = #names > 0 and "\nAttachments: " .. table.concat(names, " | ") or ""
          local stamp = math.floor((message.timestamp_ms or 0) / 1000)
          local text = "[Recovered archive • original message " .. tostring(message.id) .. " • <t:" .. stamp .. ":F>]\nAuthor ID: " .. tostring(message.author_id) .. "\n" .. tostring(message.content or "(no text content)") .. suffix
          pcall(function() self.rest:post("/channels/" .. created.id .. "/messages", {content = text:sub(1, 1900), allowed_mentions = {parse = {}}}) end)
        end
      end
    elseif log then
      self.rest:post("/channels/" .. log .. "/messages", {content = "Recovery incomplete: no saved channel configuration exists for deleted channel ID " .. deleted_id .. ".", allowed_mentions = {parse = {}}})
    end
  end

  local bot_member, actor_member = self.rest:get("/guilds/" .. guild .. "/members/" .. me.id), self.rest:get("/guilds/" .. guild .. "/members/" .. actor)
  if actor_member.user and actor_member.user.bot then self.deleted[key] = nil; return end
  local roles = self.rest:get("/guilds/" .. guild .. "/roles") or {}
  local bot_top, actor_top, can_timeout, can_manage = 0, 0, false, false
  for _, role in ipairs(roles) do
    local belongs_to_bot = role.id == guild or util.array_contains(bot_member.roles or {}, role.id)
    if belongs_to_bot then
      local permissions = tonumber(role.permissions or "0") or 0
      if has_bit(permissions, 8) or has_bit(permissions, MODERATE) then can_timeout = true end
      if has_bit(permissions, 8) or has_bit(permissions, MANAGE_ROLES) then can_manage = true end
    end
    if util.array_contains(bot_member.roles or {}, role.id) then bot_top = math.max(bot_top, tonumber(role.position) or 0) end
    if util.array_contains(actor_member.roles or {}, role.id) then actor_top = math.max(actor_top, tonumber(role.position) or 0) end
  end
  if not can_timeout or not can_manage or actor_top >= bot_top then
    if log then self.rest:post("/channels/" .. log .. "/messages", {content = "Critical anti-nuke alert: channel recovery recreated " .. restored .. " of " .. #ids .. " deleted channel(s), but Timi did not quarantine <@" .. actor .. ">. Permissions or role hierarchy are insufficient. Manually review the audit log.", allowed_mentions = {parse = {}}}) end
    self.deleted[key] = nil
    return
  end
  local removable = {}
  for _, role in ipairs(roles) do
    if role.id ~= guild and util.array_contains(actor_member.roles or {}, role.id) and not role.managed and (tonumber(role.position) or 0) < bot_top then removable[#removable + 1] = role.id end
  end
  local until_time = os.date("!%Y-%m-%dT%H:%M:%SZ", os.time() + 3600)
  local timeout_ok = pcall(function() self.rest:patch("/guilds/" .. guild .. "/members/" .. actor, {communication_disabled_until = until_time, reason = "Timi anti-nuke: deleted " .. #ids .. " channels within 60 seconds"}) end)
  local removed = 0
  for _, role in ipairs(removable) do if pcall(function() self.rest:delete("/guilds/" .. guild .. "/members/" .. actor .. "/roles/" .. role) end) then removed = removed + 1 end end
  if log then self.rest:post("/channels/" .. log .. "/messages", {content = "Anti-nuke recovery finished: recreated " .. restored .. " of " .. #ids .. " deleted channel(s). <@" .. actor .. "> " .. (timeout_ok and "timed out for 60 minutes" or "could not be timed out") .. "; removed " .. removed .. " manageable role(s). Reposted archives are copies with new message IDs; attachment source links may expire.", allowed_mentions = {parse = {}}}) end
  self.deleted[key] = nil
end

return R

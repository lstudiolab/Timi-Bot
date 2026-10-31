local util = require("./util")
local V = {}
V.__index = V
local DAY = 86400000
local function is_manager(interaction) return util.has_permission(interaction, 32) end
local function row(items) return util.row(items) end
local function button(id, label, style) return util.button(id, label, style or 2) end

function V.new(rest, store, interactions)
  return setmetatable({rest = rest, store = store, interactions = interactions, owners = {}}, V)
end

function V:is_owner(guild, user)
  if self.owners[guild] then return self.owners[guild] == user end
  local info = self.rest:get("/guilds/" .. guild)
  self.owners[guild] = info.owner_id
  return info.owner_id == user
end

function V:validate_role(guild, role_id, assignable)
  if not util.is_snowflake(role_id) or role_id == guild then return false, "Choose a normal server role other than @everyone." end
  local roles = self.rest:get("/guilds/" .. guild .. "/roles") or {}
  local target, has_manage_roles, bot_top
  has_manage_roles, bot_top = false, 0
  for _, role in ipairs(roles) do if role.id == role_id then target = role end end
  if not target then return false, "That role no longer exists in this server." end
  if target.managed then return false, "Managed integration roles cannot be used." end
  if not assignable then return true end
  local me = self.rest:get("/users/@me")
  local bot_member = self.rest:get("/guilds/" .. guild .. "/members/" .. me.id)
  local bot_roles = bot_member.roles or {}
  for _, role in ipairs(roles) do
    local belongs = role.id == guild or util.array_contains(bot_roles, role.id)
    local permissions = tonumber(role.permissions or "0") or 0
    if belongs and (math.floor(permissions / 268435456) % 2 == 1 or math.floor(permissions / 8) % 2 == 1) then has_manage_roles = true end
    if util.array_contains(bot_roles, role.id) then bot_top = math.max(bot_top, tonumber(role.position) or 0) end
  end
  if not has_manage_roles then return false, "Timi needs Manage Roles permission." end
  if (tonumber(target.position) or 0) >= bot_top then return false, "Move Timi's highest role above the selected role." end
  return true
end

function V:score(guild, user, member, settings)
  local record, now = self.store:member(guild, user), util.now_ms()
  local age, minimum = math.max(0, (now - util.snowflake_time(user)) / DAY), tonumber(settings.min_age_days) or 7
  local age_failed, age_factor = age < minimum, 0
  if not age_failed then
    if minimum == 0 or age / minimum >= 4 then age_factor = 1
    elseif age / minimum >= 2 then age_factor = 0.95
    elseif age / minimum >= 1.5 then age_factor = 0.9
    elseif age / minimum >= 1.2 then age_factor = 0.8
    else age_factor = 0.7 end
  end
  local points = settings.points or {age = 40, history = 20, attempts = 20, behavior = 10, avatar = 10}
  local age_points = math.floor((points.age or 40) * age_factor + 0.5)
  local history_penalty = math.min(math.max(0, (record.leaves or 0) - 1) * (points.history or 20) * 0.2 + (record.failed or 0) * (points.history or 20) * 0.15, points.history or 20)
  local history_points = math.floor((points.history or 20) - history_penalty + 0.5)
  local attempts = {}
  for _, stamp in ipairs(record.attempts or {}) do if now - stamp <= 600000 then attempts[#attempts + 1] = stamp end end
  attempts[#attempts + 1] = now; record.attempts = attempts
  local count = #attempts
  local factor = count == 1 and 1 or count == 2 and 0.9 or count == 3 and 0.8 or count <= 5 and 0.7 or 0.6
  local attempt_points = math.floor((points.attempts or 20) * factor + 0.5)
  local suspicious = record.suspicious or 0
  local behavior_factor = suspicious == 0 and 1 or suspicious == 1 and 0.65 or suspicious <= 3 and 0.3 or 0
  local behavior_points = math.floor((points.behavior or 10) * behavior_factor + 0.5)
  local avatar_points = member.user and member.user.avatar and (points.avatar or 10) or math.floor((points.avatar or 10) * 0.25 + 0.5)
  self.store:save()
  return age_points + history_points + attempt_points + behavior_points + avatar_points, {
    {name = "Account age", points = age_points, max = points.age or 40, reason = age_failed and ("Account is " .. string.format("%.1f", age) .. " days old; minimum is " .. minimum .. " days.") or ("Account age: " .. string.format("%.1f", age) .. " days.")},
    {name = "Server history", points = history_points, max = points.history or 20, reason = tostring(record.joins or 0) .. " joins, " .. tostring(record.leaves or 0) .. " leaves, " .. tostring(record.failed or 0) .. " previous failed checks."},
    {name = "Verification attempts", points = attempt_points, max = points.attempts or 20, reason = tostring(count) .. " attempt(s) in the last 10 minutes."},
    {name = "Message behavior", points = behavior_points, max = points.behavior or 10, reason = tostring(suspicious) .. " suspicious event(s). " .. tostring(record.last_reason or "")},
    {name = "Avatar", points = avatar_points, max = points.avatar or 10, reason = (member.user and member.user.avatar) and "Custom avatar present." or "Default avatar; weak signal only."}
  }, age_failed
end

function V:decision(score, age_failed, limits)
  if age_failed then return "review" end
  if score >= (limits.pass or 80) then return "pass" end
  if score >= (limits.review or 60) then return "review" end
  return "kick"
end

function V:log(guild, channel, content)
  if channel == "" then
    for _, candidate in ipairs(self.rest:get("/guilds/" .. guild .. "/channels") or {}) do if candidate.type == 0 and candidate.name == "timi" then channel = candidate.id end end
  end
  if channel and channel ~= "" then pcall(function() self.rest:post("/channels/" .. channel .. "/messages", {content = content, allowed_mentions = {parse = {}}}) end) end
end

function V:settings_text(guild)
  local s = self.store:verify(guild)
  return "**Timi verification settings**\nVerified role: " .. util.mention_role(s.role_id) ..
    "\nRequired role: " .. util.mention_role(s.required_role_id) ..
    "\nMinimum account age: " .. tostring(s.min_age_days) .. " days\nReview channel: " .. util.mention_channel(s.review_channel_id) ..
    "\nThresholds: 80+ pass, 60–79 manual review, below 60 kick\nWeights: age 40, history 20, attempts 20, behavior 10, avatar 10"
end

function V:command(interaction, name)
  local guild, user, channel = util.guild_id(interaction), util.user_id(interaction), util.channel_id(interaction)
  if not self:is_owner(guild, user) then return self.interactions:finish(interaction, "Only the server owner can use this verification command.", {}) end
  local settings = self.store:verify(guild)
  if name == "verify-panel" then
    local existing
    for _, panel in ipairs(settings.published_panels or {}) do if panel.channel_id == channel then existing = panel end end
    local payload = {embeds = {{color = 8421504, title = settings.panel_title, description = settings.panel_description}}, components = {row({button("verify:start", "Verify", 1)})}}
    if existing then self.rest:patch("/channels/" .. channel .. "/messages/" .. existing.message_id, payload)
    else
      local sent = self.rest:post("/channels/" .. channel .. "/messages", payload)
      settings.published_panels[#settings.published_panels + 1] = {channel_id = channel, message_id = sent.id}
      self.store.data.verification[guild] = settings; self.store:save()
    end
    return self.interactions:finish(interaction, existing and "Existing verification panel updated." or "Risk-based verification panel published.", {})
  end
  local role = util.option(interaction.data.options, "role")
  local required = util.option(interaction.data.options, "required-role")
  local clear = util.option(interaction.data.options, "clear-required-role")
  local age = util.option(interaction.data.options, "min-age-days")
  local review = util.option(interaction.data.options, "review-channel")
  local title = util.option(interaction.data.options, "title")
  local description = util.option(interaction.data.options, "description")
  if role == nil and required == nil and not clear and age == nil and review == nil and title == nil and description == nil then
    return self.interactions:finish(interaction, self:settings_text(guild), {})
  end
  if role then
    local ok, message = self:validate_role(guild, tostring(role), true)
    if not ok then return self.interactions:finish(interaction, message, {}) end
    settings.role_id = tostring(role)
  end
  if required then
    local ok, message = self:validate_role(guild, tostring(required), false)
    if not ok then return self.interactions:finish(interaction, message, {}) end
    settings.required_role_id = tostring(required)
  end
  if clear then settings.required_role_id = "" end
  if age ~= nil then settings.min_age_days = math.max(0, math.min(3650, tonumber(age) or 7)) end
  if review then
    if not util.is_snowflake(tostring(review)) then return self.interactions:finish(interaction, "Select a valid text channel.", {}) end
    settings.review_channel_id = tostring(review)
  end
  if title then settings.panel_title = util.trim(title) ~= "" and util.trim(title) or "Verify your account" end
  if description then settings.panel_description = util.trim(description) ~= "" and util.trim(description) or "Press Verify to have Timi assess your account and server history." end
  self.store.data.verification[guild] = settings; self.store:save()
  for _, panel in ipairs(settings.published_panels or {}) do
    pcall(function() self.rest:patch("/channels/" .. panel.channel_id .. "/messages/" .. panel.message_id, {embeds = {{color = 8421504, title = settings.panel_title, description = settings.panel_description}}, components = {row({button("verify:start", "Verify", 1)})}}) end)
  end
  return self.interactions:finish(interaction, "Verification settings saved. Existing panels have been refreshed.", {})
end

function V:component(interaction, custom)
  if custom ~= "verify:start" then return self.interactions:finish(interaction, "This verification control is no longer available.", {}) end
  local guild, user = util.guild_id(interaction), util.user_id(interaction)
  local settings, record = self.store:verify(guild), self.store:member(guild, user)
  if (record.last_verified or 0) > 0 then return self.interactions:finish(interaction, "You have already completed verification. Each member can verify only once in this server.", {}) end
  local member = self.rest:get("/guilds/" .. guild .. "/members/" .. user)
  if settings.role_id ~= "" and util.array_contains(member.roles or {}, settings.role_id) then return self.interactions:finish(interaction, "You are already verified.", {}) end
  if settings.required_role_id ~= "" and not util.array_contains(member.roles or {}, settings.required_role_id) then
    return self.interactions:finish(interaction, "You cannot start verification yet. You must first have the configured required role.", {})
  end
  local score, checks, age_failed = self:score(guild, user, member, settings)
  local result, lines = self:decision(score, age_failed, settings.thresholds or {pass = 80, review = 60}), {}
  for _, item in ipairs(checks) do lines[#lines + 1] = "**" .. item.name .. ":** " .. item.points .. "/" .. item.max .. " — " .. item.reason end
  local detail = table.concat(lines, "\n")
  if result == "pass" then
    if settings.role_id == "" then return self.interactions:finish(interaction, "Your score is " .. score .. "/100, but the server owner has not configured a verified role.", {}) end
    self.rest:put("/guilds/" .. guild .. "/members/" .. user .. "/roles/" .. settings.role_id, nil)
    record.last_verified = util.now_ms(); self.store:save()
    self.interactions:finish(interaction, "**Verification passed — " .. score .. "/100**\nYour verified role has been assigned.", {})
    self:log(guild, settings.review_channel_id, "Verification passed for <@" .. user .. "> — **" .. score .. "/100**\n" .. detail)
  elseif result == "review" then
    self.interactions:finish(interaction, "**Manual review required — " .. score .. "/100**\n" .. (age_failed and "Your account does not meet the server's minimum age requirement. " or "") .. "A moderator must review your verification.", {})
    self:log(guild, settings.review_channel_id, "**Verification requires manual review**\nMember: <@" .. user .. ">\nScore: **" .. score .. "/100**\n" .. detail)
  else
    self.interactions:finish(interaction, "**Verification failed — " .. score .. "/100**\nYour account did not meet the server's risk threshold.", {})
    pcall(function() self.rest:delete("/guilds/" .. guild .. "/members/" .. user) end)
    record.failed = (record.failed or 0) + 1; self.store:save()
    self:log(guild, settings.review_channel_id, "**Verification failed; kick attempted**\nMember: <@" .. user .. ">\nScore: **" .. score .. "/100**\n" .. detail)
  end
end

function V:bot_component(interaction, custom)
  local decision, guild, bot = custom:match("^botguard:(%a+):(%d+):(%d+)$")
  if (decision ~= "yes" and decision ~= "no") or not guild or not bot then return self.interactions:finish(interaction, "This bot approval control is invalid.", {}) end
  local user = util.user_id(interaction)
  local info = self.rest:get("/guilds/" .. guild)
  if info.owner_id ~= user and not is_manager(interaction) then
    return self.interactions:finish(interaction, "Only the server owner or a member with Manage Server can decide.", {})
  end
  local key, pending = guild .. ":" .. bot, (self.store.data.pending_bots or {})[guild .. ":" .. bot]
  if pending ~= ((interaction.message or {}).id or "") then return self.interactions:finish(interaction, "This request is no longer pending.", {}) end
  if decision == "no" then
    local ok, err = pcall(function() self.rest:delete("/guilds/" .. guild .. "/members/" .. bot) end)
    if not ok then return self.interactions:finish(interaction, "Timi could not remove the rejected bot. Check Kick Members permission and role hierarchy.", {}) end
    self.store.data.pending_bots[key] = nil; self.store:save()
    return self.interactions:finish(interaction, "Bot rejected and removed from the server.", {})
  end
  local channels = self.rest:get("/guilds/" .. guild .. "/channels") or {}
  local failures = 0
  for _, channel in ipairs(channels) do
    local found
    for _, overwrite in ipairs(channel.permission_overwrites or {}) do if overwrite.id == bot then found = true end end
    if found then
      local protected = channel.name == "timi" or channel.name == "timi-logs" or channel.name == "timi-confirmations"
      local ok = pcall(function()
        if protected then self.rest:put("/channels/" .. channel.id .. "/permissions/" .. bot, {type = 1, allow = "0", deny = tostring(1024 + 2048 + 65536)})
        else self.rest:delete("/channels/" .. channel.id .. "/permissions/" .. bot) end
      end)
      if not ok then failures = failures + 1 end
    end
  end
  self.store.data.pending_bots[key] = nil; self.store:save()
  return self.interactions:finish(interaction, failures == 0 and "Bot approved. Temporary restrictions were removed; private Timi channels remain inaccessible." or "Bot approved, but Timi could not update every channel restriction. Check Manage Channels permission.", {})
end

return V

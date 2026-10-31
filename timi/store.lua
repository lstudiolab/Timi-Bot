local fs = require("fs")
local json = require("json")
local util = require("./util")

local Store = {}
Store.__index = Store

local function defaults()
  return {
    tickets = {}, moderation = {}, verification = {}, members = {}, channels = {},
    messages = {}, role_picker_menus = {}, role_picker_drafts = {}, embeds = {},
    moderation_cases = {}, automod_words = {}, pending_bots = {}
  }
end

local function fill_defaults(target, source)
  for key, value in pairs(source) do
    if target[key] == nil then target[key] = util.copy(value) end
  end
  return target
end

local function read_json(path)
  if not fs.existsSync(path) then return nil end
  local ok, content = pcall(fs.readFileSync, path)
  if not ok then return nil end
  local parsed, value = pcall(json.parse, content)
  if parsed and type(value) == "table" then return value end
  return nil
end

local function rename_fields(value, mapping)
  if type(value) ~= "table" then return false end
  local changed = false
  for old, new in pairs(mapping) do
    if value[new] == nil and value[old] ~= nil then
      value[new] = value[old]
      changed = true
    end
    if old ~= new and value[old] ~= nil then value[old] = nil; changed = true end
  end
  return changed
end

local function normalize_panels(value)
  local changed = rename_fields(value, {publishedPanels = "published_panels"})
  for _, panel in ipairs(value.published_panels or {}) do
    if rename_fields(panel, {channelId = "channel_id", messageId = "message_id"}) then changed = true end
  end
  return changed
end

local function normalize_data(data)
  local changed = false
  for _, value in pairs(data.tickets or {}) do
    if rename_fields(value, {
      panelTitle = "panel_title", panelDescription = "panel_description",
      openButtonLabel = "open_label", ticketMessage = "ticket_message",
      closeButtonLabel = "close_label", categoryName = "category_name",
      supportRoleId = "support_role_id", transcriptChannelId = "transcript_channel_id",
      panelChannelId = "panel_channel_id"
    }) then changed = true end
    if normalize_panels(value) then changed = true end
  end
  for _, value in pairs(data.moderation or {}) do
    if rename_fields(value, {
      timeoutMinutes = "timeout_minutes", logChannelId = "log_channel_id",
      actionDurationSeconds = "action_duration_seconds", maxMessageCount = "max_message_count",
      blockInvites = "block_invites", blockMassMentions = "block_mass_mentions",
      blockExcessiveCaps = "block_excessive_caps", panelChannelId = "panel_channel_id",
      panelMessageId = "panel_message_id"
    }) then changed = true end
  end
  for _, value in pairs(data.verification or {}) do
    if rename_fields(value, {
      roleId = "role_id", requiredRoleId = "required_role_id", reviewChannelId = "review_channel_id",
      minAccountAgeDays = "min_age_days", panelTitle = "panel_title",
      panelDescription = "panel_description", pointMax = "points"
    }) then changed = true end
    if normalize_panels(value) then changed = true end
  end
  for _, value in pairs(data.members or {}) do
    if rename_fields(value, {
      verificationAttempts = "attempts", failedChecks = "failed",
      suspiciousMessages = "suspicious", lastJoinAt = "last_join",
      lastVerifiedAt = "last_verified", lastSuspiciousAt = "last_suspicious",
      lastSuspiciousReason = "last_reason"
    }) then changed = true end
  end
  for _, value in pairs(data.embeds or {}) do
    if rename_fields(value, {guildId = "guild_id", creatorId = "creator_id"}) then changed = true end
    for _, placement in ipairs(value.placements or {}) do
      if rename_fields(placement, {channelId = "channel_id", messageId = "message_id"}) then changed = true end
    end
  end
  return changed
end

local function migrate_legacy(dir, data)
  local changed = false
  for _, item in ipairs({{"ticket-settings.json", "tickets"}, {"moderation-settings.json", "moderation"}}) do
    local old = read_json(dir .. "/" .. item[1])
    if type(old) == "table" then
      for guild, value in pairs(old) do
        if data[item[2]][guild] == nil then data[item[2]][guild] = value; changed = true end
      end
    end
  end
  local verification = read_json(dir .. "/verification.json")
  if verification then
    for guild, value in pairs(verification.guilds or {}) do
      if data.verification[guild] == nil then data.verification[guild] = value; changed = true end
    end
    for key, value in pairs(verification.members or {}) do
      if data.members[key] == nil then data.members[key] = value; changed = true end
    end
  end
  local recovery = read_json(dir .. "/recovery-backup.json")
  if recovery then
    for guild, value in pairs(recovery.guilds or {}) do
      for channel, snapshot in pairs(value.channels or {}) do
        local key = guild .. ":" .. channel
        if data.channels[key] == nil then data.channels[key] = snapshot; changed = true end
      end
      for _, message in ipairs(value.messages or {}) do
        local item = {
          id = tostring(message.id or ""), channel_id = tostring(message.channelId or message.channel_id or ""),
          author_id = tostring(message.authorId or message.author_id or ""), content = message.content or "",
          timestamp_ms = tonumber(message.createdAt or message.timestamp_ms) or 0,
          attachments = message.attachments or {}
        }
        data.messages[guild] = data.messages[guild] or {}
        local exists = false
        for _, existing in ipairs(data.messages[guild]) do if existing.id == item.id then exists = true end end
        if not exists then data.messages[guild][#data.messages[guild] + 1] = item; changed = true end
      end
    end
  end
  return changed
end

function Store.new(config)
  local self = setmetatable({config = config, path = config.data_dir .. "/timi.json", backup = config.data_dir .. "/timi.json.bak", data = defaults()}, Store)
  local primary_exists, backup_exists = fs.existsSync(self.path), fs.existsSync(self.backup)
  if primary_exists then
    local primary = read_json(self.path)
    if primary then self.data = fill_defaults(primary, defaults())
    elseif backup_exists then
      local recovered = read_json(self.backup)
      if not recovered then error("Both data/timi.json and its backup are invalid; refusing to reset bot data") end
      local corrupt = self.path .. ".corrupt-" .. tostring(util.now_ms())
      fs.renameSync(self.path, corrupt)
      self.data = fill_defaults(recovered, defaults())
      util.log("warn", "Recovered bot data from backup; preserved invalid file at " .. corrupt)
    else
      error("data/timi.json is invalid and no backup exists; refusing to reset bot data")
    end
  elseif backup_exists then
    local recovered = read_json(self.backup)
    if not recovered then error("data/timi.json is missing and backup is invalid") end
    self.data = fill_defaults(recovered, defaults())
  end
  local migrated = migrate_legacy(config.data_dir, self.data)
  if normalize_data(self.data) then migrated = true end
  if migrated then self:save(); util.log("info", "Imported or normalized legacy Timi settings and recovery data") end
  return self
end

function Store:save()
  local encoded = json.stringify(self.data)
  local tmp = self.path .. ".tmp"
  fs.writeFileSync(tmp, encoded)
  if fs.existsSync(self.path) then fs.writeFileSync(self.backup, fs.readFileSync(self.path)) end
  fs.renameSync(tmp, self.path)
end

function Store:queue_save()
  if self.save_pending then return end
  self.save_pending = true
  util.spawn(function()
    util.sleep(750)
    self.save_pending = false
    local ok, err = pcall(function() self:save() end)
    if not ok then util.log("error", "Deferred data save failed: " .. tostring(err)) end
  end)
end

function Store:ticket(guild)
  local value = self.data.tickets[guild]
  if not value then
    value = {}
    self.data.tickets[guild] = value
  end
  return fill_defaults(value, {
    panel_title = "Support Tickets", panel_description = "Need help? Open a ticket and our team will assist you.",
    open_label = "Open Ticket", ticket_message = "Please describe what you need help with. A member of the support team will be with you shortly.",
    close_label = "Close Ticket", category_name = "ticket", support_role_id = "",
    transcript_channel_id = "", panel_channel_id = "", published_panels = {}
  })
end

function Store:mods(guild)
  local value = self.data.moderation[guild]
  if not value then value = {}; self.data.moderation[guild] = value end
  return fill_defaults(value, {
    enabled = true, sanction = "timeout", timeout_minutes = 10, log_channel_id = "",
    action_duration_seconds = 3, max_message_count = 3, block_invites = true,
    block_mass_mentions = true, block_excessive_caps = true,
    panel_channel_id = "", panel_message_id = ""
  })
end

function Store:verify(guild)
  local value = self.data.verification[guild]
  if not value then value = {}; self.data.verification[guild] = value end
  fill_defaults(value, {
    role_id = "", required_role_id = "", review_channel_id = "", min_age_days = 7,
    panel_title = "Verify your account", panel_description = "Press Verify to have Timi assess your account and server history.",
    published_panels = {}, points = {age = 40, history = 20, attempts = 20, behavior = 10, avatar = 10},
    thresholds = {pass = 80, review = 60}
  })
  value.points = fill_defaults(value.points or {}, {age = 40, history = 20, attempts = 20, behavior = 10, avatar = 10})
  value.thresholds = fill_defaults(value.thresholds or {}, {pass = 80, review = 60})
  return value
end

function Store:member(guild, user)
  local key = guild .. ":" .. user
  if not self.data.members[key] then self.data.members[key] = {} end
  return fill_defaults(self.data.members[key], {
    joins = 0, leaves = 0, attempts = {}, failed = 0, suspicious = 0,
    last_join = 0, last_verified = 0, last_suspicious = 0, last_reason = ""
  })
end

function Store:embed(guild, name)
  local value = self.data.embeds[guild .. ":" .. name]
  if not value then return nil end
  return fill_defaults(value, {guild_id = guild, name = name, creator_id = "", title = "", description = "", color = 8421504, author = "", footer = "", thumbnail = "", image = "", url = "", fields = {}, placements = {}})
end

function Store:save_embed(value)
  self.data.embeds[value.guild_id .. ":" .. value.name] = value
  self:save()
end

return Store

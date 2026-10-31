local util = require("./util")
local E = {}
E.__index = E

local function row(items) return util.row(items) end
local function button(id, label, style) return util.button(id, label, style or 2) end

function E.new(rest, store, interactions)
  return setmetatable({rest = rest, store = store, interactions = interactions}, E)
end

function E:payload(value)
  local result = {color = 8421504}
  for _, key in ipairs({"title", "description", "url"}) do if value[key] and value[key] ~= "" then result[key] = value[key] end end
  if value.author and value.author ~= "" then result.author = {name = value.author} end
  if value.footer and value.footer ~= "" then result.footer = {text = value.footer} end
  if value.thumbnail and value.thumbnail ~= "" then result.thumbnail = {url = value.thumbnail} end
  if value.image and value.image ~= "" then result.image = {url = value.image} end
  if #(value.fields or {}) > 0 then
    result.fields = {}
    for _, field in ipairs(value.fields) do result.fields[#result.fields + 1] = {name = field.name, value = field.value, inline = field.inline == true} end
  end
  return result
end

function E:text(value)
  local fields = {}
  for index, field in ipairs(value.fields or {}) do fields[#fields + 1] = tostring(index) .. ". " .. field.name .. (field.inline and " (inline)" or "") end
  return "**Embed editor: " .. value.name .. "**\n\nTitle: " .. (value.title ~= "" and value.title or "—") ..
    "\nDescription: " .. (value.description ~= "" and value.description or "—") ..
    "\nColor: #808080\nAuthor: " .. (value.author ~= "" and value.author or "—") ..
    "\nFooter: " .. (value.footer ~= "" and value.footer or "—") ..
    "\nFields: " .. #fields .. "\n" .. (#fields > 0 and table.concat(fields, "\n") or "No fields") ..
    "\nThumbnail: " .. (value.thumbnail ~= "" and "Set" or "—") ..
    "\nImage: " .. (value.image ~= "" and "Set" or "—") ..
    "\nURL: " .. (value.url ~= "" and value.url or "—") ..
    "\n\nChanges save automatically and update every message placed with /place-embed."
end

function E:components(value)
  local n = value.name
  return {
    row({button("embed:content:" .. n, "Title & description", 1), button("embed:style:" .. n, "Appearance")}),
    row({button("embed:media:" .. n, "Images & link"), button("embed:add-field:" .. n, "Add field"), button("embed:remove-field:" .. n, "Remove field", 4)})
  }
end

function E:refresh(value)
  for _, placement in ipairs(value.placements or {}) do
    local ok, err = pcall(function()
      self.rest:patch("/channels/" .. placement.channel_id .. "/messages/" .. placement.message_id, {embeds = {self:payload(value)}, allowed_mentions = {parse = {}}})
    end)
    if not ok then util.log("warn", "Could not refresh embed " .. value.name .. ": " .. tostring(err)) end
  end
end

function E:command(interaction, name)
  local guild, channel = util.guild_id(interaction), util.channel_id(interaction)
  if not util.has_permission(interaction, 32) then return self.interactions:finish(interaction, "You need Manage Server permission to manage embeds.", {}) end
  if name == "create-embed" then
    return self.interactions:show_modal(interaction, util.modal("embed:create", "Create an embed", {
      util.text_input("name", "Embed name (no spaces)", "", false, 24),
      util.text_input("title", "Embed title", "", false, 256),
      util.text_input("description", "Embed description", "", true, 4000)
    }))
  end
  local embed_name = util.option(interaction.data.options, "name") or ""
  local value = self.store:embed(guild, embed_name)
  if name == "edit-embed" then
    if not value then return self.interactions:finish(interaction, "No saved embed with that name. Use /create-embed first.", {}) end
    return self.interactions:finish(interaction, self:text(value), self:components(value))
  elseif name == "place-embed" then
    if not value then return self.interactions:finish(interaction, "No saved embed with that name. Use /create-embed first.", {}) end
    local sent = self.rest:post("/channels/" .. channel .. "/messages", {embeds = {self:payload(value)}, allowed_mentions = {parse = {}}})
    value.placements[#value.placements + 1] = {channel_id = channel, message_id = sent.id}
    self.store:save_embed(value)
    return self.interactions:finish(interaction, "Embed placed in this channel.", {})
  end
end

function E:component(interaction, custom)
  if not util.has_permission(interaction, 32) then return self.interactions:finish(interaction, "You need Manage Server permission to edit embeds.", {}) end
  local name = custom:match("^embed:[^:]+:(.+)$")
  local value = self.store:embed(util.guild_id(interaction), name or "")
  if not value then return self.interactions:finish(interaction, "This saved embed no longer exists.", {}) end
  local action = custom:match("^embed:([^:]+):")
  local forms = {
    content = {"Edit embed content", {util.text_input("title", "Title", value.title, false, 256), util.text_input("description", "Description", value.description, true, 4000)}},
    style = {"Edit embed appearance", {util.text_input("author", "Author", value.author, false, 256, false), util.text_input("footer", "Footer", value.footer, false, 2048, false)}},
    media = {"Edit embed images and link", {util.text_input("thumbnail", "Thumbnail image URL", value.thumbnail, false, 500, false), util.text_input("image", "Main image URL", value.image, false, 500, false), util.text_input("url", "Title URL", value.url, false, 500, false)}},
    ["add-field"] = {"Add embed field", {util.text_input("field-name", "Field name", "", false, 256), util.text_input("field-value", "Field value", "", true, 1024), util.text_input("inline", "Inline? type true or false", "false", false, 5, false)}},
    ["remove-field"] = {"Remove embed field", {util.text_input("field-index", "Field number to remove (1-based)", "", false, 2)}}
  }
  local form = forms[action]
  if not form then return self.interactions:finish(interaction, "This embed control is no longer available.", {}) end
  return self.interactions:show_modal(interaction, util.modal(custom, form[1], form[2]))
end

function E:modal(interaction, custom, fields)
  local guild, user = util.guild_id(interaction), util.user_id(interaction)
  if not util.has_permission(interaction, 32) then return self.interactions:finish(interaction, "You need Manage Server permission to edit embeds.", {}) end
  if custom == "embed:create" then
    local name = string.lower(util.trim(fields.name))
    local title, description = util.trim(fields.title), util.trim(fields.description)
    if name == "" or not name:match("^[%w_-]+$") or title == "" or description == "" then
      return self.interactions:finish(interaction, "Enter a name using letters, numbers, - or _, plus a title and description.", {})
    end
    if self.store:embed(guild, name) then return self.interactions:finish(interaction, "An embed with that name already exists. Use /edit-embed to change it.", {}) end
    local value = {guild_id = guild, name = name, creator_id = user, title = title, description = description, color = 8421504, author = "", footer = "", thumbnail = "", image = "", url = "", fields = {}, placements = {}}
    self.store:save_embed(value)
    return self.interactions:finish(interaction, self:text(value), self:components(value))
  end
  local name = custom:match("^embed:[^:]+:(.+)$")
  local value = self.store:embed(guild, name or "")
  if not value then return self.interactions:finish(interaction, "This saved embed no longer exists.", {}) end
  local action = custom:match("^embed:([^:]+):")
  if action == "content" then
    value.title, value.description = util.trim(fields.title), util.trim(fields.description)
  elseif action == "style" then
    value.author, value.footer = util.trim(fields.author), util.trim(fields.footer)
  elseif action == "media" then
    value.thumbnail, value.image, value.url = util.trim(fields.thumbnail), util.trim(fields.image), util.trim(fields.url)
    for _, url in ipairs({value.thumbnail, value.image, value.url}) do if url ~= "" and not url:match("^https://") then return self.interactions:finish(interaction, "Image and title links must use HTTPS URLs.", {}) end end
  elseif action == "add-field" then
    if #value.fields >= 25 then return self.interactions:finish(interaction, "Discord embeds support up to 25 fields.", {}) end
    local field_name, field_value = util.trim(fields["field-name"]), util.trim(fields["field-value"])
    if field_name == "" or field_value == "" then return self.interactions:finish(interaction, "Field name and value are required.", {}) end
    value.fields[#value.fields + 1] = {name = field_name, value = field_value, inline = string.lower(fields.inline or "") == "true" or fields.inline == "yes"}
  elseif action == "remove-field" then
    local index = tonumber(fields["field-index"]) or 0
    if index < 1 or index > #value.fields then return self.interactions:finish(interaction, "Enter a valid field number shown in the embed editor.", {}) end
    table.remove(value.fields, index)
  else
    return self.interactions:finish(interaction, "This embed form is no longer available.", {})
  end
  self.store:save_embed(value); self:refresh(value)
  return self.interactions:finish(interaction, self:text(value), self:components(value))
end

return E

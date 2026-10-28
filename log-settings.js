const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "data", "log-settings.json");
const DEFAULTS = Object.freeze({
  channelId: null,
  memberJoins: false,
  memberLeaves: false,
  messageDeletes: false,
  messageEdits: false,
  channelChanges: false,
  roleChanges: false,
  banEvents: false
});
let cache;

function readStore() {
  if (cache) return cache;
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read event log settings:", error.message);
    cache = {};
  }
  return cache;
}
function getSettings(guildId) {
  return { ...DEFAULTS, ...(readStore()[guildId] || {}) };
}
function saveSettings(guildId, settings) {
  const value = readStore();
  value[guildId] = { ...DEFAULTS, ...(value[guildId] || {}), ...settings };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temporary = FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, FILE);
  cache = value;
  return getSettings(guildId);
}
async function log(guild, eventKey, content) {
  if (!guild) return;
  const settings = getSettings(guild.id);
  if (!settings[eventKey] || !settings.channelId) return;
  const channel = guild.channels.cache.get(settings.channelId) || await guild.channels.fetch(settings.channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) return;
  await channel.send({
    content: String(content).slice(0, 1900),
    allowedMentions: { parse: [] }
  }).catch(error => console.error("Could not write event log:", error.message));
}
function resetSettings(guildId) {
  return saveSettings(guildId, DEFAULTS);
}

module.exports = { DEFAULTS, getSettings, saveSettings, resetSettings, log };

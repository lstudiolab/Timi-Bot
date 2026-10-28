const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "data", "security-settings.json");
const DEFAULTS = Object.freeze({
  newAccountAlertDays: 7,
  timeoutNewAccounts: false,
  veryNewAccountDays: 3,
  newAccountTimeoutMinutes: 10,
  joinBurstEnabled: true,
  joinWindowSeconds: 10,
  joinThreshold: 6,
  antiNukeEnabled: true,
  channelDeleteWindowSeconds: 60,
  channelDeleteThreshold: 3,
  antiNukeTimeoutMinutes: 60
});

let cache;
function readStore() {
  if (cache) return cache;
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read security settings:", error.message);
    cache = {};
  }
  return cache;
}
function getSettings(guildId) {
  return { ...DEFAULTS, ...(readStore()[guildId] || {}) };
}
function saveSettings(guildId, settings) {
  const store = readStore();
  store[guildId] = { ...DEFAULTS, ...(store[guildId] || {}), ...settings };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temporary = FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, FILE);
  cache = store;
  return getSettings(guildId);
}
function resetSettings(guildId) {
  const store = readStore();
  store[guildId] = { ...DEFAULTS };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temporary = FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, FILE);
  cache = store;
  return getSettings(guildId);
}
module.exports = { DEFAULTS, getSettings, saveSettings, resetSettings };

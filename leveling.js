const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_FILE = path.join(__dirname, "data", "level-settings.json");
const XP_FILE = path.join(__dirname, "data", "levels.json");
const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  xpPerMessage: 10,
  cooldownSeconds: 60,
  announceChannelId: null
});
let settingsCache;
let xpCache;

function readJson(file, empty) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : empty;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read " + path.basename(file) + ":", error.message);
    return empty;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}
function readSettings() {
  if (!settingsCache) settingsCache = readJson(SETTINGS_FILE, {});
  return settingsCache;
}
function getSettings(guildId) {
  return { ...DEFAULT_SETTINGS, ...(readSettings()[guildId] || {}) };
}
function saveSettings(guildId, settings) {
  const store = readSettings();
  store[guildId] = { ...DEFAULT_SETTINGS, ...(store[guildId] || {}), ...settings };
  writeJson(SETTINGS_FILE, store);
  settingsCache = store;
  return getSettings(guildId);
}
function readXp() {
  if (!xpCache) xpCache = readJson(XP_FILE, {});
  return xpCache;
}
function getRank(guildId, userId) {
  const value = readXp()[guildId]?.[userId] || { xp: 0, lastMessageAt: 0 };
  return { ...value, level: Math.floor(Math.sqrt(Math.max(0, value.xp) / 100)) };
}
function getLeaderboard(guildId, limit = 10) {
  const users = readXp()[guildId] || {};
  return Object.entries(users)
    .map(([userId, value]) => ({ userId, xp: Number(value.xp) || 0, level: Math.floor(Math.sqrt(Math.max(0, Number(value.xp) || 0) / 100)) }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, limit);
}
async function handleMessage(message) {
  if (!message.guild || message.author.bot || !String(message.content || "").trim()) return;
  const settings = getSettings(message.guild.id);
  if (!settings.enabled) return;
  const store = readXp();
  if (!store[message.guild.id]) store[message.guild.id] = {};
  const current = store[message.guild.id][message.author.id] || { xp: 0, lastMessageAt: 0 };
  const now = Date.now();
  if (now - Number(current.lastMessageAt || 0) < settings.cooldownSeconds * 1000) return;
  const oldLevel = Math.floor(Math.sqrt(Math.max(0, current.xp) / 100));
  current.xp = Math.max(0, Number(current.xp) || 0) + settings.xpPerMessage;
  current.lastMessageAt = now;
  const newLevel = Math.floor(Math.sqrt(current.xp / 100));
  store[message.guild.id][message.author.id] = current;
  writeJson(XP_FILE, store);
  xpCache = store;
  if (newLevel > oldLevel && settings.announceChannelId) {
    const channel = await message.guild.channels.fetch(settings.announceChannelId).catch(() => null);
    if (channel?.isTextBased() && channel.isSendable()) {
      await channel.send({
        content: "<@" + message.author.id + "> reached level " + newLevel + "!",
        allowedMentions: { users: [message.author.id], parse: [] }
      }).catch(error => console.error("Could not announce level up:", error.message));
    }
  }
}
module.exports = { DEFAULT_SETTINGS, getSettings, saveSettings, getRank, getLeaderboard, handleMessage };

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "data", "economy.json");
const DEFAULTS = Object.freeze({
  enabled: true,
  dailyMin: 100,
  dailyMax: 250,
  workMin: 25,
  workMax: 100,
  dailyCooldownHours: 24,
  workCooldownMinutes: 60
});
let cache;
function read() {
  if (cache) return cache;
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read economy data:", error.message);
    cache = {};
  }
  return cache;
}
function write(value) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, FILE);
  cache = value;
}
function settings(guildId) {
  return { ...DEFAULTS, ...(read()[guildId]?.settings || {}) };
}
function saveSettings(guildId, config) {
  const value = read();
  value[guildId] = value[guildId] || { users: {} };
  value[guildId].settings = { ...DEFAULTS, ...(value[guildId].settings || {}), ...config };
  if (!value[guildId].users) value[guildId].users = {};
  write(value);
  return settings(guildId);
}
function getUser(guildId, userId) {
  const value = read();
  if (!value[guildId]) value[guildId] = { settings: { ...DEFAULTS }, users: {} };
  if (!value[guildId].users) value[guildId].users = {};
  if (!value[guildId].users[userId]) value[guildId].users[userId] = { balance: 0, dailyAt: 0, workAt: 0 };
  return value[guildId].users[userId];
}
function updateUser(guildId, userId, user) {
  const value = read();
  if (!value[guildId]) value[guildId] = { settings: { ...DEFAULTS }, users: {} };
  if (!value[guildId].users) value[guildId].users = {};
  value[guildId].users[userId] = user;
  write(value);
}
function getBalance(guildId, userId) {
  return Number(getUser(guildId, userId).balance) || 0;
}
function collect(guildId, userId, type) {
  const config = settings(guildId);
  if (!config.enabled) return { error: "Economy is disabled in this server." };
  const user = getUser(guildId, userId);
  const now = Date.now();
  const isDaily = type === "daily";
  const cooldown = isDaily ? config.dailyCooldownHours * 3600000 : config.workCooldownMinutes * 60000;
  const last = Number(user[isDaily ? "dailyAt" : "workAt"]) || 0;
  if (now - last < cooldown) return { error: "Available again <t:" + Math.ceil((last + cooldown) / 1000) + ":R>." };
  const min = isDaily ? config.dailyMin : config.workMin;
  const max = isDaily ? config.dailyMax : config.workMax;
  const amount = Math.floor(Math.random() * (max - min + 1)) + min;
  user.balance = Math.max(0, Number(user.balance) || 0) + amount;
  user[isDaily ? "dailyAt" : "workAt"] = now;
  updateUser(guildId, userId, user);
  return { amount, balance: user.balance };
}
function pay(guildId, fromId, toId, amount) {
  const config = settings(guildId);
  if (!config.enabled) return { error: "Economy is disabled in this server." };
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) return { error: "Amount must be a whole number from 1 to 1,000,000." };
  if (fromId === toId) return { error: "You cannot pay yourself." };
  const from = getUser(guildId, fromId);
  const to = getUser(guildId, toId);
  if ((Number(from.balance) || 0) < amount) return { error: "You do not have enough coins." };
  from.balance = Number(from.balance) - amount;
  to.balance = (Number(to.balance) || 0) + amount;
  const value = read();
  value[guildId] = value[guildId] || { settings: { ...DEFAULTS }, users: {} };
  value[guildId].users[fromId] = from;
  value[guildId].users[toId] = to;
  write(value);
  return { balance: from.balance };
}
module.exports = { DEFAULTS, settings, saveSettings, getBalance, collect, pay };

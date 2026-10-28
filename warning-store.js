const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "data", "warnings.json");
let cache;
function store() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read warnings:", error.message);
    cache = {};
  }
  return cache;
}
function persist(value) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temporary = FILE + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, FILE);
  cache = value;
}
function getWarnings(guildId, userId) {
  const records = store()[guildId] || {};
  return Array.isArray(records[userId]) ? records[userId] : [];
}
function addWarning(guildId, userId, moderatorId, reason) {
  const value = store();
  if (!value[guildId]) value[guildId] = {};
  if (!Array.isArray(value[guildId][userId])) value[guildId][userId] = [];
  const warning = {
    id: crypto.randomUUID(),
    moderatorId,
    reason: String(reason).trim().slice(0, 1000),
    createdAt: Date.now()
  };
  value[guildId][userId].push(warning);
  persist(value);
  return warning;
}
function clearWarnings(guildId, userId) {
  const value = store();
  const count = getWarnings(guildId, userId).length;
  if (value[guildId]) {
    delete value[guildId][userId];
    if (!Object.keys(value[guildId]).length) delete value[guildId];
  }
  persist(value);
  return count;
}
module.exports = { addWarning, clearWarnings, getWarnings };

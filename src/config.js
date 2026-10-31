import fs from "node:fs";
import path from "node:path";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const result = {};
  const source = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    result[match[1]] = value;
  }
  return result;
}

export function loadConfig(root = process.cwd()) {
  const fileValues = parseEnvFile(path.join(root, ".env"));
  const get = (key) => process.env[key] || fileValues[key] || "";
  const token = get("DISCORD_TOKEN").trim();
  const clientId = get("CLIENT_ID").trim();
  const guildId = get("GUILD_ID").trim() || null;
  const dataDir = path.resolve(root, get("DATA_DIR").trim() || "data");
  const logLevel = (get("LOG_LEVEL").trim() || "info").toLowerCase();

  if (!token || token === "your_discord_bot_token") {
    throw new Error("DISCORD_TOKEN is missing or empty. Set it in .env.");
  }
  if (!/^\d{15,22}$/.test(clientId)) {
    throw new Error("CLIENT_ID must be a valid Discord application ID in .env.");
  }
  if (guildId && !/^\d{15,22}$/.test(guildId)) {
    throw new Error("GUILD_ID must be a numeric Discord server ID, or blank.");
  }
  fs.mkdirSync(dataDir, { recursive: true });
  return { token, clientId, guildId, dataDir, logLevel };
}

export function createLogger(level = "info") {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[level] ?? levels.info;
  return Object.fromEntries(Object.entries(levels).map(([name, value]) => [
    name,
    (...args) => {
      if (value < threshold) return;
      const timestamp = new Date().toISOString();
      const message = args.map((item) => item instanceof Error ? item.stack || item.message : String(item)).join(" ");
      const output = `[${timestamp}] [${name.toUpperCase()}] ${message}\n`;
      (value >= levels.warn ? process.stderr : process.stdout).write(output);
    }
  ]));
}

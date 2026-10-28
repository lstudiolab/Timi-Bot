const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const Database = require("better-sqlite3");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "recovery.sqlite");
const LEGACY_PATH = path.join(DATA_DIR, "recovery-backup.json");
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GUILD_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGES_PER_GUILD = 25000;
const STATUS_INTERVAL_MS = 60_000;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, payload BLOB NOT NULL,
    saved_at INTEGER NOT NULL, deleted_at INTEGER,
    PRIMARY KEY (guild_id, channel_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    guild_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, payload BLOB NOT NULL,
    PRIMARY KEY (guild_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS messages_by_guild_time ON messages(guild_id, created_at);
  CREATE INDEX IF NOT EXISTS messages_by_channel_time ON messages(guild_id, channel_id, created_at);
  CREATE TABLE IF NOT EXISTS status_messages (
    guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
    last_update INTEGER NOT NULL DEFAULT 0
  );
`);
const gzip = value => zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 6 });
const ungzip = value => JSON.parse(zlib.gunzipSync(value).toString("utf8"));
const now = () => Date.now();

function usage(guildId) {
  const row = db.prepare(`
    SELECT
      COALESCE((SELECT SUM(length(payload)) FROM channels WHERE guild_id=?),0) +
      COALESCE((SELECT SUM(length(payload)) FROM messages WHERE guild_id=?),0) AS bytes
  `).get(guildId, guildId);
  return Number(row.bytes || 0);
}
function prune(guildId) {
  const cutoff = now() - RETENTION_MS;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE guild_id=? AND created_at < ?").run(guildId, cutoff);
    db.prepare("DELETE FROM channels WHERE guild_id=? AND deleted_at IS NOT NULL AND deleted_at < ?").run(guildId, cutoff);
    const excess = db.prepare("SELECT message_id FROM messages WHERE guild_id=? ORDER BY created_at ASC LIMIT MAX(0,(SELECT COUNT(*) FROM messages WHERE guild_id=?)-?)").all(guildId, guildId, MAX_MESSAGES_PER_GUILD);
    const del = db.prepare("DELETE FROM messages WHERE guild_id=? AND message_id=?");
    for (const item of excess) del.run(guildId, item.message_id);
    // Keep channel configuration; evict oldest archived messages first to enforce the quota.
    while (usage(guildId) > MAX_GUILD_BYTES) {
      const oldest = db.prepare("SELECT message_id FROM messages WHERE guild_id=? ORDER BY created_at ASC LIMIT 1").get(guildId);
      if (!oldest) break;
      db.prepare("DELETE FROM messages WHERE guild_id=? AND message_id=?").run(guildId, oldest.message_id);
    }
  });
  tx();
}
function loadLegacy() {
  if (!fs.existsSync(LEGACY_PATH)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_PATH, "utf8"));
    if (!parsed || !parsed.guilds || typeof parsed.guilds !== "object") return;
    const insertChannel = db.prepare("INSERT OR IGNORE INTO channels(guild_id,channel_id,payload,saved_at,deleted_at) VALUES(?,?,?,?,?)");
    const insertMessage = db.prepare("INSERT OR IGNORE INTO messages(guild_id,message_id,channel_id,created_at,payload) VALUES(?,?,?,?,?)");
    const tx = db.transaction(() => {
      for (const [guildId, data] of Object.entries(parsed.guilds)) {
        for (const [channelId, channel] of Object.entries(data.channels || {})) {
          insertChannel.run(guildId, channelId, gzip(channel), Number(channel.savedAt || now()), channel.deletedAt || null);
        }
        for (const item of (Array.isArray(data.messages) ? data.messages : [])) {
          if (!item?.id || !item.channelId || !Number.isFinite(Number(item.createdAt))) continue;
          insertMessage.run(guildId, String(item.id), String(item.channelId), Number(item.createdAt), gzip(item));
        }
      }
    });
    tx();
    // Preserve the original until the migrated database has been verified and used.
    fs.renameSync(LEGACY_PATH, LEGACY_PATH + ".migrated");
  } catch (error) {
    console.error("Legacy recovery migration failed; the JSON source was preserved:", error.message);
  }
}
loadLegacy();

function serializeChannel(channel) {
  return {
    id: channel.id, name: channel.name, type: channel.type, parentId: channel.parentId || null,
    position: channel.position, topic: "topic" in channel ? channel.topic : null,
    nsfw: "nsfw" in channel ? channel.nsfw : false,
    rateLimitPerUser: "rateLimitPerUser" in channel ? channel.rateLimitPerUser : 0,
    bitrate: "bitrate" in channel ? channel.bitrate : null,
    userLimit: "userLimit" in channel ? channel.userLimit : null,
    permissionOverwrites: [...channel.permissionOverwrites.cache.values()].map(o => ({
      id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString()
    })),
    savedAt: now(), deletedAt: null
  };
}
async function snapshotGuild(guild) {
  // Fetch current channels so the snapshot is not limited to whatever happens to be cached.
  const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
  const put = db.prepare(`INSERT INTO channels(guild_id,channel_id,payload,saved_at,deleted_at)
    VALUES(?,?,?,?,NULL) ON CONFLICT(guild_id,channel_id) DO UPDATE SET
    payload=excluded.payload,saved_at=excluded.saved_at,deleted_at=NULL`);
  const tx = db.transaction(items => {
    for (const channel of items.values()) {
      if (!channel || channel.isThread?.()) continue;
      put.run(guild.id, channel.id, gzip(serializeChannel(channel)), now());
    }
  });
  tx(channels);
  prune(guild.id);
  await updateStorageStatus(guild);
}
async function snapshotChannel(channel) {
  if (!channel.guild || channel.isThread?.()) return;
  db.prepare(`INSERT INTO channels(guild_id,channel_id,payload,saved_at,deleted_at)
    VALUES(?,?,?,?,NULL) ON CONFLICT(guild_id,channel_id) DO UPDATE SET
    payload=excluded.payload,saved_at=excluded.saved_at,deleted_at=NULL`)
    .run(channel.guild.id, channel.id, gzip(serializeChannel(channel)), now());
  prune(channel.guild.id);
  await updateStorageStatus(channel.guild);
}
async function backupMessage(message) {
  if (!message.guild || message.author.bot || message.system || !message.channel?.isTextBased()) return;
  const item = {
    id: message.id, channelId: message.channelId, authorId: message.author.id,
    authorTag: String(message.author.tag || "").slice(0, 100),
    content: String(message.content || "").slice(0, 4000),
    createdAt: Number(message.createdTimestamp), editedAt: message.editedTimestamp || null,
    attachments: [...message.attachments.values()].slice(0, 10).map(file => ({
      name: String(file.name || "attachment").slice(0, 200), url: file.url,
      contentType: file.contentType || null, size: Number(file.size || 0)
    }))
  };
  db.prepare("INSERT OR REPLACE INTO messages(guild_id,message_id,channel_id,created_at,payload) VALUES(?,?,?,?,?)")
    .run(message.guild.id, item.id, item.channelId, item.createdAt, gzip(item));
  prune(message.guild.id);
  await updateStorageStatus(message.guild);
}
function buildChannelOptions(saved, guild) {
  const overwrites = (saved.permissionOverwrites || []).filter(item =>
    item.id === guild.id || guild.roles.cache.has(item.id) || guild.members.cache.has(item.id)
  ).map(item => ({ id: item.id, type: item.type, allow: BigInt(item.allow), deny: BigInt(item.deny) }));
  const options = { name: String(saved.name || "recovered-channel").slice(0,100), type: saved.type,
    permissionOverwrites: overwrites, reason: "Timi recovery: restore saved channel configuration" };
  if ([ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(saved.type)) {
    if (saved.topic) options.topic = String(saved.topic).slice(0,1024);
    options.nsfw = Boolean(saved.nsfw);
    options.rateLimitPerUser = Math.max(0, Number(saved.rateLimitPerUser || 0));
  }
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(saved.type)) {
    if (saved.bitrate) options.bitrate = saved.bitrate;
    if (saved.userLimit) options.userLimit = saved.userLimit;
  }
  if (saved.parentId && guild.channels.cache.has(saved.parentId)) options.parent = saved.parentId;
  return options;
}
async function restoreDeletedChannel(guild, channelId, logChannel) {
  const row = db.prepare("SELECT payload FROM channels WHERE guild_id=? AND channel_id=?").get(guild.id, channelId);
  if (!row) {
    await logChannel?.send?.({content:`Recovery incomplete: no saved configuration for channel ID ${channelId}.`,allowedMentions:{parse:[]}}).catch(()=>{});
    return null;
  }
  const saved = ungzip(row.payload);
  if (guild.channels.cache.has(channelId)) return guild.channels.cache.get(channelId);
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) return null;
  let recreated;
  try {
    recreated = await guild.channels.create(buildChannelOptions(saved, guild));
    if (Number.isInteger(saved.position)) await recreated.setPosition(saved.position).catch(()=>{});
  } catch (error) {
    console.error("Channel recovery failed:", error.message);
    await logChannel?.send?.({content:`Recovery failed for #${saved.name}. Check bot permissions and channel limits.`,allowedMentions:{parse:[]}}).catch(()=>{});
    return null;
  }
  const rows = db.prepare("SELECT payload FROM messages WHERE guild_id=? AND channel_id=? AND created_at>=? ORDER BY created_at ASC")
    .all(guild.id, channelId, now()-RETENTION_MS);
  if (recreated.isTextBased() && recreated.isSendable()) {
    for (const row of rows) {
      const item = ungzip(row.payload);
      const attachmentText = item.attachments?.length
        ? "\\nAttachments (original links may expire): " + item.attachments.map(f=>`${f.name}: ${f.url}`).join(" | ") : "";
      const body = [`[Recovered archive • original message ${item.id} • <t:${Math.floor(item.createdAt/1000)}:F>]`,
        `Author ID: ${item.authorId}`, item.content || "(no text content)", attachmentText].join("\\n").slice(0,1900);
      await recreated.send({content:body,allowedMentions:{parse:[]}}).catch(e=>console.error("Could not repost archive:",e.message));
    }
  }
  db.prepare("UPDATE channels SET deleted_at=? WHERE guild_id=? AND channel_id=?").run(now(),guild.id,channelId);
  await logChannel?.send?.({content:`Recovery complete: recreated #${saved.name} and reposted ${rows.length} archived message(s). These are copies with new IDs; attachment URLs may expire.`,allowedMentions:{parse:[]}}).catch(()=>{});
  await updateStorageStatus(guild);
  return recreated;
}
async function restoreRecentDeletedChannels(guild, ids, logChannel) {
  for (const id of [...new Set(ids)].slice(0, 20)) await restoreDeletedChannel(guild, id, logChannel);
}
function makeBar(ratio) {
  const filled = Math.max(0, Math.min(10, Math.round(ratio * 10)));
  return "█".repeat(filled) + "░".repeat(10-filled);
}
async function updateStorageStatus(guild, force = false) {
  const logChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === "timi-logs");
  if (!logChannel?.isTextBased() || !logChannel.isSendable()) return;
  const previous = db.prepare("SELECT * FROM status_messages WHERE guild_id=?").get(guild.id);
  if (!force && previous && now()-previous.last_update < STATUS_INTERVAL_MS) return;
  const bytes = usage(guild.id);
  const ratio = bytes / MAX_GUILD_BYTES;
  const text = `**Timi recovery storage**\n${makeBar(ratio)} ${(ratio*100).toFixed(1)}%\n**Used:** ${(bytes/1024).toFixed(1)} KB / 4096 KB\n**Available:** ${(Math.max(0,MAX_GUILD_BYTES-bytes)/1024).toFixed(1)} KB\n**Retention:** 7 days • oldest messages are removed first when storage is full.`;
  let message = null;
  if (previous) {
    const channel = await guild.channels.fetch(previous.channel_id).catch(()=>null);
    if (channel?.isTextBased()) message = await channel.messages.fetch(previous.message_id).catch(()=>null);
  }
  if (!message) {
    message = await logChannel.send({content:text,allowedMentions:{parse:[]}}).catch(()=>null);
    if (!message) return;
    await message.pin("Timi recovery storage usage status").catch(()=>{});
  } else {
    await message.edit({content:text,allowedMentions:{parse:[]}}).catch(()=>{});
  }
  db.prepare(`INSERT INTO status_messages(guild_id,channel_id,message_id,last_update) VALUES(?,?,?,?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,last_update=excluded.last_update`)
    .run(guild.id, message.channelId, message.id, now());
}
module.exports = { snapshotGuild, snapshotChannel, backupMessage, restoreRecentDeletedChannels,
  flushPersist: async () => {}, updateStorageStatus };

const fs = require("node:fs");
const path = require("node:path");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "recovery-backup.json");
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES_PER_GUILD = 25_000;
let store = { guilds: {} };
let loaded = false;
let writeQueue = Promise.resolve();
let persistTimer = null;
let dirty = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      if (parsed && parsed.guilds && typeof parsed.guilds === "object") store = parsed;
    }
  } catch (error) {
    console.error("Could not read recovery backup; starting an empty in-memory backup:", error.message);
  }
}

function guildData(guildId) {
  load();
  if (!store.guilds[guildId]) store.guilds[guildId] = { channels: {}, messages: [] };
  const data = store.guilds[guildId];
  if (!data.channels || typeof data.channels !== "object") data.channels = {};
  if (!Array.isArray(data.messages)) data.messages = [];
  return data;
}

function persist() {
  load();
  dirty = true;
  if (persistTimer) return writeQueue;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!dirty) return;
    dirty = false;
    const snapshot = JSON.stringify(store);
    writeQueue = writeQueue.then(async () => {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      const temp = STORE_PATH + ".tmp";
      await fs.promises.writeFile(temp, snapshot, "utf8");
      await fs.promises.rename(temp, STORE_PATH);
    }).catch(error => {
      dirty = true;
      console.error("Could not persist recovery backup:", error.message);
    });
  }, 750);
  return writeQueue;
}

async function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (dirty) {
    dirty = false;
    const snapshot = JSON.stringify(store);
    writeQueue = writeQueue.then(async () => {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      const temp = STORE_PATH + ".tmp";
      await fs.promises.writeFile(temp, snapshot, "utf8");
      await fs.promises.rename(temp, STORE_PATH);
    }).catch(error => {
      dirty = true;
      console.error("Could not persist recovery backup:", error.message);
    });
  }
  await writeQueue;
}

function prune(data) {
  const cutoff = Date.now() - RETENTION_MS;
  data.messages = data.messages.filter(item => item.createdAt >= cutoff).slice(-MAX_MESSAGES_PER_GUILD);
  for (const [id, channel] of Object.entries(data.channels)) {
    if (channel.deletedAt && channel.deletedAt < cutoff) delete data.channels[id];
  }
}

function serializeChannel(channel) {
  const overwrites = [...channel.permissionOverwrites.cache.values()].map(overwrite => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString()
  }));
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId || null,
    position: channel.position,
    topic: "topic" in channel ? channel.topic : null,
    nsfw: "nsfw" in channel ? channel.nsfw : false,
    rateLimitPerUser: "rateLimitPerUser" in channel ? channel.rateLimitPerUser : 0,
    bitrate: "bitrate" in channel ? channel.bitrate : null,
    userLimit: "userLimit" in channel ? channel.userLimit : null,
    permissionOverwrites: overwrites,
    savedAt: Date.now(),
    deletedAt: null
  };
}

async function snapshotGuild(guild) {
  const data = guildData(guild.id);
  for (const channel of guild.channels.cache.values()) {
    if (channel.isThread?.()) continue;
    data.channels[channel.id] = serializeChannel(channel);
  }
  prune(data);
  await flushPersist();
}

async function snapshotChannel(channel) {
  if (!channel.guild || channel.isThread?.()) return;
  const data = guildData(channel.guild.id);
  data.channels[channel.id] = serializeChannel(channel);
  await flushPersist();
}

async function backupMessage(message) {
  if (!message.guild || message.author.bot || message.system || !message.channel?.isTextBased()) return;
  const data = guildData(message.guild.id);
  const item = {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: (message.content || "").slice(0, 4000),
    createdAt: message.createdTimestamp,
    editedAt: message.editedTimestamp || null,
    attachments: [...message.attachments.values()].map(file => ({
      name: file.name,
      url: file.url,
      contentType: file.contentType || null,
      size: file.size
    })).slice(0, 10)
  };
  data.messages.push(item);
  prune(data);
  persist();
}

function buildChannelOptions(saved, guild) {
  const permissionOverwrites = (saved.permissionOverwrites || [])
    .filter(item => item.id === guild.id ||
      guild.roles.cache.has(item.id) ||
      guild.members.cache.has(item.id))
    .map(item => ({
      id: item.id,
      type: item.type,
      allow: BigInt(item.allow),
      deny: BigInt(item.deny)
    }));
  const options = {
    name: saved.name,
    type: saved.type,
    permissionOverwrites,
    reason: "Timi recovery: recreate channel from its saved configuration"
  };
  if (saved.type === ChannelType.GuildText || saved.type === ChannelType.GuildAnnouncement) {
    if (saved.topic) options.topic = saved.topic;
    options.nsfw = Boolean(saved.nsfw);
    options.rateLimitPerUser = saved.rateLimitPerUser || 0;
  }
  if (saved.type === ChannelType.GuildVoice || saved.type === ChannelType.GuildStageVoice) {
    if (saved.bitrate) options.bitrate = saved.bitrate;
    if (saved.userLimit) options.userLimit = saved.userLimit;
  }
  if (saved.parentId && guild.channels.cache.has(saved.parentId)) options.parent = saved.parentId;
  return options;
}

async function restoreDeletedChannel(guild, channelId, logChannel) {
  const data = guildData(guild.id);
  const saved = data.channels[channelId];
  if (!saved) {
    if (logChannel?.isSendable()) await logChannel.send(
      `Recovery incomplete: no saved channel configuration exists for deleted channel ID ${channelId}. Backups only start after this feature is deployed.`
    ).catch(() => {});
    return null;
  }

  const existing = guild.channels.cache.get(channelId);
  if (existing) return existing;
  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    if (logChannel?.isSendable()) await logChannel.send("Recovery failed: Timi needs Manage Channels to recreate deleted channels.").catch(() => {});
    return null;
  }

  let recreated;
  try {
    recreated = await guild.channels.create(buildChannelOptions(saved, guild));
    if (Number.isInteger(saved.position)) {
      await recreated.setPosition(saved.position).catch(() => {});
    }
  } catch (error) {
    console.error(`Could not recreate channel ${saved.name}:`, error.message);
    if (logChannel?.isSendable()) await logChannel.send(
      `Recovery failed for #${saved.name}: ${error.message}. Check Timi's permissions and channel/category limits.`
    ).catch(() => {});
    return null;
  }

  const archived = data.messages
    .filter(item => item.channelId === channelId && item.createdAt >= Date.now() - RETENTION_MS)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (recreated.isTextBased() && recreated.isSendable()) {
    for (let i = 0; i < archived.length; i += 10) {
      const batch = archived.slice(i, i + 10);
      for (const item of batch) {
        const attachmentText = item.attachments.length
          ? "\\nAttachments: " + item.attachments.map(file => `${file.name}: ${file.url}`).join(" | ")
          : "";
        const body = [
          `[Recovered archive • original message ${item.id} • <t:${Math.floor(item.createdAt / 1000)}:F>]`,
          `Author ID: ${item.authorId}`,
          item.content || "(no text content)",
          attachmentText
        ].join("\\n").slice(0, 1900);
        await recreated.send({ content: body, allowedMentions: { parse: [] } }).catch(error => {
          console.error("Could not repost archived message:", error.message);
        });
      }
    }
  }

  saved.deletedAt = Date.now();
  await flushPersist();
  if (logChannel?.isSendable()) {
    await logChannel.send(
      `Recovery complete: recreated #${saved.name}. Reposted ${archived.length} archived message(s) from the last 7 days. These are archival copies with new message IDs; attachment links may expire, and messages sent before backup was enabled cannot be recovered.`
    ).catch(() => {});
  }
  return recreated;
}

async function restoreRecentDeletedChannels(guild, deletedIds, logChannel) {
  const uniqueIds = [...new Set(deletedIds)];
  for (const id of uniqueIds) await restoreDeletedChannel(guild, id, logChannel);
}

module.exports = { snapshotGuild, snapshotChannel, backupMessage, restoreRecentDeletedChannels, flushPersist };

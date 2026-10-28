require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes
} = require("discord.js");

const botProtection = require("./bot-protection");
const ticketPanel = require("./commands/ticketpanel");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) {
  console.error("Missing DISCORD_TOKEN. Add it to your local .env file.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const commands = new Map();
const commandsPath = path.join(__dirname, "commands");

if (fs.existsSync(commandsPath)) {
  for (const file of fs.readdirSync(commandsPath)) {
    if (!file.endsWith(".js")) continue;
    const command = require(path.join(commandsPath, file));
    if (command.data && typeof command.execute === "function") {
      commands.set(command.data.name, command);
    }
  }
}

async function registerSlashCommands() {
  if (!clientId || !/^\d+$/.test(clientId)) {
    console.error("CLIENT_ID is missing or invalid. Slash commands were not registered.");
    return;
  }
  if (guildId && !/^\d+$/.test(guildId)) {
    console.error("GUILD_ID is invalid. Use your test server ID or leave GUILD_ID blank.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, {
    body: [...commands.values()].map(command => command.data.toJSON())
  });

  console.log(`Registered ${commands.size} slash command(s) ${guildId ? "to the test server" : "globally"}.`);
}

async function ensurePrivateTimiChannel(guild) {
  const botMember = guild.members.me || await guild.members.fetch(client.user.id);
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    console.error(`Cannot ensure private #timi in ${guild.name}: Manage Channels is missing.`);
    return null;
  }

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: guild.ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages
      ]
    }
  ];

  const existing = guild.channels.cache.find(
    channel => channel.type === ChannelType.GuildText && channel.name === "timi"
  );

  if (existing) {
    // Repair access on an existing #timi instead of accidentally leaving it public.
    await existing.permissionOverwrites.set(
      overwrites,
      "Enforce owner-only access to Timi moderation channel"
    );
    return existing;
  }

  return guild.channels.create({
    name: "timi",
    type: ChannelType.GuildText,
    topic: "Private moderation alerts and security decisions for the server owner.",
    permissionOverwrites: overwrites,
    reason: "Create private owner-only Timi moderation channel"
  });
}

async function initializeGuild(guild) {
  try {
    // Warm the settings cache during startup/join, not on the first live message.
    commands.get("moderationconfig")?.getSettings?.(guild);
    await ensurePrivateTimiChannel(guild);
  } catch (error) {
    console.error(`Could not ensure private #timi in ${guild.name}:`, error.message);
  }
}

client.once("ready", async () => {
  console.log(`Timi is online as ${client.user.tag}`);
  await Promise.allSettled([...client.guilds.cache.values()].map(initializeGuild));
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("Could not register slash commands:", error.message);
  }
});

client.on("guildCreate", guild => {
  initializeGuild(guild);
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.customId?.startsWith("botguard:")) {
      await botProtection.handleInteraction(interaction, client);
      return;
    }

    if (interaction.customId?.startsWith("ticket:")) {
      await ticketPanel.handleInteraction(interaction, client);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (command) await command.execute(interaction, client);
      return;
    }

    if (interaction.customId?.startsWith("modpanel:")) {
      const command = commands.get("moderationconfig");
      if (command?.handleInteraction) {
        await command.handleInteraction(interaction, client);
      }
    }
  } catch (error) {
    console.error("Interaction failed:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Timi could not complete that action. Check the bot console for details.",
        ephemeral: true
      }).catch(() => {});
    }
  }
});

const joinBursts = new Map();
const RAID_JOIN_WINDOW_MS = 10_000;
const RAID_JOIN_THRESHOLD = 6;
const RAID_ALERT_COOLDOWN_MS = 60_000;
const raidAlertTimes = new Map();

async function monitorJoinBurst(member) {
  if (member.user.bot) return;
  const guildId = member.guild.id;
  const now = Date.now();
  const joins = (joinBursts.get(guildId) || []).filter(timestamp => now - timestamp <= RAID_JOIN_WINDOW_MS);
  joins.push(now);
  joinBursts.set(guildId, joins);

  if (joins.length < RAID_JOIN_THRESHOLD) return;
  const lastAlert = raidAlertTimes.get(guildId) || 0;
  if (now - lastAlert < RAID_ALERT_COOLDOWN_MS) return;
  raidAlertTimes.set(guildId, now);

  const channel = member.guild.channels.cache.find(
    item => item.type === ChannelType.GuildText && item.name === "timi"
  );
  if (!channel?.isTextBased() || !channel.isSendable()) return;

  await channel.send({
    content: `Security alert: ${joins.length} human members joined within ${RAID_JOIN_WINDOW_MS / 1000} seconds. This may indicate a raid. Timi has not automatically punished anyone; review the server's verification and invite settings.`,
    allowedMentions: { parse: [] }
  }).catch(error => console.error("Could not send raid alert:", error.message));
}

client.on("guildMemberAdd", member => {
  botProtection.onGuildMemberAdd(member, client).catch(error => {
    console.error("Bot protection failed:", error.message);
  });
  monitorJoinBurst(member).catch(error => {
    console.error("Join-burst monitoring failed:", error.message);
  });
});

const spamState = new Map();
const SPAM_WINDOW_MS = 8_000;
const DUPLICATE_WINDOW_MS = 20_000;
const MAX_MENTIONS_PER_MESSAGE = 5;
const MAX_TRACKED_MESSAGES = 100;
const CLEANUP_EVERY_MESSAGES = 2_000;
let processedMessages = 0;

function normalizeContent(content) {
  return content
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, "<mention>")
    .replace(/\s+/g, " ")
    .replace(/[\p{P}\p{S}]/gu, "")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aWords = new Set(a.split(" ").filter(Boolean));
  const bWords = new Set(b.split(" ").filter(Boolean));
  if (!aWords.size || !bWords.size) return 0;

  let intersection = 0;
  for (const word of aWords) {
    if (bWords.has(word)) intersection++;
  }

  return intersection / (aWords.size + bWords.size - intersection);
}

function stateKey(guildId, channelId, userId) {
  return `${guildId}:${channelId}:${userId}`;
}

function pruneQueue(queue, cutoff) {
  let removeCount = 0;
  while (removeCount < queue.length && queue[removeCount].time < cutoff) {
    removeCount++;
  }
  if (removeCount) queue.splice(0, removeCount);
}

async function sendModerationLog(guild, settings, content) {
  if (!settings.logChannelId) return;
  const channel = guild.channels.cache.get(settings.logChannelId);
  if (!channel?.isTextBased() || !channel.isSendable()) return;
  await channel.send({ content }).catch(error => {
    console.error("Could not send moderation log:", error.message);
  });
}

async function enforceSpam(message, settings, reason, recentIds) {
  const member = message.member;
  if (!member || member.id === client.user.id) return;

  const permissions = member.permissions;
  if (permissions.has(PermissionFlagsBits.ManageMessages) ||
      permissions.has(PermissionFlagsBits.Administrator)) return;

  const botMember = message.guild.members.me;
  if (!botMember) return;

  // Delete only the messages actually observed in this channel; bulk delete is capped at 100.
  const messageIds = [...new Set(recentIds)].slice(-MAX_TRACKED_MESSAGES);
  if (botMember.permissions.has(PermissionFlagsBits.ManageMessages)) {
    await message.channel.bulkDelete(messageIds, true).catch(async () => {
      await message.delete().catch(() => {});
    });
  } else {
    await message.delete().catch(() => {});
  }

  let action = "messages deleted";
  try {
    if (settings.sanction === "timeout" &&
        botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await member.timeout(
        settings.timeoutMinutes * 60_000,
        `Timi anti-spam: ${reason}`
      );
      action = `timed out for ${settings.timeoutMinutes} minute(s)`;
    } else if (settings.sanction === "kick" &&
               botMember.permissions.has(PermissionFlagsBits.KickMembers)) {
      await member.kick(`Timi anti-spam: ${reason}`);
      action = "kicked";
    } else if (settings.sanction === "ban" &&
               botMember.permissions.has(PermissionFlagsBits.BanMembers)) {
      await member.ban({ reason: `Timi anti-spam: ${reason}` });
      action = "banned";
    }
  } catch (error) {
    console.error("Anti-spam sanction failed:", error.message);
    action = "messages deleted; sanction failed (check bot role and permissions)";
  }

  await sendModerationLog(
    message.guild,
    settings,
    `Anti-spam action: ${action}. Member: <@${member.id}>. Channel: <#${message.channelId}>. Reason: ${reason}.`
  );
}

client.on("messageCreate", async message => {
  try {
    // Cheap exits first; avoid disk access, cache scans, and content normalization for irrelevant messages.
    if (!message.guild || message.author.bot) return;

    const moderation = commands.get("moderationconfig");
    if (!moderation?.getSettings) return;

    const member = message.member;
    if (!member) return;
    if (member.permissions.has(PermissionFlagsBits.ManageMessages) ||
        member.permissions.has(PermissionFlagsBits.Administrator)) return;

    // getSettings is memory-cached; it does not synchronously read JSON for each message.
    const settings = moderation.getSettings(message.guild);
    if (!settings.enabled) return;

    const now = Date.now();
    const key = stateKey(message.guild.id, message.channelId, message.author.id);
    let state = spamState.get(key);
    if (!state) {
      state = { recent: [], fingerprints: [], links: [] };
      spamState.set(key, state);
    }

    pruneQueue(state.recent, now - SPAM_WINDOW_MS);
    pruneQueue(state.fingerprints, now - DUPLICATE_WINDOW_MS);
    pruneQueue(state.links, now - SPAM_WINDOW_MS);

    state.recent.push({ id: message.id, time: now });
    if (state.recent.length > MAX_TRACKED_MESSAGES) {
      state.recent.splice(0, state.recent.length - MAX_TRACKED_MESSAGES);
    }

    const content = normalizeContent(message.content || "");
    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    const linkCount = (message.content.match(/https?:\/\//gi) || []).length;
    let reason = null;

    if (state.recent.length >= Math.max(2, settings.maxMessageCount)) {
      reason = `message burst (${state.recent.length} messages in ${SPAM_WINDOW_MS / 1000} seconds in one channel)`;
    }

    if (!reason && content.length >= 4) {
      for (const item of state.fingerprints) {
        if (similarity(content, item.content) >= 0.88) {
          reason = "repeated or near-identical message";
          break;
        }
      }
    }

    if (!reason && mentionCount >= MAX_MENTIONS_PER_MESSAGE) {
      reason = `mention spam (${mentionCount} mentions in one message)`;
    }

    if (!reason && linkCount >= 4) {
      reason = `link spam (${linkCount} links in one message)`;
    }

    if (!reason && linkCount > 0) {
      state.links.push({ time: now, count: linkCount });
      let totalLinks = 0;
      for (const item of state.links) totalLinks += item.count;
      if (totalLinks >= 5) reason = `rapid link posting (${totalLinks} links)`;
    }

    if (reason) {
      const recentIds = state.recent.map(item => item.id);
      spamState.delete(key);
      await enforceSpam(message, settings, reason, recentIds);
      return;
    }

    if (content.length >= 4) {
      state.fingerprints.push({ content, time: now });
      if (state.fingerprints.length > 50) {
        state.fingerprints.splice(0, state.fingerprints.length - 50);
      }
    }
    if (state.links.length > 50) {
      state.links.splice(0, state.links.length - 50);
    }

    // Periodically prune stale users; no timer/interval is needed.
    processedMessages++;
    if (processedMessages >= CLEANUP_EVERY_MESSAGES) {
      processedMessages = 0;
      const recentCutoff = now - SPAM_WINDOW_MS;
      const duplicateCutoff = now - DUPLICATE_WINDOW_MS;
      for (const [stateId, entry] of spamState) {
        pruneQueue(entry.recent, recentCutoff);
        pruneQueue(entry.fingerprints, duplicateCutoff);
        pruneQueue(entry.links, recentCutoff);
        if (!entry.recent.length && !entry.fingerprints.length && !entry.links.length) {
          spamState.delete(stateId);
        }
      }
    }
  } catch (error) {
    console.error("Anti-spam processing failed:", error.message);
  }
});

client.on("error", error => {
  console.error("Discord client error:", error);
});

client.login(token).catch(error => {
  console.error("Timi could not log in. Check DISCORD_TOKEN and try again.");
  console.error(error.message);
  process.exit(1);
});

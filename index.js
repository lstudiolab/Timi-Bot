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
const recoveryBackup = require("./recovery-backup");
const securitySettings = require("./security-settings");
const leveling = require("./leveling");
const eventLogs = require("./log-settings");

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
  await botProtection.recoverPending(client).catch(error => console.error("Could not recover interrupted bot approvals:", error.message));
  await Promise.allSettled([...client.guilds.cache.values()].map(async guild => {
    await initializeGuild(guild);
    await recoveryBackup.snapshotGuild(guild);
  }));
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("Could not register slash commands:", error.message);
  }
});

client.on("guildCreate", guild => {
  initializeGuild(guild);
  recoveryBackup.snapshotGuild(guild).catch(error => console.error("Initial recovery snapshot failed:", error.message));
});

client.on("channelCreate", channel => {
  recoveryBackup.snapshotChannel(channel).catch(error => console.error("Channel backup failed:", error.message));
  if (channel.guild) eventLogs.log(channel.guild, "channelChanges", "Channel created: #" + channel.name + " (" + channel.id + ").");
});

client.on("channelUpdate", (oldChannel, newChannel) => {
  recoveryBackup.snapshotChannel(newChannel).catch(error => console.error("Channel backup update failed:", error.message));
  if (newChannel.guild) {
    const changedName = oldChannel.name !== newChannel.name;
    const changedTopic = oldChannel.topic !== newChannel.topic;
    eventLogs.log(newChannel.guild, "channelChanges",
      "Channel updated: #" + newChannel.name + " (" + newChannel.id + ")." +
      (changedName ? " Previous name: #" + oldChannel.name + "." : "") +
      (changedTopic ? " Topic changed." : " Channel properties or permissions may have changed."));
  }
});

// Archive messages continuously; the recovery module retains the most recent seven days.
client.on("messageCreate", message => {
  recoveryBackup.backupMessage(message).catch(error => console.error("Message backup failed:", error.message));
});

client.on("messageDelete", message => {
  if (!message.guild || message.author?.bot) return;
  const content = String(message.content || "[message content unavailable]").slice(0, 700);
  eventLogs.log(message.guild, "messageDeletes",
    "Message deleted in <#" + message.channelId + "> by " +
    (message.author ? message.author.tag + " (" + message.author.id + ")" : "an unknown user") +
    ". Content: " + content);
});

client.on("messageUpdate", (oldMessage, newMessage) => {
  const guild = newMessage.guild || oldMessage.guild;
  if (!guild || newMessage.author?.bot) return;
  if (oldMessage.content === newMessage.content) return;
  const before = String(oldMessage.content || "[old content unavailable]").slice(0, 600);
  const after = String(newMessage.content || "[empty message]").slice(0, 600);
  eventLogs.log(guild, "messageEdits",
    "Message edited in <#" + newMessage.channelId + "> by " +
    (newMessage.author ? newMessage.author.tag + " (" + newMessage.author.id + ")" : "unknown user") +
    ". Before: " + before + ". After: " + after);
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

const NEW_ACCOUNT_ALERT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VERY_NEW_ACCOUNT_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const NEW_ACCOUNT_TIMEOUT_MS = 10 * 60 * 1000;

async function monitorNewAccount(member) {
  if (member.user.bot) return;

  const settings = securitySettings.getSettings(member.guild.id);
  const accountAgeMs = Date.now() - member.user.createdTimestamp;
  if (accountAgeMs >= settings.newAccountAlertDays * 24 * 60 * 60 * 1000) return;

  const ageHours = Math.max(0, Math.floor(accountAgeMs / (60 * 60 * 1000)));
  const ageText = ageHours < 24
    ? `${ageHours} hour(s)`
    : `${Math.floor(ageHours / 24)} day(s)`;
  let action = "flagged for moderator review";

  // Very recently created accounts are temporarily timed out to reduce the
  // chance of immediate spam or coordinated disruption. This is not a ban.
  if (settings.timeoutNewAccounts && accountAgeMs < settings.veryNewAccountDays * 24 * 60 * 60 * 1000) {
    const botMember = member.guild.members.me;
    if (botMember?.permissions.has(PermissionFlagsBits.ModerateMembers) &&
        member.moderatable) {
      try {
        await member.timeout(
          settings.newAccountTimeoutMinutes * 60 * 1000,
          "Timi security: newly created account; temporary review timeout"
        );
        action = "temporarily timed out for " + settings.newAccountTimeoutMinutes + " minutes";
      } catch (error) {
        console.error("Could not apply new-account timeout:", error.message);
      }
    } else {
      action = "flagged; timeout unavailable because of bot permissions or role hierarchy";
    }
  }

  const channel = member.guild.channels.cache.find(
    item => item.type === ChannelType.GuildText && item.name === "timi"
  );
  if (!channel?.isTextBased() || !channel.isSendable()) return;

  await channel.send({
    content: `New-account security alert: <@${member.id}> joined with an account approximately ${ageText} old. Account created: <t:${Math.floor(member.user.createdTimestamp / 1000)}:F>. Action: ${action}. Review the account and server audit logs before granting roles or access.`,
    allowedMentions: { parse: [] }
  }).catch(error => console.error("Could not send new-account alert:", error.message));
}

async function monitorJoinBurst(member) {
  if (member.user.bot) return;
  const guildId = member.guild.id;
  const settings = securitySettings.getSettings(guildId);
  if (!settings.joinBurstEnabled) return;
  const windowMs = settings.joinWindowSeconds * 1000;
  const now = Date.now();
  const joins = (joinBursts.get(guildId) || []).filter(timestamp => now - timestamp <= windowMs);
  joins.push(now);
  joinBursts.set(guildId, joins);

  if (joins.length < settings.joinThreshold) return;
  const lastAlert = raidAlertTimes.get(guildId) || 0;
  if (now - lastAlert < RAID_ALERT_COOLDOWN_MS) return;
  raidAlertTimes.set(guildId, now);

  const channel = member.guild.channels.cache.find(
    item => item.type === ChannelType.GuildText && item.name === "timi"
  );
  if (!channel?.isTextBased() || !channel.isSendable()) return;

  await channel.send({
    content: `Security alert: ${joins.length} human members joined within ${settings.joinWindowSeconds} seconds. This may indicate a raid. Timi has not automatically punished anyone; review the server's verification and invite settings.`,
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
  monitorNewAccount(member).catch(error => {
    console.error("New-account monitoring failed:", error.message);
  });
  commands.get("welcomeconfig")?.onMemberJoin?.(member).catch(error => {
    console.error("Welcome message failed:", error.message);
  });
  eventLogs.log(member.guild, "memberJoins",
    "Member joined: " + member.user.tag + " (" + member.id + ").");
});
client.on("guildMemberRemove", member => {
  eventLogs.log(member.guild, "memberLeaves",
    "Member left: " + member.user.tag + " (" + member.id + ").");
});

client.on("guildMemberUpdate", (oldMember, newMember) => {
  const oldRoles = new Set(oldMember.roles.cache.keys());
  const newRoles = new Set(newMember.roles.cache.keys());
  const added = [...newRoles].filter(id => !oldRoles.has(id));
  const removed = [...oldRoles].filter(id => !newRoles.has(id));
  if (!added.length && !removed.length) return;
  const changes = [];
  if (added.length) changes.push("added " + added.map(id => "<@&" + id + ">").join(", "));
  if (removed.length) changes.push("removed " + removed.map(id => "<@&" + id + ">").join(", "));
  eventLogs.log(newMember.guild, "roleChanges",
    "Roles changed for " + newMember.user.tag + " (" + newMember.id + "): " + changes.join("; ") + ".");
});

client.on("guildRoleCreate", role => {
  eventLogs.log(role.guild, "roleChanges", "Role created: " + role.name + " (" + role.id + ").");
});
client.on("guildRoleDelete", role => {
  eventLogs.log(role.guild, "roleChanges", "Role deleted: " + role.name + " (" + role.id + ").");
});
client.on("guildRoleUpdate", (oldRole, newRole) => {
  eventLogs.log(newRole.guild, "roleChanges",
    "Role updated: " + newRole.name + " (" + newRole.id + "); role name or permissions may have changed.");
});
client.on("guildBanAdd", ban => {
  eventLogs.log(ban.guild, "banEvents", "Member banned: " + ban.user.tag + " (" + ban.user.id + ").");
});
client.on("guildBanRemove", ban => {
  eventLogs.log(ban.guild, "banEvents", "Member unbanned: " + ban.user.tag + " (" + ban.user.id + ").");
});

const channelDeletionHistory = new Map();
const CHANNEL_DELETE_WINDOW_MS = 60_000;
const CHANNEL_DELETE_THRESHOLD = 3;
const CHANNEL_DELETE_TIMEOUT_MS = 60 * 60 * 1000;

async function handleChannelDeletion(channel) {
  if (!channel.guild) return;
  const guild = channel.guild;
  const security = securitySettings.getSettings(guild.id);

  const botMember = guild.members.me;
  if (!botMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    console.warn(`Cannot attribute deleted channels in ${guild.name}: View Audit Log permission is missing.`);
    return;
  }

  // Audit log entries can arrive slightly after the channelDelete event.
  await new Promise(resolve => setTimeout(resolve, 1_200));

  let entry;
  try {
    const logs = await guild.fetchAuditLogs({ type: 12, limit: 6 });
    entry = logs.entries.find(item =>
      item.target?.id === channel.id &&
      Date.now() - item.createdTimestamp < 15_000
    );
  } catch (error) {
    console.error("Could not read channel deletion audit log:", error.message);
    return;
  }

  const actorId = entry?.executor?.id;
  if (!actorId || actorId === client.user.id || actorId === guild.ownerId) return;

  const actor = await guild.members.fetch(actorId).catch(() => null);
  if (!actor || actor.user.bot) return;

  const now = Date.now();
  const key = `${guild.id}:${actor.id}`;
  const history = (channelDeletionHistory.get(key) || [])
    .filter(item => now - item.time <= security.channelDeleteWindowSeconds * 1000);
  history.push({ time: now, channelId: channel.id, channelName: channel.name });
  channelDeletionHistory.set(key, history);

  const logChannel = guild.channels.cache.find(
    item => item.type === ChannelType.GuildText && item.name === "timi"
  );
  if (logChannel?.isTextBased() && logChannel.isSendable()) {
    await logChannel.send({
      content: `Security alert: <@${actor.id}> deleted channel ${channel.name} (${channel.id}). Count: ${history.length} in ${security.channelDeleteWindowSeconds} seconds.`,
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }

  if (!security.antiNukeEnabled || history.length < security.channelDeleteThreshold) return;

  // Once a deletion burst is confirmed, recreate channels and replay archived messages.
  await recoveryBackup.restoreRecentDeletedChannels(
    guild,
    history.map(item => item.channelId),
    logChannel
  );

  // Fail closed: only quarantine members whose highest role is below Timi's.
  // The server owner is always exempt. This avoids pretending Timi can
  // enforce actions against members above its role in Discord's hierarchy.
  if (!actor.moderatable || !botMember.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    if (logChannel?.isTextBased() && logChannel.isSendable()) {
      await logChannel.send({
        content: `Critical security alert: <@${actor.id}> reached the channel-deletion threshold, but Timi could not quarantine them because of missing permissions or role hierarchy. Manually review the audit log immediately.`,
        allowedMentions: { parse: [] }
      }).catch(() => {});
    }
    channelDeletionHistory.delete(key);
    return;
  }

  try {
    await actor.timeout(
      security.antiNukeTimeoutMinutes * 60 * 1000,
      `Timi anti-nuke: deleted ${history.length} channels within ${security.channelDeleteWindowSeconds} seconds`
    );

    if (logChannel?.isTextBased() && logChannel.isSendable()) {
      await logChannel.send({
        content: `Anti-nuke action: <@${actor.id}> was timed out for ${security.antiNukeTimeoutMinutes} minutes after deleting ${history.length} channels in ${security.channelDeleteWindowSeconds} seconds. No roles were changed automatically; review the audit log before taking further action.`,
        allowedMentions: { parse: [] }
      }).catch(() => {});
    }
  } catch (error) {
    console.error("Anti-nuke quarantine failed:", error.message);
    if (logChannel?.isTextBased() && logChannel.isSendable()) {
      await logChannel.send({
        content: `Critical security alert: Timi could not complete quarantine for <@${actor.id}>. Error: ${error.message}`,
        allowedMentions: { parse: [] }
      }).catch(() => {});
    }
  } finally {
    channelDeletionHistory.delete(key);
  }
}

client.on("channelDelete", channel => {
  handleChannelDeletion(channel).catch(error => {
    console.error("Anti-nuke channel deletion handler failed:", error.message);
  });
});

const spamState = new Map();
const SPAM_WINDOW_MS = 8_000;
const DUPLICATE_WINDOW_MS = 20_000;
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
  await channel.send({ content, allowedMentions: { parse: [] } }).catch(error => {
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
    if ((settings.exemptChannelIds || []).includes(message.channelId)) return;
    if ((settings.exemptRoleIds || []).some(roleId => member.roles.cache.has(roleId))) return;

    const now = Date.now();
    const actionWindowMs = Math.max(1, Math.min(60, Number(settings.actionDurationSeconds || 3))) * 1000;
    const key = stateKey(message.guild.id, message.channelId, message.author.id);
    let state = spamState.get(key);
    if (!state) {
      state = { recent: [], fingerprints: [], links: [] };
      spamState.set(key, state);
    }

    pruneQueue(state.recent, now - actionWindowMs);
    pruneQueue(state.fingerprints, now - Math.max(5, Math.min(120, Number(settings.duplicateWindowSeconds || 20))) * 1000);
    pruneQueue(state.links, now - actionWindowMs);

    state.recent.push({ id: message.id, time: now });
    if (state.recent.length > MAX_TRACKED_MESSAGES) {
      state.recent.splice(0, state.recent.length - MAX_TRACKED_MESSAGES);
    }

    const content = normalizeContent(message.content || "");
    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    const linkCount = (message.content.match(/https?:\/\//gi) || []).length;
    let reason = null;

    if (state.recent.length >= Math.max(2, settings.maxMessageCount)) {
      reason = `message burst (${state.recent.length} messages in ${actionWindowMs / 1000} seconds in one channel)`;
    }

    if (!reason && content.length >= 4) {
      for (const item of state.fingerprints) {
        if (similarity(content, item.content) >= Number(settings.similarityThreshold || 0.88)) {
          reason = "repeated or near-identical message";
          break;
        }
      }
    }

    if (!reason && mentionCount >= Math.max(1, Number(settings.maxMentionsPerMessage || 5))) {
      reason = `mention spam (${mentionCount} mentions in one message)`;
    }

    if (!reason && linkCount >= Math.max(1, Number(settings.maxLinksPerMessage || 4))) {
      reason = `link spam (${linkCount} links in one message)`;
    }

    if (!reason && linkCount > 0) {
      state.links.push({ time: now, count: linkCount });
      let totalLinks = 0;
      for (const item of state.links) totalLinks += item.count;
      if (totalLinks >= Math.max(2, Number(settings.maxLinksPerWindow || 5))) reason = `rapid link posting (${totalLinks} links)`;
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

    await leveling.handleMessage(message);

    // Periodically prune stale users; no timer/interval is needed.
    processedMessages++;
    if (processedMessages >= CLEANUP_EVERY_MESSAGES) {
      processedMessages = 0;
      const recentCutoff = now - 60_000;
      const duplicateCutoff = now - 120_000;
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

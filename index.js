require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes
} = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) {
  console.error("Missing DISCORD_TOKEN. Add it to your local .env file.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const commands = new Map();
const commandsPath = path.join(__dirname, "commands");

if (fs.existsSync(commandsPath)) {
  for (const file of fs.readdirSync(commandsPath).filter(name => name.endsWith(".js"))) {
    const command = require(path.join(commandsPath, file));
    if (command.data && command.execute) {
      commands.set(command.data.name, command);
    }
  }
}

async function registerSlashCommands() {
  if (!clientId || !/^\d+$/.test(clientId)) {
    console.error("CLIENT_ID is missing or invalid. Put your Discord application ID in .env; slash commands were not registered.");
    return;
  }
  if (guildId && !/^\d+$/.test(guildId)) {
    console.error("GUILD_ID is invalid. Put your test server ID in .env or leave GUILD_ID blank; slash commands were not registered.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, {
    body: [...commands.values()].map(command => command.data.toJSON())
  });

  console.log(
    `Registered ${commands.size} slash command(s) ${guildId ? `to test server ${guildId}` : "globally"}.`
  );
}

client.once("ready", async () => {
  console.log(`Timi is online as ${client.user.tag}`);
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("Could not register slash commands:", error.message);
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (command) await command.execute(interaction, client);
      return;
    }

    if (
      interaction.customId?.startsWith("modpanel:") &&
      commands.has("moderation-panel")
    ) {
      await commands.get("moderation-panel").handleInteraction(interaction, client);
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

const spamState = new Map();
const SPAM_WINDOW_MS = 8000;
const DUPLICATE_WINDOW_MS = 20000;
const MAX_MENTIONS_PER_MESSAGE = 5;

function normalizeContent(content) {
  return content
    .toLowerCase()
    .replace(/https?:\\/\\/\\S+/g, "<url>")
    .replace(/<@!?\\d+>|<@&\\d+>|<#\\d+>/g, "<mention>")
    .replace(/\\s+/g, " ")
    .replace(/[\\p{P}\\p{S}]/gu, "")
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aa = new Set(a.split(" ").filter(Boolean));
  const bb = new Set(b.split(" ").filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const word of aa) if (bb.has(word)) intersection++;
  return intersection / (aa.size + bb.size - intersection);
}

function spamKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function sendModerationLog(guild, settings, content) {
  if (!settings.logChannelId) return;
  try {
    const channel = guild.channels.cache.get(settings.logChannelId)
      || await guild.channels.fetch(settings.logChannelId);
    if (channel?.isTextBased()) await channel.send({ content }).catch(() => {});
  } catch (error) {
    console.error("Could not send moderation log:", error.message);
  }
}

async function enforceSpam(message, settings, reason, recentMessages) {
  const member = message.member;
  if (!member || member.id === message.client.user.id) return;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages) ||
      member.permissions.has(PermissionFlagsBits.Administrator)) return;

  const me = message.guild.members.me;
  if (!me) return;

  const ids = [...new Set([...recentMessages, message.id])];
  if (me.permissions.has(PermissionFlagsBits.ManageMessages)) {
    const deletable = ids.slice(0, 100);
    await message.channel.bulkDelete(deletable, true).catch(async () => {
      await message.delete().catch(() => {});
    });
  } else {
    await message.delete().catch(() => {});
  }

  let action = "messages deleted";
  try {
    if (settings.sanction === "timeout" &&
        me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await member.timeout(settings.timeoutMinutes * 60_000, `Timi anti-spam: ${reason}`);
      action = `timed out for ${settings.timeoutMinutes} minute(s)`;
    } else if (settings.sanction === "kick" &&
        me.permissions.has(PermissionFlagsBits.KickMembers)) {
      await member.kick(`Timi anti-spam: ${reason}`);
      action = "kicked";
    } else if (settings.sanction === "ban" &&
        me.permissions.has(PermissionFlagsBits.BanMembers)) {
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
    `Anti-spam action: ${action}. Member: <@! ${member.id}>. Reason: ${reason}.`
      .replace("<@! ", "<@!")
  );
}

client.on("messageCreate", async message => {
  try {
    if (!message.guild || message.author.id === client.user?.id) return;
    const panel = commands.get("moderation-panel");
    if (!panel?.getSettings) return;
    const settings = panel.getSettings(message.guild);
    if (!settings.enabled) return;

    const member = message.member;
    if (!member) return;
    if (member.permissions.has(PermissionFlagsBits.ManageMessages) ||
        member.permissions.has(PermissionFlagsBits.Administrator)) return;

    const now = Date.now();
    const key = spamKey(message.guild.id, message.author.id);
    const content = normalizeContent(message.content || "");
    const state = spamState.get(key) || { recent: [], fingerprints: [], links: [] };
    state.recent = state.recent.filter(item => now - item.time <= SPAM_WINDOW_MS);
    state.fingerprints = state.fingerprints.filter(item => now - item.time <= DUPLICATE_WINDOW_MS);
    state.links = state.links.filter(item => now - item.time <= SPAM_WINDOW_MS);
    state.recent.push({ id: message.id, time: now });
    const recentIds = state.recent.map(item => item.id);

    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    const linkCount = (message.content.match(/https?:\\/\\//gi) || []).length;
    let reason = null;

    if (state.recent.length >= Math.max(2, settings.maxMessageCount)) {
      reason = `message burst (${state.recent.length} messages in ${SPAM_WINDOW_MS / 1000} seconds)`;
    }

    if (!reason && content.length >= 4) {
      const duplicate = state.fingerprints.find(item =>
        similarity(content, item.content) >= 0.88
      );
      if (duplicate) reason = "repeated or near-identical message";
    }

    if (!reason && mentionCount >= MAX_MENTIONS_PER_MESSAGE) {
      reason = `mention spam (${mentionCount} mentions in one message)`;
    }

    if (!reason && linkCount >= 4) {
      reason = `link spam (${linkCount} links in one message)`;
    }

    if (!reason && linkCount > 0) {
      state.links.push({ time: now, count: linkCount });
      const linksInWindow = state.links.reduce((sum, item) => sum + item.count, 0);
      if (linksInWindow >= 5) reason = `rapid link posting (${linksInWindow} links)`;
    }

    if (reason) {
      spamState.set(key, state);
      await enforceSpam(message, settings, reason, recentIds);
      spamState.delete(key);
      return;
    }

    if (content.length >= 4) state.fingerprints.push({ content, time: now });
    spamState.set(key, state);
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

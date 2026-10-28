const fs = require("node:fs");
const path = require("node:path");
const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");

const FILE = path.join(__dirname, "..", "data", "welcome-settings.json");
const DEFAULTS = Object.freeze({ enabled: false, channelId: null, message: "Welcome {user} to {server}!" });
let cache;
function readStore() {
  if (cache) return cache;
  try {
    const value = JSON.parse(fs.readFileSync(FILE, "utf8"));
    cache = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read welcome settings:", error.message);
    cache = {};
  }
  return cache;
}
function getSettings(guildId) {
  return { ...DEFAULTS, ...(readStore()[guildId] || {}) };
}
function saveSettings(guildId, settings) {
  const value = readStore();
  value[guildId] = { ...DEFAULTS, ...(value[guildId] || {}), ...settings };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, FILE);
  cache = value;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("welcomeconfig")
    .setDescription("Configure join welcome messages for this server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption(option => option.setName("enabled").setDescription("Enable or disable welcome messages"))
    .addChannelOption(option => option.setName("channel").setDescription("Channel that receives welcome messages").addChannelTypes(ChannelType.GuildText))
    .addStringOption(option => option.setName("message").setDescription("Use {user}, {username}, {server}, and {memberCount}").setMaxLength(1000)),
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Manage Server permission to configure welcome messages.", ephemeral: true });
      return;
    }
    const settings = getSettings(interaction.guildId);
    const enabled = interaction.options.getBoolean("enabled");
    const channel = interaction.options.getChannel("channel");
    const message = interaction.options.getString("message");
    if (enabled !== null) settings.enabled = enabled;
    if (channel) settings.channelId = channel.id;
    if (message !== null) settings.message = message.trim();
    if (settings.enabled && !settings.channelId) {
      await interaction.reply({ content: "Choose a channel before enabling welcome messages.", ephemeral: true });
      return;
    }
    saveSettings(interaction.guildId, settings);
    await interaction.reply({
      ephemeral: true,
      content: "Welcome settings saved.\nStatus: " + (settings.enabled ? "enabled" : "disabled") +
        "\nChannel: " + (settings.channelId ? "<#" + settings.channelId + ">" : "not configured") +
        "\nMessage: " + settings.message
    });
  },
  async onMemberJoin(member) {
    if (!member.guild || member.user.bot) return;
    const settings = getSettings(member.guild.id);
    if (!settings.enabled || !settings.channelId) return;
    const channel = await member.guild.channels.fetch(settings.channelId).catch(() => null);
    if (!channel?.isTextBased() || !channel.isSendable()) return;
    const text = settings.message
      .replaceAll("{user}", "<@" + member.id + ">")
      .replaceAll("{username}", member.user.username)
      .replaceAll("{server}", member.guild.name)
      .replaceAll("{memberCount}", String(member.guild.memberCount));
    await channel.send({
      content: text.slice(0, 1900),
      allowedMentions: { users: text.includes("<@" + member.id + ">") ? [member.id] : [], parse: [] }
    }).catch(error => console.error("Could not send welcome message:", error.message));
  }
};

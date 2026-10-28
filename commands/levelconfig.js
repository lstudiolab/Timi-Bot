const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const leveling = require("../leveling");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("levelconfig")
    .setDescription("Configure XP and levels for this server.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption(option => option.setName("enabled").setDescription("Enable or disable leveling"))
    .addIntegerOption(option => option.setName("xp-per-message").setDescription("XP for an eligible message (1-100)").setMinValue(1).setMaxValue(100))
    .addIntegerOption(option => option.setName("cooldown-seconds").setDescription("Seconds between XP rewards (5-3600)").setMinValue(5).setMaxValue(3600))
    .addChannelOption(option => option.setName("announce-channel").setDescription("Optional channel for level-up announcements").addChannelTypes(ChannelType.GuildText)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Manage Server permission to configure leveling.", ephemeral: true });
      return;
    }
    const settings = leveling.getSettings(interaction.guildId);
    const enabled = interaction.options.getBoolean("enabled");
    const xp = interaction.options.getInteger("xp-per-message");
    const cooldown = interaction.options.getInteger("cooldown-seconds");
    const channel = interaction.options.getChannel("announce-channel");
    if (enabled !== null) settings.enabled = enabled;
    if (xp !== null) settings.xpPerMessage = xp;
    if (cooldown !== null) settings.cooldownSeconds = cooldown;
    if (channel) settings.announceChannelId = channel.id;
    const saved = leveling.saveSettings(interaction.guildId, settings);
    await interaction.reply({
      ephemeral: true,
      content: "Leveling settings saved.\nStatus: " + (saved.enabled ? "enabled" : "disabled") +
        "\nXP per eligible message: " + saved.xpPerMessage +
        "\nCooldown: " + saved.cooldownSeconds + " seconds" +
        "\nLevel-up channel: " + (saved.announceChannelId ? "<#" + saved.announceChannelId + ">" : "not configured") +
        "\nOmit an option to leave its value unchanged."
    });
  }
};

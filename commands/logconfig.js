const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const logSettings = require("../log-settings");

const toggles = [
  ["member-joins", "memberJoins", "Log member joins"],
  ["member-leaves", "memberLeaves", "Log member leaves"],
  ["message-deletes", "messageDeletes", "Log message deletions"],
  ["message-edits", "messageEdits", "Log message edits"],
  ["channel-changes", "channelChanges", "Log channel creation, deletion and updates"],
  ["role-changes", "roleChanges", "Log role creation, deletion and updates"],
  ["ban-events", "banEvents", "Log bans and unbans"]
];

const data = new SlashCommandBuilder()
  .setName("logconfig")
  .setDescription("Configure server event logs and their destination.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(option => option.setName("channel").setDescription("Destination for event logs").addChannelTypes(ChannelType.GuildText));
for (const [name, , description] of toggles) {
  data.addBooleanOption(option => option.setName(name).setDescription(description));
}

module.exports = {
  data,
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
        interaction.user.id !== interaction.guild.ownerId) {
      await interaction.reply({ content: "You need Manage Server permission to configure event logs.", ephemeral: true });
      return;
    }

    const settings = logSettings.getSettings(interaction.guildId);
    const channel = interaction.options.getChannel("channel");
    if (channel) settings.channelId = channel.id;
    for (const [option, key] of toggles) {
      const enabled = interaction.options.getBoolean(option);
      if (enabled !== null) settings[key] = enabled;
    }
    if (toggles.some(([, key]) => settings[key]) && !settings.channelId) {
      await interaction.reply({ content: "Choose an event-log channel before enabling event logging. No settings were saved.", ephemeral: true });
      return;
    }
    const saved = logSettings.saveSettings(interaction.guildId, settings);
    const active = toggles.filter(([, key]) => saved[key]).map(([, , description]) => description.replace(/^Log /, ""));
    await interaction.reply({
      ephemeral: true,
      content: "Event logging settings saved.\nDestination: " + (saved.channelId ? "<#" + saved.channelId + ">" : "not configured") +
        "\nEnabled events: " + (active.join(", ") || "none")
    });
  }
};

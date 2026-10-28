const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const warningStore = require("../warning-store");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("clearwarnings")
    .setDescription("Clear all recorded warnings for a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(option => option.setName("member").setDescription("Member whose warnings should be cleared").setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Manage Server permission to clear warning records.", ephemeral: true });
      return;
    }
    const user = interaction.options.getUser("member", true);
    const count = warningStore.clearWarnings(interaction.guildId, user.id);
    await interaction.reply({ content: "Cleared " + count + " warning(s) for <@" + user.id + ">.", ephemeral: true });
  }
};

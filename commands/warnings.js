const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const warningStore = require("../warning-store");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View recorded warnings for a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option => option.setName("member").setDescription("Member to inspect").setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) &&
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Moderate Members or Manage Server permission.", ephemeral: true });
      return;
    }
    const user = interaction.options.getUser("member", true);
    const warnings = warningStore.getWarnings(interaction.guildId, user.id);
    if (!warnings.length) {
      await interaction.reply({ content: "No warnings are recorded for <@" + user.id + ">.", ephemeral: true });
      return;
    }
    const lines = warnings.slice(-10).reverse().map((warning, index) =>
      (index + 1) + ". " + warning.reason + " — by <@" + warning.moderatorId + "> on <t:" + Math.floor(warning.createdAt / 1000) + ":f> (ID " + warning.id.slice(0, 8) + ")"
    );
    await interaction.reply({
      content: "Warnings for <@" + user.id + "> (" + warnings.length + " total):\n" + lines.join("\n").slice(0, 1800),
      ephemeral: true,
      allowedMentions: { parse: [] }
    });
  }
};

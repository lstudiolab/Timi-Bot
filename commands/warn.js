const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const warningStore = require("../warning-store");
const moderation = require("./moderation-panel");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Record a warning for a server member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(option => option.setName("member").setDescription("Member to warn").setRequired(true))
    .addStringOption(option => option.setName("reason").setDescription("Reason for the warning").setRequired(true).setMaxLength(1000)),
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers) &&
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Moderate Members or Manage Server permission.", ephemeral: true });
      return;
    }
    const user = interaction.options.getUser("member", true);
    const reason = interaction.options.getString("reason", true).trim();
    const target = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!target) {
      await interaction.reply({ content: "That member is not in this server.", ephemeral: true });
      return;
    }
    if (user.id === interaction.user.id || user.id === interaction.guild.ownerId || user.bot) {
      await interaction.reply({ content: "Choose a different human member. You cannot warn yourself, the server owner, or a bot.", ephemeral: true });
      return;
    }
    const warning = warningStore.addWarning(interaction.guildId, user.id, interaction.user.id, reason);
    const count = warningStore.getWarnings(interaction.guildId, user.id).length;
    await interaction.reply({ content: "Warning recorded for <@" + user.id + "> (#" + count + "). Reason: " + reason, ephemeral: true });
    const settings = moderation.getSettings(interaction.guild);
    if (settings.logChannelId) {
      const channel = await interaction.guild.channels.fetch(settings.logChannelId).catch(() => null);
      if (channel?.isTextBased() && channel.isSendable()) {
        await channel.send({
          content: "Warning " + warning.id.slice(0, 8) + " recorded for <@" + user.id + "> by <@" + interaction.user.id + ">. Total warnings: " + count + ". Reason: " + reason,
          allowedMentions: { parse: [] }
        }).catch(error => console.error("Could not log warning:", error.message));
      }
    }
    await user.send({ content: "You received a warning in " + interaction.guild.name + ". Reason: " + reason }).catch(() => {});
  }
};

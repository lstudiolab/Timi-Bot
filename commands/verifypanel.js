const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const verification = require("../verification-system");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verify-panel")
    .setDescription("Publish the Timi risk-based verification panel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    if (interaction.user.id !== interaction.guild.ownerId) return interaction.reply({ content: "Only the server owner can publish the verification panel.", ephemeral: true });
    const settings = verification.getSettings(interaction.guildId);
    const message = await interaction.channel.send(verification.buildPanel(settings));
    const current = verification.getSettings(interaction.guildId);
    const panels = Array.isArray(current.publishedPanels) ? current.publishedPanels : [];
    current.publishedPanels = [...panels.filter(p => p.channelId !== interaction.channelId), { channelId: interaction.channelId, messageId: message.id }];
    verification.saveSettings(interaction.guildId, current);
    return interaction.reply({ content: "Risk-based verification panel published. Configure the minimum account age, role, and review channel with /verificationconfig.", ephemeral: true });
  }
};

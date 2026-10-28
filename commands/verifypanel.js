const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const verification = require("../verification-system");
function initialize(client) {
  verification.startWebServer(client);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verifypanel")
    .setDescription("Publish the Timi email verification panel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction, client) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== interaction.guild.ownerId) {
      await interaction.reply({ content: "Only the server owner can publish the verification panel.", ephemeral: true });
      return;
    }
    initialize(client);
    const settings = verification.getSettings(interaction.guildId);
    const message = await interaction.channel.send(verification.buildPanel(settings));
    const current = verification.getSettings(interaction.guildId);
    const panels = Array.isArray(current.publishedPanels) ? current.publishedPanels : [];
    current.publishedPanels = [...panels.filter(p => p.channelId !== interaction.channelId), { channelId: interaction.channelId, messageId: message.id }];
    verification.saveSettings(interaction.guildId, current);
    await interaction.reply({ content: "Verification panel published. Configure the role and verification channel with /verificationconfig.", ephemeral: true });
  },
  initialize
};

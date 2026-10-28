const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const verification = require("../verification-system");
const initialized = new WeakSet();

function initialize(client) {
  verification.startWebServer(client);
  if (initialized.has(client)) return;
  initialized.add(client);
  client.on("interactionCreate", async interaction => {
    if (!interaction.customId?.startsWith("verify:")) return;
    try {
      await verification.handleInteraction(interaction, client);
    } catch (error) {
      console.error("Verification interaction failed:", error.message);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Timi could not complete verification. Please try again later.", ephemeral: true }).catch(() => {});
      }
    }
  });
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

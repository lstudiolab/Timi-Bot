const { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } = require("discord.js");
const panelCommand = require("./verifypanel");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verifycode")
    .setDescription("Open the modal to enter your email verification code."),
  async execute(interaction, client) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    panelCommand.initialize(client);
    await interaction.reply({
      content: "If you have requested a code on the Timi verification website, use the button below to enter it.",
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("verify:code-open").setLabel("Enter verification code").setStyle(ButtonStyle.Primary)
      )],
      ephemeral: true
    });
  }
};

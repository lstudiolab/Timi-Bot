const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verifycode")
    .setDescription("Get instructions for completing website email verification."),
  async execute(interaction) {
    await interaction.reply({
      content: "Verification codes are now entered on the Timi website. Open the private link sent when you clicked Verify in the server panel, enter the six-digit code from your email, and Timi will assign the configured role automatically. You do not need to claim a username or enter the code in Discord.",
      ephemeral: true
    });
  }
};

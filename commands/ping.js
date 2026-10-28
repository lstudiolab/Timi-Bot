const { SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder().setName("ping").setDescription("Check Timi's connection latency."),
  async execute(interaction, client) {
    await interaction.reply({
      content: "Gateway latency: " + client.ws.ping + " ms.",
      ephemeral: true
    });
  }
};

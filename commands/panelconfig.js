const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const ticketPanel = require("./ticketpanel");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("panelconfig")
    .setDescription("Change the settings of your existing ticket panel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    return ticketPanel.executeConfig(interaction);
  }
};

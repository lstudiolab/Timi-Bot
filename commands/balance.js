const { SlashCommandBuilder } = require("discord.js");
const economy = require("../economy");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("balance")
    .setDescription("View your or another member's coin balance.")
    .addUserOption(option => option.setName("member").setDescription("Member whose balance you want to view")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!economy.settings(interaction.guildId).enabled) {
      await interaction.reply({ content: "The economy is disabled in this server.", ephemeral: true });
      return;
    }
    const user = interaction.options.getUser("member") || interaction.user;
    await interaction.reply({ content: "<@" + user.id + "> has " + economy.getBalance(interaction.guildId, user.id) + " coins.", ephemeral: true });
  }
};

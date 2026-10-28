const { SlashCommandBuilder } = require("discord.js");
const economy = require("../economy");

module.exports = {
  data: new SlashCommandBuilder().setName("daily").setDescription("Collect your daily coin reward."),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    const result = economy.collect(interaction.guildId, interaction.user.id, "daily");
    await interaction.reply({
      ephemeral: true,
      content: result.error || ("You collected " + result.amount + " coins. Your balance is now " + result.balance + ".")
    });
  }
};

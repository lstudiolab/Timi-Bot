const { SlashCommandBuilder } = require("discord.js");
const economy = require("../economy");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("pay")
    .setDescription("Give coins to another server member.")
    .addUserOption(option => option.setName("member").setDescription("Member to pay").setRequired(true))
    .addIntegerOption(option => option.setName("amount").setDescription("Whole number of coins (1-1000000)").setMinValue(1).setMaxValue(1000000).setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    const target = interaction.options.getUser("member", true);
    if (target.bot) {
      await interaction.reply({ content: "You cannot transfer coins to a bot.", ephemeral: true });
      return;
    }
    if (!await interaction.guild.members.fetch(target.id).catch(() => null)) {
      await interaction.reply({ content: "The recipient must be a member of this server.", ephemeral: true });
      return;
    }
    const amount = interaction.options.getInteger("amount", true);
    const result = economy.pay(interaction.guildId, interaction.user.id, target.id, amount);
    await interaction.reply({
      ephemeral: true,
      content: result.error || ("Sent " + amount + " coins to <@" + target.id + ">. Your balance is now " + result.balance + ".")
    });
  }
};

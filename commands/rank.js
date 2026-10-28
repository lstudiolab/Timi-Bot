const { SlashCommandBuilder } = require("discord.js");
const leveling = require("../leveling");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("rank")
    .setDescription("View a member's current level and XP.")
    .addUserOption(option => option.setName("member").setDescription("Member to inspect")),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    const member = interaction.options.getUser("member") || interaction.user;
    const data = leveling.getRank(interaction.guildId, member.id);
    const currentLevelXp = data.xp - data.level * data.level * 100;
    const nextLevelXp = ((data.level + 1) ** 2) * 100 - data.level * data.level * 100;
    await interaction.reply({
      ephemeral: true,
      content: "<@" + member.id + "> — Level " + data.level + "\nXP: " + data.xp +
        "\nProgress to level " + (data.level + 1) + ": " + currentLevelXp + "/" + nextLevelXp + " XP"
    });
  }
};

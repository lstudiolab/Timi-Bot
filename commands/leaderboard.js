const { SlashCommandBuilder } = require("discord.js");
const leveling = require("../leveling");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the top ten members by XP."),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    const rows = leveling.getLeaderboard(interaction.guildId, 10);
    if (!rows.length) {
      await interaction.reply({ content: "No XP has been earned yet. Leveling may need to be enabled with /levelconfig.", ephemeral: true });
      return;
    }
    const lines = rows.map((row, index) => (index + 1) + ". <@" + row.userId + "> — Level " + row.level + " (" + row.xp + " XP)");
    await interaction.reply({ content: "**Server XP leaderboard**\n" + lines.join("\n"), ephemeral: true, allowedMentions: { parse: [] } });
  }
};

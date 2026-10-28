const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const economy = require("../economy");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("economyconfig")
    .setDescription("Configure the server economy and reward cooldowns.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption(option => option.setName("enabled").setDescription("Enable or disable the economy"))
    .addIntegerOption(option => option.setName("daily-min").setDescription("Minimum daily reward (0-1000000)").setMinValue(0).setMaxValue(1000000))
    .addIntegerOption(option => option.setName("daily-max").setDescription("Maximum daily reward (0-1000000)").setMinValue(0).setMaxValue(1000000))
    .addIntegerOption(option => option.setName("work-min").setDescription("Minimum work reward (0-1000000)").setMinValue(0).setMaxValue(1000000))
    .addIntegerOption(option => option.setName("work-max").setDescription("Maximum work reward (0-1000000)").setMinValue(0).setMaxValue(1000000))
    .addIntegerOption(option => option.setName("daily-cooldown-hours").setDescription("Hours between daily rewards (1-168)").setMinValue(1).setMaxValue(168))
    .addIntegerOption(option => option.setName("work-cooldown-minutes").setDescription("Minutes between work rewards (1-1440)").setMinValue(1).setMaxValue(1440)),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Manage Server permission to configure the economy.", ephemeral: true });
      return;
    }
    const next = economy.settings(interaction.guildId);
    const enabled = interaction.options.getBoolean("enabled");
    const optionKeys = [
      ["daily-min", "dailyMin"], ["daily-max", "dailyMax"],
      ["work-min", "workMin"], ["work-max", "workMax"],
      ["daily-cooldown-hours", "dailyCooldownHours"],
      ["work-cooldown-minutes", "workCooldownMinutes"]
    ];
    if (enabled !== null) next.enabled = enabled;
    for (const [option, key] of optionKeys) {
      const value = interaction.options.getInteger(option);
      if (value !== null) next[key] = value;
    }
    if (next.dailyMin > next.dailyMax || next.workMin > next.workMax) {
      await interaction.reply({ content: "Each minimum reward must be less than or equal to its maximum. No changes were saved.", ephemeral: true });
      return;
    }
    const saved = economy.saveSettings(interaction.guildId, next);
    await interaction.reply({
      ephemeral: true,
      content: "Economy settings saved.\nStatus: " + (saved.enabled ? "enabled" : "disabled") +
        "\nDaily: " + saved.dailyMin + "–" + saved.dailyMax + " coins every " + saved.dailyCooldownHours + " hours" +
        "\nWork: " + saved.workMin + "–" + saved.workMax + " coins every " + saved.workCooldownMinutes + " minutes"
    });
  }
};

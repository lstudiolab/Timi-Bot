const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const securitySettings = require("../security-settings");

const fields = [
  ["new-account-alert-days", "Flag accounts younger than this many days (1-90)", "newAccountAlertDays", 1, 90],
  ["very-new-account-days", "Very-new account cutoff in days (1-30)", "veryNewAccountDays", 1, 30],
  ["new-account-timeout-minutes", "Timeout duration in minutes (1-1440)", "newAccountTimeoutMinutes", 1, 1440],
  ["join-window-seconds", "Join-burst detection window (1-120 seconds)", "joinWindowSeconds", 1, 120],
  ["join-threshold", "Joins that trigger a raid alert (2-100)", "joinThreshold", 2, 100],
  ["channel-delete-window", "Channel deletion window (10-600 seconds)", "channelDeleteWindowSeconds", 10, 600],
  ["channel-delete-threshold", "Channel deletions to trigger anti-nuke (2-20)", "channelDeleteThreshold", 2, 20],
  ["anti-nuke-timeout-minutes", "Anti-nuke timeout duration (1-1440)", "antiNukeTimeoutMinutes", 1, 1440]
];

const data = new SlashCommandBuilder()
  .setName("securityconfig")
  .setDescription("Configure Timi's join monitoring and anti-nuke protections.")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

data.addBooleanOption(option => option.setName("timeout-new-accounts").setDescription("Timeout very new human accounts; default is false"));
data.addBooleanOption(option => option.setName("join-burst-enabled").setDescription("Enable join-burst alerts"));
data.addBooleanOption(option => option.setName("anti-nuke-enabled").setDescription("Enable channel-deletion recovery and quarantine"));
for (const [name, description] of fields) {
  data.addIntegerOption(option => option.setName(name).setDescription(description).setMinValue(fields.find(item => item[0] === name)[3]).setMaxValue(fields.find(item => item[0] === name)[4]));
}

module.exports = {
  data,
  getSettings: securitySettings.getSettings,
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
        interaction.user.id !== interaction.guild.ownerId) {
      await interaction.reply({ content: "You need Manage Server permission to configure security.", ephemeral: true });
      return;
    }

    const current = securitySettings.getSettings(interaction.guildId);
    const next = { ...current };
    const boolOptions = [
      ["timeout-new-accounts", "timeoutNewAccounts"],
      ["join-burst-enabled", "joinBurstEnabled"],
      ["anti-nuke-enabled", "antiNukeEnabled"]
    ];
    for (const [option, key] of boolOptions) {
      const value = interaction.options.getBoolean(option);
      if (value !== null) next[key] = value;
    }
    for (const [option, , key] of fields) {
      const value = interaction.options.getInteger(option);
      if (value !== null) next[key] = value;
    }

    const saved = securitySettings.saveSettings(interaction.guildId, next);
    await interaction.reply({
      ephemeral: true,
      content: [
        "**Security settings saved**",
        "New-account alerts: " + saved.newAccountAlertDays + " days",
        "Automatic timeout for very new accounts: " + (saved.timeoutNewAccounts ? "enabled" : "disabled"),
        "Join-burst alert: " + (saved.joinBurstEnabled ? saved.joinThreshold + " joins / " + saved.joinWindowSeconds + " seconds" : "disabled"),
        "Anti-nuke: " + (saved.antiNukeEnabled ? saved.channelDeleteThreshold + " channel deletions / " + saved.channelDeleteWindowSeconds + " seconds; timeout " + saved.antiNukeTimeoutMinutes + " minutes" : "disabled"),
        "",
        "Values not supplied were left unchanged."
      ].join("\n")
    });
  }
};

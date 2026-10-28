const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const ticketPanel = require("./ticketpanel");
const moderation = require("./moderation-panel");
const welcome = require("./welcomeconfig");
const security = require("../security-settings");
const leveling = require("../leveling");
const economy = require("../economy");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("configreset")
    .setDescription("Reset a feature's settings to their defaults.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName("section").setDescription("Which settings to reset").setRequired(true).addChoices(
      { name: "Ticket panel", value: "tickets" },
      { name: "Moderation / anti-spam", value: "moderation" },
      { name: "Security / anti-nuke", value: "security" },
      { name: "Welcome messages", value: "welcome" },
      { name: "Leveling", value: "leveling" },
      { name: "Economy", value: "economy" }
    )),
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) &&
        interaction.user.id !== interaction.guild.ownerId) {
      await interaction.reply({ content: "You need Manage Server permission to reset configuration.", ephemeral: true });
      return;
    }
    const section = interaction.options.getString("section", true);
    switch (section) {
      case "tickets": {
        const settings = ticketPanel.resetSettings(interaction.guildId);
        await ticketPanel.refreshPublishedPanels(interaction.guild, settings);
        break;
      }
      case "moderation": {
        const settings = moderation.resetSettings(interaction.guild);
        await moderation.refreshPanel(interaction.guild, settings);
        break;
      }
      case "security":
        security.resetSettings(interaction.guildId);
        break;
      case "welcome":
        welcome.resetSettings(interaction.guildId);
        break;
      case "leveling":
        leveling.resetSettings(interaction.guildId);
        break;
      case "economy":
        economy.resetSettings(interaction.guildId);
        break;
      default:
        await interaction.reply({ content: "Unknown configuration section.", ephemeral: true });
        return;
    }
    const note = section === "leveling"
      ? "Existing XP totals were preserved."
      : section === "economy"
        ? "Existing member balances were preserved."
        : section === "tickets"
          ? "Tracked published ticket panels were updated with default settings."
          : "";
    await interaction.reply({ content: section + " settings reset to defaults. " + note, ephemeral: true });
  }
};

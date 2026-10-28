const { ChannelType, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const moderation = require("./moderation-panel");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("moderationexempt")
    .setDescription("Add, remove or clear anti-spam role/channel exemptions.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName("action").setDescription("Change exemption settings").setRequired(true).addChoices(
      { name: "Add", value: "add" },
      { name: "Remove", value: "remove" },
      { name: "Clear this exemption type", value: "clear" }
    ))
    .addStringOption(option => option.setName("target-type").setDescription("What to exempt").setRequired(true).addChoices(
      { name: "Role", value: "role" },
      { name: "Channel", value: "channel" }
    ))
    .addRoleOption(option => option.setName("role").setDescription("Role to exempt"))
    .addChannelOption(option => option.setName("channel").setDescription("Text channel to exempt").addChannelTypes(ChannelType.GuildText)),
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "You need Manage Server permission to edit anti-spam exemptions.", ephemeral: true });
      return;
    }
    const action = interaction.options.getString("action", true);
    const type = interaction.options.getString("target-type", true);
    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    if (action !== "clear" && ((type === "role" && !role) || (type === "channel" && !channel))) {
      await interaction.reply({ content: "Choose the matching role or channel for this action.", ephemeral: true });
      return;
    }
    if (type === "role" && role?.id === interaction.guild.roles.everyone.id) {
      await interaction.reply({ content: "The @everyone role cannot be exempted. Choose a specific role.", ephemeral: true });
      return;
    }

    const settings = moderation.getSettings(interaction.guild);
    const key = type === "role" ? "exemptRoleIds" : "exemptChannelIds";
    const targetId = type === "role" ? role?.id : channel?.id;
    const values = Array.isArray(settings[key]) ? [...settings[key]] : [];
    if (action === "clear") {
      settings[key] = [];
    } else if (action === "add") {
      if (!values.includes(targetId)) values.push(targetId);
      settings[key] = values;
    } else {
      settings[key] = values.filter(value => value !== targetId);
    }
    moderation.saveSettings(interaction.guildId, settings);
    if (moderation.refreshPanel) await moderation.refreshPanel(interaction.guild, settings);
    const display = (settings[key] || []).map(value => type === "role" ? "<@&" + value + ">" : "<#" + value + ">").join(", ") || "None";
    await interaction.reply({
      ephemeral: true,
      content: (type === "role" ? "Exempt roles" : "Exempt channels") + " updated.\nCurrent exemptions: " + display
    });
  }
};

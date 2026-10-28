const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const verification = require("../verification-system");
const panelCommand = require("./verifypanel");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verificationconfig")
    .setDescription("Configure the verification role and verification channel (server owner only).")
    .addRoleOption(option => option.setName("role").setDescription("Role granted after email verification").setRequired(false))
    .addChannelOption(option => option.setName("channel").setDescription("Channel where members enter codes and claim usernames").setRequired(false))
    .addStringOption(option => option.setName("title").setDescription("Verification panel title").setMaxLength(200).setRequired(false))
    .addStringOption(option => option.setName("description").setDescription("Verification panel description").setMaxLength(1000).setRequired(false)),
  async execute(interaction, client) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (interaction.user.id !== interaction.guild.ownerId) {
      await interaction.reply({ content: "Only the server owner can change verification settings.", ephemeral: true });
      return;
    }
    panelCommand.initialize(client);
    const settings = verification.getSettings(interaction.guildId);
    const role = interaction.options.getRole("role");
    const channel = interaction.options.getChannel("channel");
    const title = interaction.options.getString("title");
    const description = interaction.options.getString("description");
    if (!role && !channel && title === null && description === null) {
      await interaction.reply({
        content: `**Verification settings**\nRole: ${settings.roleId ? `<@&${settings.roleId}>` : "Not configured"}\nCompletion channel: ${settings.channelId ? `<#${settings.channelId}>` : "Not configured"}\nPanel title: ${settings.panelTitle}\nPanel description: ${settings.panelDescription}\n\nRun /verificationconfig with one or more options to change settings. Only the server owner can configure this system.`,
        ephemeral: true
      });
      return;
    }
    if (role) {
      if (role.id === interaction.guild.roles.everyone.id || role.managed) {
        await interaction.reply({ content: "Choose a normal, non-managed role other than @everyone.", ephemeral: true });
        return;
      }
      const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(client.user.id);
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) || !role.editable) {
        await interaction.reply({ content: "Timi needs Manage Roles and its highest role must be above the selected verification role.", ephemeral: true });
        return;
      }
      settings.roleId = role.id;
    }
    if (channel) {
      if (!channel.isTextBased() || !channel.isSendable()) {
        await interaction.reply({ content: "Choose a sendable text channel.", ephemeral: true });
        return;
      }
      settings.channelId = channel.id;
    }
    if (title !== null) settings.panelTitle = title.trim() || "Verify your account";
    if (description !== null) settings.panelDescription = description.trim() || "Verify your email address to receive access to this server.";
    verification.saveSettings(interaction.guildId, settings);
    for (const panel of settings.publishedPanels || []) {
      try {
        const target = await interaction.guild.channels.fetch(panel.channelId);
        const message = await target.messages.fetch(panel.messageId);
        await message.edit(verification.buildPanel(settings));
      } catch (error) {
        console.error("Could not refresh verification panel:", error.message);
      }
    }
    await interaction.reply({
      content: `Verification settings saved.\nRole: ${settings.roleId ? `<@&${settings.roleId}>` : "Not configured"}\nCompletion channel: ${settings.channelId ? `<#${settings.channelId}>` : "Not configured"}`,
      ephemeral: true
    });
  }
};

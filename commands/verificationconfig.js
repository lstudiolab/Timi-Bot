const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");
const verification = require("../verification-system");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("verificationconfig")
    .setDescription("Configure Timi's risk-based verification (server owner only).")
    .addRoleOption(o => o.setName("role").setDescription("Role granted after passing").setRequired(false))
    .addRoleOption(o => o.setName("required-role").setDescription("Role a member must already have before verifying").setRequired(false))
    .addBooleanOption(o => o.setName("clear-required-role").setDescription("Remove the required-role restriction").setRequired(false))
    .addIntegerOption(o => o.setName("min-age-days").setDescription("Minimum Discord account age in days").setMinValue(0).setMaxValue(3650).setRequired(false))
    .addChannelOption(o => o.setName("review-channel").setDescription("Channel for manual review and verification logs").addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addStringOption(o => o.setName("title").setDescription("Verification panel title").setMaxLength(200).setRequired(false))
    .addStringOption(o => o.setName("description").setDescription("Verification panel description").setMaxLength(1000).setRequired(false)),
  async execute(interaction) {
    if (!interaction.inGuild()) return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    if (interaction.user.id !== interaction.guild.ownerId) return interaction.reply({ content: "Only the server owner can change verification settings.", ephemeral: true });
    const settings = verification.getSettings(interaction.guildId);
    const role = interaction.options.getRole("role");
    const requiredRole = interaction.options.getRole("required-role");
    const clearRequiredRole = interaction.options.getBoolean("clear-required-role") === true;
    const age = interaction.options.getInteger("min-age-days");
    const review = interaction.options.getChannel("review-channel");
    const title = interaction.options.getString("title");
    const description = interaction.options.getString("description");
    if (!role && !requiredRole && !clearRequiredRole && age === null && !review && title === null && description === null) {
      return interaction.reply({ content:
        "**Timi verification settings**\nVerified role (granted after passing): " + (settings.roleId ? "<@&" + settings.roleId + ">" : "Not configured") +
        "\nRequired role (must already be held): " + (settings.requiredRoleId ? "<@&" + settings.requiredRoleId + ">" : "None") +
        "\nMinimum account age: " + settings.minAccountAgeDays + " days" +
        "\nManual review/log channel: " + (settings.reviewChannelId ? "<#" + settings.reviewChannelId + ">" : "Private #timi fallback") +
        "\nScore thresholds: 80+ pass, 60–79 manual review, below 60 kick" +
        "\nMaximum check points: age 40, history 20, attempts 20, behavior 10, avatar 10.",
        ephemeral: true });
    }
    const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(interaction.client.user.id);
    if (role) {
      if (role.id === interaction.guild.roles.everyone.id || role.managed) return interaction.reply({ content: "Choose a normal, non-managed role other than @everyone.", ephemeral: true });
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) || !role.editable) return interaction.reply({ content: "Timi needs Manage Roles and its highest role must be above the selected verified role.", ephemeral: true });
      settings.roleId = role.id;
    }
    if (requiredRole) {
      if (requiredRole.id === interaction.guild.roles.everyone.id || requiredRole.managed) return interaction.reply({ content: "Choose a normal, non-managed role other than @everyone as the required role.", ephemeral: true });
      settings.requiredRoleId = requiredRole.id;
    }
    if (clearRequiredRole) settings.requiredRoleId = "";
    if (age !== null) settings.minAccountAgeDays = age;
    if (review) settings.reviewChannelId = review.id;
    if (title !== null) settings.panelTitle = title.trim() || "Verify your account";
    if (description !== null) settings.panelDescription = description.trim() || "Press Verify to have Timi assess your account and server history.";
    verification.saveSettings(interaction.guildId, settings);
    for (const panel of settings.publishedPanels || []) {
      try {
        const channel = await interaction.guild.channels.fetch(panel.channelId);
        const message = await channel.messages.fetch(panel.messageId);
        await message.edit(verification.buildPanel(settings));
      } catch (error) { console.error("Could not refresh verification panel:", error.message); }
    }
    return interaction.reply({ content: "Verification settings saved.", ephemeral: true });
  }
};

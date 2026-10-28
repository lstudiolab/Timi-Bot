const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("role")
    .setDescription("Add or remove a manageable role from a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addStringOption(option => option.setName("action").setDescription("Add or remove the role").setRequired(true).addChoices(
      { name: "Add role", value: "add" },
      { name: "Remove role", value: "remove" }
    ))
    .addUserOption(option => option.setName("member").setDescription("Member to update").setRequired(true))
    .addRoleOption(option => option.setName("role").setDescription("Role to add or remove").setRequired(true)),
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!actor || (!actor.permissions.has(PermissionFlagsBits.ManageRoles) && !actor.permissions.has(PermissionFlagsBits.Administrator))) {
      await interaction.reply({ content: "You need Manage Roles permission to use this command.", ephemeral: true });
      return;
    }
    const user = interaction.options.getUser("member", true);
    const target = await interaction.guild.members.fetch(user.id).catch(() => null);
    const role = interaction.options.getRole("role", true);
    const action = interaction.options.getString("action", true);
    if (!target) {
      await interaction.reply({ content: "That user is not a member of this server.", ephemeral: true });
      return;
    }
    if (role.id === interaction.guild.roles.everyone.id || role.managed || !role.editable) {
      await interaction.reply({ content: "That role is the default role, integration-managed, or above Timi's role.", ephemeral: true });
      return;
    }
    if (target.id === interaction.guild.ownerId || !target.manageable) {
      await interaction.reply({ content: "Timi or your permissions cannot manage that member because of role hierarchy.", ephemeral: true });
      return;
    }
    if (!actor.permissions.has(PermissionFlagsBits.Administrator) &&
        (role.position >= actor.roles.highest.position || target.roles.highest.position >= actor.roles.highest.position)) {
      await interaction.reply({ content: "You can only change roles and members below your highest role.", ephemeral: true });
      return;
    }
    if (role.permissions.has(PermissionFlagsBits.Administrator) &&
        !actor.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "Only a server Administrator can assign or remove an Administrator role.", ephemeral: true });
      return;
    }
    try {
      if (action === "add") await target.roles.add(role, "Role assigned by " + interaction.user.tag + " through /role");
      else await target.roles.remove(role, "Role removed by " + interaction.user.tag + " through /role");
      await interaction.reply({
        content: (action === "add" ? "Added " : "Removed ") + "<@&" + role.id + "> " + (action === "add" ? "to " : "from ") + "<@" + target.id + ">.",
        ephemeral: true,
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      console.error("Role update failed:", error.message);
      await interaction.reply({ content: "Timi could not update that role. Check role hierarchy and Manage Roles permission.", ephemeral: true });
    }
  }
};

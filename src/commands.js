import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";
const manageGuild=PermissionFlagsBits.ManageGuild;
export const commandData=[
  new SlashCommandBuilder().setName("install-library").setDescription("Install a built-in Timi library.").addStringOption(o=>o.setName("libraryname").setDescription("Library name").setRequired(false).setMaxLength(50)),
  new SlashCommandBuilder().setName("library-list").setDescription("Show available Timi libraries."),
  new SlashCommandBuilder().setName("ticket-setup").setDescription("Create Timi private channels and the ticket category.").setDefaultMemberPermissions(manageGuild),
  new SlashCommandBuilder().setName("ticket-panel").setDescription("Create or update the customizable ticket panel.").setDefaultMemberPermissions(manageGuild),
  new SlashCommandBuilder().setName("ticket-settings").setDescription("Edit the settings of your ticket panel.").setDefaultMemberPermissions(manageGuild),
  new SlashCommandBuilder().setName("moderation-settings").setDescription("Configure Timi moderation and anti-spam protection.").setDefaultMemberPermissions(manageGuild),
  new SlashCommandBuilder().setName("verify-settings").setDescription("Configure risk-based verification (server owner only).")
    .addRoleOption(o=>o.setName("role").setDescription("Role granted after passing"))
    .addRoleOption(o=>o.setName("required-role").setDescription("Role required before verifying"))
    .addBooleanOption(o=>o.setName("clear-required-role").setDescription("Remove the required-role restriction"))
    .addIntegerOption(o=>o.setName("min-age-days").setDescription("Minimum account age in days").setMinValue(0).setMaxValue(3650))
    .addChannelOption(o=>o.setName("review-channel").setDescription("Channel for manual review").addChannelTypes(ChannelType.GuildText))
    .addStringOption(o=>o.setName("title").setDescription("Verification panel title").setMaxLength(200))
    .addStringOption(o=>o.setName("description").setDescription("Verification panel description").setMaxLength(1000)),
  new SlashCommandBuilder().setName("verify-panel").setDescription("Publish the Timi risk-based verification panel."),
  new SlashCommandBuilder().setName("setup-role-picker").setDescription("Create a self-service role picker menu (server owner only)."),
  new SlashCommandBuilder().setName("create-embed").setDescription("Create a reusable server embed.").setDefaultMemberPermissions(manageGuild),
  new SlashCommandBuilder().setName("place-embed").setDescription("Place a saved embed in this channel.").setDefaultMemberPermissions(manageGuild)
    .addStringOption(o=>o.setName("name").setDescription("Saved embed name").setRequired(true).setMaxLength(24)),
  new SlashCommandBuilder().setName("edit-embed").setDescription("Edit a saved embed.").setDefaultMemberPermissions(manageGuild)
    .addStringOption(o=>o.setName("name").setDescription("Saved embed name").setRequired(true).setMaxLength(24))

  new SlashCommandBuilder().setName("ping").setDescription("Show Timi gateway latency."),
  new SlashCommandBuilder().setName("server-info").setDescription("Show information about this server."),
  new SlashCommandBuilder().setName("user-info").setDescription("Show information about a server member.")
    .addUserOption(o=>o.setName("user").setDescription("Member to inspect")),
  new SlashCommandBuilder().setName("avatar").setDescription("Show a user's avatar.")
    .addUserOption(o=>o.setName("user").setDescription("User whose avatar to show")),
  new SlashCommandBuilder().setName("welcome-settings").setDescription("Configure welcome and goodbye messages.")
    .setDefaultMemberPermissions(manageGuild)
    .addChannelOption(o=>o.setName("welcome-channel").setDescription("Channel for new member messages").addChannelTypes(ChannelType.GuildText))
    .addStringOption(o=>o.setName("welcome-message").setDescription("Welcome text; supports {user}, {username}, {server}, {member_count}").setMaxLength(1800))
    .addChannelOption(o=>o.setName("goodbye-channel").setDescription("Channel for member departure messages").addChannelTypes(ChannelType.GuildText))
    .addStringOption(o=>o.setName("goodbye-message").setDescription("Goodbye text; supports {user}, {username}, {server}, {member_count}").setMaxLength(1800))
].map(command=>command.toJSON());

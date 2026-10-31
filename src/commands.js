import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from "discord.js";
const manageGuild=PermissionFlagsBits.ManageGuild;
const allCommandBuilders=[
  new SlashCommandBuilder().setName("install-library").setDescription("Install a built-in Timi library.").addStringOption(o=>o.setName("libraryname").setDescription("Library name").setRequired(false).setMaxLength(50)),
  new SlashCommandBuilder().setName("library-list").setDescription("Show available Timi libraries."),
  new SlashCommandBuilder().setName("uninstall-library").setDescription("Disable a Timi library (server owner only).").addStringOption(o=>o.setName("libraryname").setDescription("Library name").setRequired(true).setMaxLength(50)),
  new SlashCommandBuilder().setName("ticket-setup").setDescription("Create Timi private channels and the ticket category.").setDefaultMemberPermissions(manageGuild),
  new SlashCommandBuilder().setName("ticket-panel").setDescription("Create or update the customizable ticket panel.").setDefaultMemberPermissions(manageGuild),
  new SlashCommandBuilder().setName("ticket-settings").setDescription("Edit the settings of your ticket panel.").setDefaultMemberPermissions(manageGuild),
  new SlashCommandBuilder().setName("automod-word").setDescription("Manage blocked words and phrases.")
    .setDefaultMemberPermissions(manageGuild)
    .addSubcommand(s=>s.setName("add").setDescription("Block a word or phrase.")
      .addStringOption(o=>o.setName("phrase").setDescription("Word or phrase to block").setRequired(true).setMaxLength(100)))
    .addSubcommand(s=>s.setName("remove").setDescription("Remove a blocked word or phrase.")
      .addStringOption(o=>o.setName("phrase").setDescription("Exact phrase to remove").setRequired(true).setMaxLength(100)))
    .addSubcommand(s=>s.setName("list").setDescription("List blocked words and phrases.")),
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
    .addStringOption(o=>o.setName("name").setDescription("Saved embed name").setRequired(true).setMaxLength(24)),
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
];

const commandGroups = Object.freeze({
  Core: ["install-library","library-list","uninstall-library"],
  Support: ["ticket-setup","ticket-panel","ticket-settings"],
  Moderation: ["automod-word","moderation-settings"],
  Foundation: ["verify-settings","verify-panel","setup-role-picker","create-embed","place-embed","edit-embed","ping","server-info","user-info","avatar","welcome-settings"]
});
const commandByName = new Map(allCommandBuilders.map(command => [command.name, command]));
export const commandData = allCommandBuilders.map(command => command.toJSON());
export const coreCommandData = commandGroups.Core.map(name => commandByName.get(name).toJSON());
export function commandsForLibraries(installedLibraries = []) {
  const names = new Set(commandGroups.Core);
  for (const library of installedLibraries) {
    for (const name of commandGroups[library] || []) names.add(name);
  }
  return [...names].map(name => commandByName.get(name)?.toJSON()).filter(Boolean);
}

// Core commands are global. Guild registrations contain library commands only.
export function libraryCommandsForLibraries(installedLibraries = []) {
  const names = new Set();
  for (const library of installedLibraries) {
    for (const name of commandGroups[library] || []) names.add(name);
  }
  return [...names].map(name => commandByName.get(name)?.toJSON()).filter(Boolean);
}


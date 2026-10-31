import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
export const GREY = 0x808080;
export const greyEmbed = (title, description) => new EmbedBuilder().setColor(GREY).setTitle(title).setDescription(description);
export const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
export const row = (...components) => new ActionRowBuilder().addComponents(...components);
export function textInput(id, label, value = "", style = TextInputStyle.Short, required = true, maxLength = 1000) {
  return new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(maxLength).setValue(String(value ?? "").slice(0, maxLength));
}
export function modal(id, title, inputs) {
  return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...inputs.map(input => row(input)));
}
export async function respond(interaction, content, components = [], embeds = []) {
  const payload = { content: content ?? null, components, embeds, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, ephemeral: true });
}
export async function deny(interaction, message) { return respond(interaction, message, []); }
export function isManager(interaction) { return interaction.memberPermissions?.has("ManageGuild") ?? false; }
export async function requireManager(interaction) {
  if (isManager(interaction)) return true;
  await deny(interaction, "You need Manage Server permission to use this control.");
  return false;
}
export async function requireOwner(interaction) {
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  await deny(interaction, "Only the server owner can use this control.");
  return false;
}

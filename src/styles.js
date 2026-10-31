import { ButtonStyle } from "discord.js";
import { hasPro } from "./subscriptions.js";

const DEFAULT_THEME = Object.freeze({
  color: "#808080",
  author: "",
  footer: "",
  image: "",
  button_style: "secondary"
});

export function getGuildTheme(store, guildId) {
  return hasPro(store,guildId) ? { ...DEFAULT_THEME, ...(store.data.customizations?.[guildId] || {}) } : { ...DEFAULT_THEME };
}

export function colorNumber(value) {
  const text = String(value || "#808080").trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return Number.parseInt(text.slice(1), 16);
  if (/^0x[0-9a-f]{6}$/i.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^\d{1,8}$/.test(text)) {
    const number = Number(text);
    if (Number.isInteger(number) && number >= 0 && number <= 0xffffff) return number;
  }
  return 0x808080;
}

export function applyGuildTheme(embed, store, guildId) {
  const theme = getGuildTheme(store, guildId);
  embed.setColor(colorNumber(theme.color));
  if (theme.author && !embed.data.author) embed.setAuthor({ name: theme.author.slice(0, 256) });
  if (theme.footer && !embed.data.footer) embed.setFooter({ text: theme.footer.slice(0, 2048) });
  if (theme.image && !embed.data.image) embed.setImage(theme.image);
  return embed;
}

export function applyButtonTheme(builder, store, guildId) {
  const theme = getGuildTheme(store, guildId);
  const styles = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger
  };
  return builder.setStyle(styles[theme.button_style] || ButtonStyle.Secondary);
}

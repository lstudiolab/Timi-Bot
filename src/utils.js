export const DAY = 86_400_000;

export function fillDefaults(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (target[key] === undefined) target[key] = structuredClone(value);
  }
  return target;
}
export function isSnowflake(value) { return /^\d{15,22}$/.test(String(value ?? "")); }
export function trim(value) { return String(value ?? "").trim(); }
export function nowMs() { return Date.now(); }
export function snowflakeTime(id) {
  try { return Number((BigInt(String(id)) >> 22n) + 1420070400000n); }
  catch { return Date.now(); }
}
export function normalizeMessage(value) {
  return String(value ?? "").toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, " mention ")
    .replace(/[\p{P}\p{C}]/gu, " ").replace(/\s+/g, " ").trim();
}
export function jaccard(leftText, rightText) {
  const left = new Set(normalizeMessage(leftText).split(/\s+/).filter(Boolean));
  const right = new Set(normalizeMessage(rightText).split(/\s+/).filter(Boolean));
  if (!left.size && !right.size) return 0;
  let intersection = 0;
  for (const word of left) if (right.has(word)) intersection++;
  return intersection / (left.size + right.size - intersection);
}
export function cleanChannelName(value) {
  return String(value || "ticket").toLowerCase().replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "ticket";
}
export function mentionChannel(id) { return id ? `<#${id}>` : "Not configured"; }
export function mentionRole(id) { return id ? `<@&${id}>` : "Not configured"; }
export function chunkText(text, max = 1900) {
  const chunks = [];
  let current = "";
  for (const line of String(text).split("\n")) {
    if (current.length + line.length + 1 > max && current) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line.slice(0, max);
  }
  if (current) chunks.push(current);
  return chunks;
}
export function hasManager(interaction) {
  return interaction.memberPermissions?.has("ManageGuild") ?? false;
}
export function isOwner(member) {
  return Boolean(member?.guild?.ownerId && member.id === member.guild.ownerId);
}

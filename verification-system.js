const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  PermissionFlagsBits
} = require("discord.js");

const DATA_DIR = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "verification.json");
const DEFAULTS = {
  roleId: "",
  channelId: "",
  reviewChannelId: "",
  minAccountAgeDays: 7,
  panelTitle: "Verify your account",
  panelDescription: "Press Verify to have Timi assess your account and server history.",
  publishedPanels: [],
  pointMax: { age: 40, history: 20, attempts: 20, behavior: 10, avatar: 10 },
  thresholds: { pass: 80, review: 60 }
};
const DAY = 86400000;
let storeCache;

function readStore() {
  if (storeCache) return storeCache;
  try { storeCache = fs.existsSync(STORE_PATH) ? JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) : { guilds: {}, members: {} }; }
  catch (error) { console.error("Verification store read failed:", error.message); storeCache = { guilds: {}, members: {} }; }
  storeCache.guilds ||= {};
  storeCache.members ||= {};
  return storeCache;
}
function writeStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(readStore(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}
function getSettings(guildId) {
  const saved = readStore().guilds[guildId] || {};
  return {
    ...DEFAULTS, ...saved,
    pointMax: { ...DEFAULTS.pointMax, ...(saved.pointMax || {}) },
    thresholds: { ...DEFAULTS.thresholds, ...(saved.thresholds || {}) }
  };
}
function saveSettings(guildId, settings) {
  const store = readStore();
  store.guilds[guildId] = { ...getSettings(guildId), ...settings };
  writeStore();
}
function memberRecord(guildId, userId) {
  const key = guildId + ":" + userId;
  const store = readStore();
  store.members[key] ||= { joins: 0, leaves: 0, verificationAttempts: [], failedChecks: 0, suspiciousMessages: 0, lastJoinAt: 0, lastVerifiedAt: 0 };
  return store.members[key];
}
function recordJoin(member) {
  const record = memberRecord(member.guild.id, member.id);
  record.joins++;
  record.lastJoinAt = Date.now();
  writeStore();
}
function recordLeave(member) {
  const record = memberRecord(member.guild.id, member.id);
  record.leaves++;
  writeStore();
}
function recordSuspiciousMessage(message, reason) {
  if (!message.guild || message.author.bot) return;
  const record = memberRecord(message.guild.id, message.author.id);
  record.suspiciousMessages++;
  record.lastSuspiciousReason = String(reason).slice(0, 180);
  record.lastSuspiciousAt = Date.now();
  writeStore();
}
function clamp(value, max) { return Math.max(0, Math.min(max, Math.round(value))); }
function scoreAge(user, settings) {
  const ageDays = Math.max(0, (Date.now() - user.createdTimestamp) / DAY);
  const required = Math.max(0, Number(settings.minAccountAgeDays) || 0);
  if (ageDays < required) return { points: 0, max: settings.pointMax.age, passed: false, reason: "Account is " + ageDays.toFixed(1) + " days old; minimum is " + required + " days.", critical: true };
  if (required === 0) return { points: settings.pointMax.age, max: settings.pointMax.age, passed: true, reason: "No minimum account age is configured." };
  const ratio = ageDays / required;
  const fraction = ratio >= 4 ? 1 : ratio >= 2 ? 0.95 : ratio >= 1.5 ? 0.9 : ratio >= 1.2 ? 0.8 : 0.7;
  return { points: clamp(settings.pointMax.age * fraction, settings.pointMax.age), max: settings.pointMax.age, passed: true, reason: "Account age: " + ageDays.toFixed(1) + " days; minimum: " + required + " days." };
}
function scoreHistory(record, max) {
  const joins = Number(record.joins || 0), leaves = Number(record.leaves || 0);
  const churn = Math.max(0, leaves - 1);
  const penalty = Math.min(max, churn * (max * 0.2) + (record.failedChecks || 0) * (max * 0.15));
  return { points: clamp(max - penalty, max), max, passed: penalty === 0, reason: joins + " recorded join(s), " + leaves + " leave(s), " + (record.failedChecks || 0) + " prior failed assessment(s)." };
}
function scoreAttempts(record, max) {
  const cutoff = Date.now() - 10 * 60 * 1000;
  record.verificationAttempts = (record.verificationAttempts || []).filter(t => t >= cutoff);
  const count = record.verificationAttempts.length;
  // Retries are a weak signal: reduce points gradually rather than treating
  // a second click as strong evidence of abuse.
  const fraction = count <= 1 ? 1 : count === 2 ? 0.9 : count === 3 ? 0.8 : count <= 5 ? 0.7 : 0.6;
  return { points: clamp(max * fraction, max), max, passed: count <= 1, reason: count + " verification attempt(s) in the last 10 minutes." };
}
function scoreBehavior(record, max) {
  const recent = Date.now() - (record.lastSuspiciousAt || 0) < 7 * DAY;
  const count = Number(record.suspiciousMessages || 0);
  const fraction = count === 0 ? 1 : count === 1 ? 0.65 : count <= 3 ? 0.3 : 0;
  return { points: clamp(max * fraction, max), max, passed: !recent && count === 0, reason: count + " suspicious message event(s) recorded." + (recent && record.lastSuspiciousReason ? " Latest: " + record.lastSuspiciousReason : "") };
}
function scoreAvatar(user, max) {
  const isDefault = user.avatar == null;
  return { points: isDefault ? clamp(max * 0.25, max) : max, max, passed: !isDefault, reason: isDefault ? "Default Discord avatar detected; this is a weak signal only." : "Custom avatar present." };
}
async function assessMember(member, settings, onProgress = async () => {}) {
  // Refresh data from Discord before scoring so cached profile/member data is
  // not mistaken for a current assessment.
  await onProgress("Refreshing your Discord account and server membership…");
  const [freshUser, freshMember] = await Promise.all([
    member.client.users.fetch(member.id, { force: true }).catch(() => member.user),
    member.guild.members.fetch({ user: member.id, force: true }).catch(() => member)
  ]);

  const record = memberRecord(member.guild.id, member.id);
  record.verificationAttempts ||= [];
  record.verificationAttempts.push(Date.now());

  await onProgress("Checking account creation date and minimum-age requirement…");
  const age = scoreAge(freshUser, settings);

  await onProgress("Reviewing recorded server joins, leaves, and previous failed checks…");
  const history = scoreHistory(record, settings.pointMax.history);

  await onProgress("Evaluating recent verification attempts…");
  const attempts = scoreAttempts(record, settings.pointMax.attempts);

  await onProgress("Reviewing recorded message-behavior signals…");
  const behavior = scoreBehavior(record, settings.pointMax.behavior);

  await onProgress("Inspecting Discord profile avatar signals…");
  const avatar = scoreAvatar(freshUser, settings.pointMax.avatar);

  await onProgress("Calculating the risk score and applying the server's decision thresholds…");
  const checks = { age, history, attempts, behavior, avatar };
  const score = Object.values(checks).reduce((sum, item) => sum + item.points, 0);
  const ageFailed = !checks.age.passed;
  const decision = ageFailed ? "review" : score >= settings.thresholds.pass ? "pass" : score >= settings.thresholds.review ? "review" : "kick";
  writeStore();
  return { score, checks, decision, ageFailed, member: freshMember, user: freshUser };
}
async function getLogChannel(guild, settings) {
  if (settings.reviewChannelId) {
    const channel = await guild.channels.fetch(settings.reviewChannelId).catch(() => null);
    if (channel?.isTextBased() && channel.isSendable()) return channel;
  }
  const fallback = guild.channels.cache.find(c => c.name === "timi" && c.isTextBased() && c.isSendable());
  return fallback || null;
}
function resultDescription(result) {
  return Object.entries(result.checks).map(([key, item]) =>
    "**" + ({ age: "Account age", history: "Server history", attempts: "Verification attempts", behavior: "Message behavior", avatar: "Avatar" }[key]) +
    ":** " + item.points + "/" + item.max + " — " + item.reason
  ).join("\n");
}
async function handleInteraction(interaction) {
  if (!interaction.customId?.startsWith("verify:")) return false;
  if (!interaction.inGuild() || !interaction.isButton()) {
    await interaction.reply({ content: "Verification can only be used in a server.", ephemeral: true });
    return true;
  }
  if (interaction.customId !== "verify:start") return true;
  await interaction.deferReply({ ephemeral: true });
  const settings = getSettings(interaction.guildId);
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await interaction.editReply("Timi could not retrieve your server membership. Please try again.");
    return true;
  }
  if (settings.roleId && member.roles.cache.has(settings.roleId)) {
    await interaction.editReply("You are already verified.");
    return true;
  }
  const result = await assessMember(member, settings, status =>
    interaction.editReply("**Timi verification in progress**\n" + status)
  );
  const summary = resultDescription(result);
  if (result.decision === "pass") {
    if (!settings.roleId) {
      await interaction.editReply("Your score is " + result.score + "/100, but the server owner has not configured a verification role.");
      return true;
    }
    const role = await interaction.guild.roles.fetch(settings.roleId).catch(() => null);
    const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(interaction.client.user.id);
    if (!role || !botMember.permissions.has(PermissionFlagsBits.ManageRoles) || !role.editable) {
      await interaction.editReply("Your score is " + result.score + "/100, but Timi cannot assign the configured role. The owner must check Manage Roles and role hierarchy.");
      return true;
    }
    await member.roles.add(role, "Timi risk-based verification passed: " + result.score + "/100");
    const record = memberRecord(interaction.guildId, member.id);
    record.lastVerifiedAt = Date.now();
    writeStore();
    await interaction.editReply("**Verification passed — " + result.score + "/100**\nYour verified role has been assigned.");
    const log = await getLogChannel(interaction.guild, settings);
    if (log) await log.send({ content: "Verification passed for <@" + member.id + "> — **" + result.score + "/100**\n" + summary, allowedMentions: { parse: [] } }).catch(() => {});
  } else if (result.decision === "review") {
    await interaction.editReply("**Manual review required — " + result.score + "/100**\n" + (result.ageFailed ? "Your account does not meet the server's minimum account-age requirement. " : "") + "A moderator must review your verification.");
    const log = await getLogChannel(interaction.guild, settings);
    if (log) await log.send({ content: "**Verification requires manual review**\nMember: <@" + member.id + ">\nScore: **" + result.score + "/100**\n" + summary, allowedMentions: { parse: [] } }).catch(() => {});
  } else {
    const reason = "Timi verification score " + result.score + "/100, below the required 60. " +
      Object.entries(result.checks).filter(([, item]) => item.points < item.max).map(([key, item]) => key + ": " + item.reason).join(" ");
    const botMember = interaction.guild.members.me;
    if (!botMember?.permissions.has(PermissionFlagsBits.KickMembers) || !member.kickable) {
      await interaction.editReply("**Verification failed — " + result.score + "/100**\nTimi cannot kick you because of missing Kick Members permission or role hierarchy. A moderator has been notified.");
    } else {
      await interaction.editReply("**Verification failed — " + result.score + "/100**\nYou will be removed from the server. Reason: Your account did not meet the server's verification risk threshold.");
      await member.kick(reason);
    }
    const log = await getLogChannel(interaction.guild, settings);
    if (log) await log.send({ content: "**Verification failed; kick attempted**\nMember: <@" + member.id + ">\nScore: **" + result.score + "/100**\nReason: " + reason + "\n" + summary, allowedMentions: { parse: [] } }).catch(() => {});
    const record = memberRecord(interaction.guildId, member.id);
    record.failedChecks = (record.failedChecks || 0) + 1;
    writeStore();
  }
  return true;
}
function buildPanel(settings) {
  const embed = new EmbedBuilder().setColor(0x808080).setTitle(settings.panelTitle).setDescription(settings.panelDescription);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("verify:start").setLabel("Verify").setStyle(ButtonStyle.Primary));
  return { embeds: [embed], components: [row] };
}
module.exports = { handleInteraction, buildPanel, getSettings, saveSettings, recordJoin, recordLeave, recordSuspiciousMessage };

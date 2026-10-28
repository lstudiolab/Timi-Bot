const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const securitySettings = require("../security-settings");
const warningStore = require("../warning-store");
const economy = require("../economy");
const leveling = require("../leveling");

const id = () => crypto.randomUUID().replaceAll("-", "").slice(0, 18);

test("security settings merge defaults and persist per server", () => {
  const guildId = id();
  const defaults = securitySettings.getSettings(guildId);
  assert.equal(defaults.timeoutNewAccounts, false);
  const saved = securitySettings.saveSettings(guildId, { joinThreshold: 9 });
  assert.equal(saved.joinThreshold, 9);
  assert.equal(saved.antiNukeEnabled, true);
  assert.equal(securitySettings.getSettings(guildId).joinThreshold, 9);
  assert.equal(securitySettings.resetSettings(guildId).joinThreshold, 6);
});

test("warning history is isolated by guild/member and can be cleared", () => {
  const guildId = id();
  const userId = id();
  const warning = warningStore.addWarning(guildId, userId, id(), "test reason");
  assert.equal(warningStore.getWarnings(guildId, userId).length, 1);
  assert.equal(warningStore.getWarnings(guildId, userId)[0].reason, "test reason");
  assert.equal(warningStore.clearWarnings(guildId, userId), 1);
  assert.equal(warningStore.getWarnings(guildId, userId).length, 0);
});

test("economy rejects self-payments and insufficient funds, then transfers coins", () => {
  const guildId = id();
  const sender = id();
  const receiver = id();
  economy.saveSettings(guildId, {
    enabled: true,
    dailyMin: 10,
    dailyMax: 10,
    dailyCooldownHours: 24
  });
  assert.match(economy.pay(guildId, sender, receiver, 1).error, /enough coins/);
  assert.match(economy.pay(guildId, sender, sender, 1).error, /yourself/);
  assert.equal(economy.collect(guildId, sender, "daily").amount, 10);
  assert.equal(economy.pay(guildId, sender, receiver, 4).balance, 6);
  assert.equal(economy.getBalance(guildId, receiver), 4);
  assert.equal(economy.resetSettings(guildId).dailyMin, 100);
  assert.equal(economy.getBalance(guildId, receiver), 4);
});

test("leveling awards configured XP and applies the cooldown", async () => {
  const guildId = id();
  const userId = id();
  leveling.saveSettings(guildId, { enabled: true, xpPerMessage: 12, cooldownSeconds: 60 });
  const message = {
    guild: { id: guildId },
    author: { id: userId, bot: false },
    content: "a legitimate message"
  };
  await leveling.handleMessage(message);
  assert.equal(leveling.getRank(guildId, userId).xp, 12);
  await leveling.handleMessage(message);
  assert.equal(leveling.getRank(guildId, userId).xp, 12);
  assert.equal(leveling.resetSettings(guildId).enabled, false);
  assert.equal(leveling.getRank(guildId, userId).xp, 12);
});

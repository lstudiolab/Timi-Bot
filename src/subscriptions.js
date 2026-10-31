const MIB = 1024 * 1024;

export const PLANS = Object.freeze({
  free: Object.freeze({
    name: "Timi Free",
    storageBytes: 5 * MIB,
    storageLabel: "5 MB",
    priceMonthly: 0,
    priceAnnual: 0
  }),
  pro: Object.freeze({
    name: "Timi Pro",
    storageBytes: 12 * MIB,
    storageLabel: "12 MB",
    priceMonthly: 4.99,
    priceAnnual: 49.99
  })
});

const STORAGE_COLLECTIONS = Object.freeze([
  "installed_libraries", "welcome", "tickets", "moderation", "verification",
  "developer_projects",
  "developer_history", "developer_redo", "panel_scripts", "customizations", "library_data"
]);

function activeProRecord(record, now = Date.now()) {
  if (!record || record.tier !== "pro" || record.status !== "active") return false;
  return !record.expires_at || Number(record.expires_at) > now;
}

export function getPlanForData(data, guildId, now = Date.now()) {
  const record = data.subscriptions?.[guildId];
  return activeProRecord(record, now) ? "pro" : "free";
}

export function getGuildPlan(store, guildId, now = Date.now()) {
  return getPlanForData(store.data, guildId, now);
}

export function hasPro(store, guildId, now = Date.now()) {
  return getGuildPlan(store, guildId, now) === "pro";
}

export function setGuildSubscription(store, guildId, options = {}) {
  const tier = options.tier === "pro" ? "pro" : "free";
  const now = Number(options.started_at) || Date.now();
  const duration = options.period === "annual" ? 365 * 24 * 60 * 60 * 1000
    : options.period === "monthly" ? 30 * 24 * 60 * 60 * 1000 : 0;
  store.data.subscriptions ||= {};
  store.data.subscriptions[guildId] = {
    tier,
    status: tier === "pro" ? "active" : "inactive",
    period: options.period || null,
    started_at: tier === "pro" ? now : null,
    expires_at: tier === "pro" && duration ? now + duration : null,
    provider: options.provider || null,
    reference: options.reference || null,
    updated_at: Date.now()
  };
  store.save();
  return store.data.subscriptions[guildId];
}

function guildStorageSnapshot(data, guildId, overrides = {}) {
  const snapshot = {};
  for (const collection of STORAGE_COLLECTIONS) {
    const source = overrides[collection] ?? data[collection] ?? {};
    if (source && Object.prototype.hasOwnProperty.call(source, guildId)) {
      snapshot[collection] = source[guildId];
    }
  }
  for (const collection of ["role_picker_menus", "role_picker_drafts"]) {
    const source=overrides[collection]??data[collection]??{};
    const selected={};
    for(const [key,value] of Object.entries(source)){
      if(value?.guild_id===guildId)selected[key]=value;
    }
    if(Object.keys(selected).length)snapshot[collection]=selected;
  }
  for (const collection of ["embeds", "members"]) {
    const source = data[collection] || {};
    const selected = {};
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith(guildId + ":")) selected[key] = value;
    }
    if (Object.keys(selected).length) snapshot[collection] = selected;
  }
  return snapshot;
}

export function getGuildStorageBytes(data, guildId) {
  return Buffer.byteLength(JSON.stringify(guildStorageSnapshot(data, guildId)), "utf8");
}

export function restoreGuildStorage(target, source, guildId) {
  for (const collection of STORAGE_COLLECTIONS) {
    target[collection] ||= {};
    if (source[collection] && Object.prototype.hasOwnProperty.call(source[collection], guildId)) {
      target[collection][guildId] = structuredClone(source[collection][guildId]);
    } else {
      delete target[collection][guildId];
    }
  }
  for (const collection of ["role_picker_menus", "role_picker_drafts"]) {
    target[collection] ||= {};
    for(const [key,value] of Object.entries(target[collection])) if(value?.guild_id===guildId) delete target[collection][key];
    for(const [key,value] of Object.entries(source[collection]||{})) {
      if(value?.guild_id===guildId) target[collection][key]=structuredClone(value);
    }
  }
  for (const collection of ["embeds", "members"]) {
    target[collection] ||= {};
    for (const key of Object.keys(target[collection])) if (key.startsWith(guildId + ":")) delete target[collection][key];
    for (const [key, value] of Object.entries(source[collection] || {})) {
      if (key.startsWith(guildId + ":")) target[collection][key] = structuredClone(value);
    }
  }
}

export function getStorageReport(store, guildId) {
  const tier = getGuildPlan(store, guildId);
  const bytes = getGuildStorageBytes(store.data, guildId);
  const limit = PLANS[tier].storageBytes;
  return {
    tier,
    bytes,
    limit,
    remaining: Math.max(0, limit - bytes),
    percent: Math.min(100, Math.round(bytes / limit * 100)),
    exceeded: bytes > limit
  };
}

export function canStoreGuildState(store, guildId, overrides = {}) {
  const tier = getGuildPlan(store, guildId);
  const candidate = { ...store.data, ...overrides };
  const bytes = getGuildStorageBytes(candidate, guildId);
  return {
    ok: bytes <= PLANS[tier].storageBytes,
    bytes,
    limit: PLANS[tier].storageBytes,
    tier
  };
}

export function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return bytes + " B";
  if (bytes < MIB) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / MIB).toFixed(2) + " MB";
}

export function proRequiredMessage(feature = "this feature") {
  return "Timi Pro is required to use " + feature + ". Use /timi-plan to view the subscription.";
}

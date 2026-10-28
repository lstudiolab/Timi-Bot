const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SlashCommandBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const SETTINGS_FILE = path.join(__dirname, "..", "data", "moderation-settings.json");

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  sanction: "timeout",
  timeoutMinutes: 10,
  logChannelId: null,
  actionDurationSeconds: 3,
  maxMessageCount: 3,
  maxMentionsPerMessage: 5,
  maxLinksPerMessage: 4,
  maxLinksPerWindow: 5,
  duplicateWindowSeconds: 20,
  similarityThreshold: 0.88,
  exemptRoleIds: [],
  exemptChannelIds: [],
  panelChannelId: null,
  panelMessageId: null
});

const SANCTION_LABELS = {
  timeout: "Member timeout",
  kick: "Kick member",
  ban: "Ban member",
  delete: "Delete messages only"
};

let settingsCache;

function readStore() {
  if (settingsCache) return settingsCache;

  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      settingsCache = {};
      return settingsCache;
    }

    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    settingsCache = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (error) {
    console.error("Could not read moderation settings:", error.message);
    settingsCache = {};
  }

  return settingsCache;
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const temporaryFile = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(temporaryFile, SETTINGS_FILE);
  settingsCache = store;
}

function getSettings(guild) {
  const store = readStore();

  if (!store[guild.id]) {
    const announcements = guild.channels.cache.find(
      channel => channel.type === ChannelType.GuildText &&
        channel.name.toLowerCase() === "announcements"
    );

    store[guild.id] = {
      ...DEFAULT_SETTINGS,
      logChannelId: announcements ? announcements.id : null
    };
    writeStore(store);
  }

  return { ...DEFAULT_SETTINGS, ...store[guild.id] };
}

function saveSettings(guildId, settings) {
  const store = readStore();
  store[guildId] = { ...DEFAULT_SETTINGS, ...settings };
  writeStore(store);
}

function resetSettings(guild) {
  const current = getSettings(guild);
  const next = {
    ...DEFAULT_SETTINGS,
    panelChannelId: current.panelChannelId || null,
    panelMessageId: current.panelMessageId || null
  };
  saveSettings(guild.id, next);
  return getSettings(guild);
}

function sanctionText(settings) {
  if (settings.sanction === "timeout") {
    return `Member timeout (${settings.timeoutMinutes} minutes)`;
  }
  return SANCTION_LABELS[settings.sanction] || SANCTION_LABELS.timeout;
}

function section(title, value, button) {
  return new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`### ${title}\n${value}`)
    )
    .setButtonAccessory(button);
}

function editButton(customId, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(style);
}

function buildPanel(guild, settings) {
  const logChannel = settings.logChannelId
    ? guild.channels.cache.get(settings.logChannelId)
    : null;
  const logLabel = logChannel ? `#${logChannel.name}`
    : settings.logChannelId ? `<#${settings.logChannelId}>`
      : "Not configured";

  const container = new ContainerBuilder()
    .setAccentColor(0x808080)
    .addSectionComponents(
      section(
        "Module status",
        settings.enabled ? "Active" : "Inactive",
        editButton(
          settings.enabled ? "modpanel:disable" : "modpanel:enable",
          settings.enabled ? "Disable" : "Enable",
          settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success
        )
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addSectionComponents(
      section(
        "Applied sanction",
        sanctionText(settings),
        editButton("modpanel:sanction", "Edit")
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addSectionComponents(
      section(
        "Log Channel",
        logLabel,
        editButton(
          "modpanel:log",
          settings.logChannelId ? "Configured" : "Configure",
          settings.logChannelId ? ButtonStyle.Success : ButtonStyle.Secondary
        )
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addSectionComponents(
      section(
        "Action Duration",
        `${settings.actionDurationSeconds} seconds`,
        editButton("modpanel:duration", "Edit")
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addSectionComponents(
      section(
        "Max message count",
        String(settings.maxMessageCount),
        editButton("modpanel:max-count", "Edit")
      )
    )
    .addSectionComponents(
      section(
        "Advanced spam thresholds",
        `Mentions/message: ${settings.maxMentionsPerMessage}; links/message: ${settings.maxLinksPerMessage}; links/window: ${settings.maxLinksPerWindow}; duplicate window: ${settings.duplicateWindowSeconds}s; similarity: ${settings.similarityThreshold}; exemptions: ${(settings.exemptRoleIds || []).length} roles / ${(settings.exemptChannelIds || []).length} channels`,
        editButton("modpanel:advanced", "Edit")
      )
    );

  return [container];
}

function makeTextInput(customId, label, value, placeholder, maxLength = 50) {
  return new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(maxLength)
    .setValue(String(value))
    .setPlaceholder(placeholder);
}

async function refreshPanel(guild, settings) {
  if (!settings.panelChannelId || !settings.panelMessageId) return;
  try {
    const channel = guild.channels.cache.get(settings.panelChannelId)
      || await guild.channels.fetch(settings.panelChannelId);
    if (!channel || !channel.isTextBased()) return;
    const message = await channel.messages.fetch(settings.panelMessageId);
    await message.edit({ components: buildPanel(guild, settings) });
  } catch (error) {
    console.error("Could not refresh the moderation panel:", error.message);
  }
}

function canManage(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

async function handleInteraction(interaction) {
  if (!interaction.guild) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "This control can only be used inside a server.", ephemeral: true });
    }
    return;
  }

  if (!canManage(interaction)) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "You need the Manage Server permission to change these settings.",
        ephemeral: true
      });
    }
    return;
  }

  const settings = getSettings(interaction.guild);
  const id = interaction.customId;

  if (interaction.isButton()) {
    if (id === "modpanel:disable" || id === "modpanel:enable") {
      settings.enabled = id === "modpanel:enable";
      saveSettings(interaction.guildId, settings);
      await interaction.update({ components: buildPanel(interaction.guild, settings) });
      return;
    }

    if (id === "modpanel:sanction") {
      const modal = new ModalBuilder()
        .setCustomId("modpanel:sanction-modal")
        .setTitle("Edit applied sanction")
        .addComponents(
          new ActionRowBuilder().addComponents(
            makeTextInput(
              "sanction",
              "Sanction (timeout, kick, ban, delete)",
              settings.sanction,
              "timeout, kick, ban, or delete",
              12
            )
          ),
          new ActionRowBuilder().addComponents(
            makeTextInput(
              "timeout-minutes",
              "Timeout duration in minutes",
              settings.timeoutMinutes,
              "1 to 40320",
              5
            )
          )
        );
      await interaction.showModal(modal);
      return;
    }

    if (id === "modpanel:log") {
      const menu = new ChannelSelectMenuBuilder()
        .setCustomId("modpanel:log-select")
        .setPlaceholder("Select the moderation log channel")
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);

      await interaction.reply({
        content: "Select the channel where moderation logs should be sent.",
        components: [new ActionRowBuilder().addComponents(menu)],
        ephemeral: true
      });
      return;
    }

    if (id === "modpanel:advanced") {
      const modal = new ModalBuilder()
        .setCustomId("modpanel:advanced-modal")
        .setTitle("Edit spam thresholds")
        .addComponents(
          new ActionRowBuilder().addComponents(makeTextInput("mentions", "Mentions per message (1-25)", settings.maxMentionsPerMessage, "1 to 25", 2)),
          new ActionRowBuilder().addComponents(makeTextInput("links-message", "Links per message (1-20)", settings.maxLinksPerMessage, "1 to 20", 2)),
          new ActionRowBuilder().addComponents(makeTextInput("links-window", "Links per window (2-100)", settings.maxLinksPerWindow, "2 to 100", 3)),
          new ActionRowBuilder().addComponents(makeTextInput("duplicate-window", "Duplicate window seconds (5-120)", settings.duplicateWindowSeconds, "5 to 120", 3)),
          new ActionRowBuilder().addComponents(makeTextInput("similarity", "Similarity threshold (0.50-1.00)", Number(settings.similarityThreshold).toFixed(2), "0.50 to 1.00", 4))
        );
      await interaction.showModal(modal);
      return;
    }

    if (id === "modpanel:duration" || id === "modpanel:max-count") {
      const isDuration = id === "modpanel:duration";
      const modal = new ModalBuilder()
        .setCustomId(isDuration ? "modpanel:duration-modal" : "modpanel:max-count-modal")
        .setTitle(isDuration ? "Edit action duration" : "Edit max message count")
        .addComponents(
          new ActionRowBuilder().addComponents(
            makeTextInput(
              "value",
              isDuration ? "Action duration in seconds" : "Maximum message count",
              isDuration ? settings.actionDurationSeconds : settings.maxMessageCount,
              isDuration ? "1 to 60 seconds" : "1 to 100 messages",
              3
            )
          )
        );
      await interaction.showModal(modal);
    }
    return;
  }

  if (interaction.isChannelSelectMenu() && id === "modpanel:log-select") {
    settings.logChannelId = interaction.values[0];
    saveSettings(interaction.guildId, settings);
    await refreshPanel(interaction.guild, settings);
    await interaction.update({
      content: `Log channel set to <#${settings.logChannelId}>.`,
      components: []
    });
    return;
  }

  if (interaction.isModalSubmit()) {
    if (id === "modpanel:sanction-modal") {
      const sanction = interaction.fields.getTextInputValue("sanction").trim().toLowerCase();
      const timeoutMinutes = Number(interaction.fields.getTextInputValue("timeout-minutes").trim());
      const validSanctions = Object.keys(SANCTION_LABELS);

      if (!validSanctions.includes(sanction)) {
        await interaction.reply({
          content: "Sanction must be timeout, kick, ban, or delete.",
          ephemeral: true
        });
        return;
      }
      if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 40320) {
        await interaction.reply({
          content: "Timeout duration must be a whole number between 1 and 40320 minutes.",
          ephemeral: true
        });
        return;
      }

      settings.sanction = sanction;
      settings.timeoutMinutes = timeoutMinutes;
    } else if (id === "modpanel:duration-modal") {
      const value = Number(interaction.fields.getTextInputValue("value").trim());
      if (!Number.isInteger(value) || value < 1 || value > 60) {
        await interaction.reply({
          content: "Action duration must be a whole number between 1 and 60 seconds.",
          ephemeral: true
        });
        return;
      }
      settings.actionDurationSeconds = value;
    } else if (id === "modpanel:max-count-modal") {
      const value = Number(interaction.fields.getTextInputValue("value").trim());
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        await interaction.reply({
          content: "Max message count must be a whole number between 1 and 100.",
          ephemeral: true
        });
        return;
      }
      settings.maxMessageCount = value;
    } else if (id === "modpanel:advanced-modal") {
      const mentions = Number(interaction.fields.getTextInputValue("mentions").trim());
      const linksMessage = Number(interaction.fields.getTextInputValue("links-message").trim());
      const linksWindow = Number(interaction.fields.getTextInputValue("links-window").trim());
      const duplicateWindow = Number(interaction.fields.getTextInputValue("duplicate-window").trim());
      const similarityValue = Number(interaction.fields.getTextInputValue("similarity").trim());
      if (!Number.isInteger(mentions) || mentions < 1 || mentions > 25 ||
          !Number.isInteger(linksMessage) || linksMessage < 1 || linksMessage > 20 ||
          !Number.isInteger(linksWindow) || linksWindow < 2 || linksWindow > 100 ||
          !Number.isInteger(duplicateWindow) || duplicateWindow < 5 || duplicateWindow > 120 ||
          !Number.isFinite(similarityValue) || similarityValue < 0.5 || similarityValue > 1) {
        await interaction.reply({ content: "Invalid thresholds. Check each value's displayed range; no changes were saved.", ephemeral: true });
        return;
      }
      settings.maxMentionsPerMessage = mentions;
      settings.maxLinksPerMessage = linksMessage;
      settings.maxLinksPerWindow = linksWindow;
      settings.duplicateWindowSeconds = duplicateWindow;
      settings.similarityThreshold = similarityValue;
    } else {
      return;
    }

    saveSettings(interaction.guildId, settings);
    await refreshPanel(interaction.guild, settings);
    await interaction.reply({ content: "Moderation settings updated.", ephemeral: true });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("moderationconfig")
    .setDescription("Configure Timi moderation and anti-spam protection.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used inside a server.", ephemeral: true });
      return;
    }
    if (!canManage(interaction)) {
      await interaction.reply({
        content: "You need the Manage Server permission to use this command.",
        ephemeral: true
      });
      return;
    }

    const settings = getSettings(interaction.guild);
    await interaction.reply({
      components: buildPanel(interaction.guild, settings),
      flags: MessageFlags.IsComponentsV2
    });

    const message = await interaction.fetchReply();
    settings.panelChannelId = message.channelId;
    settings.panelMessageId = message.id;
    saveSettings(interaction.guildId, settings);
  },
  handleInteraction,
  getSettings,
  saveSettings,
  resetSettings,
  refreshPanel
};

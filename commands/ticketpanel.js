const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const STORE_PATH = path.join(__dirname, "..", "data", "ticket-settings.json");
const DEFAULTS = Object.freeze({
  panelTitle: "Support Tickets",
  panelDescription: "Need help? Open a ticket and our team will assist you.",
  openButtonLabel: "Open Ticket",
  ticketMessage: "Please describe what you need help with. A member of the support team will be with you shortly.",
  closeButtonLabel: "Close Ticket",
  categoryName: "ticket"
});

let storeCache;
const ticketCreationLocks = new Set();
const ticketCreationCooldowns = new Map();
const TICKET_COOLDOWN_MS = 10_000;


function readStore() {
  if (storeCache) return storeCache;
  try {
    storeCache = fs.existsSync(STORE_PATH)
      ? JSON.parse(fs.readFileSync(STORE_PATH, "utf8"))
      : {};
    if (!storeCache || typeof storeCache !== "object" || Array.isArray(storeCache)) storeCache = {};
  } catch (error) {
    console.error("Could not read ticket settings:", error.message);
    storeCache = {};
  }
  return storeCache;
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tempPath = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, STORE_PATH);
  storeCache = store;
}

function getSettings(guildId) {
  return { ...DEFAULTS, ...(readStore()[guildId] || {}) };
}

function saveSettings(guildId, settings) {
  const store = readStore();
  const previous = store[guildId] || {};
  store[guildId] = {
    ...DEFAULTS,
    ...previous,
    ...settings,
    publishedPanels: previous.publishedPanels || []
  };
  writeStore(store);
}

async function refreshPublishedPanels(guild, settings) {
  const stored = readStore()[guild.id];
  const panels = Array.isArray(stored?.publishedPanels) ? stored.publishedPanels : [];
  const remaining = [];

  for (const panel of panels) {
    try {
      const channel = await guild.channels.fetch(panel.channelId);
      if (!channel || !channel.isTextBased()) continue;
      const message = await channel.messages.fetch(panel.messageId);
      await message.edit(buildPublicPanel(settings));
      remaining.push(panel);
    } catch (error) {
      // Keep transient failures so the panel can be refreshed on a later edit.
      if (error.code !== 10008 && error.code !== 10003 && error.code !== 50001) {
        remaining.push(panel);
      }
    }
  }

  const store = readStore();
  store[guild.id] = { ...getSettings(guild.id), publishedPanels: remaining };
  writeStore(store);
}

function rememberPublishedPanel(guildId, channelId, messageId) {
  const store = readStore();
  const settings = { ...DEFAULTS, ...(store[guildId] || {}) };
  const panels = Array.isArray(settings.publishedPanels) ? settings.publishedPanels : [];
  settings.publishedPanels = [
    ...panels.filter(panel => panel.channelId !== channelId || panel.messageId !== messageId),
    { channelId, messageId }
  ];
  store[guildId] = settings;
  writeStore(store);
}

function isManager(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
    interaction.user.id === interaction.guild?.ownerId;
}

function makeInput(id, label, value, style = TextInputStyle.Short, maxLength = 100) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(true)
    .setMaxLength(maxLength)
    .setValue(value);
  return input;
}

function buildConfigPanel(settings) {
  const embed = new EmbedBuilder()
    .setColor(0x808080)
    .setTitle("Ticket Panel Configuration")
    .setDescription(
      `**Panel title:** ${settings.panelTitle}\n**Panel description:** ${settings.panelDescription}\n**Open button:** ${settings.openButtonLabel}\n**Ticket message:** ${settings.ticketMessage}\n**Close button:** ${settings.closeButtonLabel}\n**Category:** ${settings.categoryName}\n\nEdit each part, then use Publish Panel to post the public ticket panel in this channel.`
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket:edit-panel").setLabel("Edit Panel").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:edit-ticket").setLabel("Edit Ticket Message").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ticket:edit-category").setLabel("Edit Category").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket:publish").setLabel("Publish Panel").setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row1, row2], ephemeral: true };
}

function buildPublicPanel(settings) {
  const embed = new EmbedBuilder()
    .setColor(0x808080)
    .setTitle(settings.panelTitle)
    .setDescription(settings.panelDescription);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:open")
      .setLabel(settings.openButtonLabel)
      .setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row] };
}

async function findOrCreateCategory(guild, name, client) {
  const existing = guild.channels.cache.find(
    channel => channel.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) return existing;

  const botMember = guild.members.me || await guild.members.fetch(client.user.id);
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Timi needs Manage Channels permission to create the ticket category.");
  }
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: "Create ticket category for Timi ticket system"
  });
}

async function openTicket(interaction, client) {
  const guild = interaction.guild;
  const userKey = `${guild.id}:${interaction.user.id}`;
  const now = Date.now();
  const lastCreated = ticketCreationCooldowns.get(userKey) || 0;
  if (now - lastCreated < TICKET_COOLDOWN_MS) {
    await interaction.reply({
      content: "Please wait a few seconds before opening another ticket.",
      ephemeral: true
    });
    return;
  }
  if (ticketCreationLocks.has(userKey)) {
    await interaction.reply({ content: "Your ticket request is already being processed.", ephemeral: true });
    return;
  }
  ticketCreationLocks.add(userKey);

  const settings = getSettings(guild.id);
  const existing = guild.channels.cache.find(channel =>
    channel.type === ChannelType.GuildText &&
    channel.parent &&
    channel.parent.name.toLowerCase() === settings.categoryName.toLowerCase() &&
    channel.topic === `timi-ticket-owner:${interaction.user.id}`
  );

  if (existing) {
    ticketCreationLocks.delete(userKey);
    await interaction.reply({
      content: `You already have an open ticket: <#${existing.id}>`,
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const category = await findOrCreateCategory(guild, settings.categoryName, client);
    const safeName = interaction.user.username
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || interaction.user.id;

    // Private by default: deny @everyone, grant the ticket owner and Timi,
    // and explicitly grant access only to roles that have ManageGuild.
    // Do not create a deny overwrite for every role: it both wastes Discord's
    // 100-overwrite limit and blocks legitimate moderators from seeing tickets.
    const managerRoles = [...guild.roles.cache.values()]
      .filter(role =>
        role.id !== guild.roles.everyone.id &&
        !role.managed &&
        role.permissions.has(PermissionFlagsBits.ManageGuild)
      )
      .slice(0, 95)
      .map(role => ({
        id: role.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }));

    const channel = await guild.channels.create({
      name: `ticket-${safeName}`.slice(0, 100),
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `timi-ticket-owner:${interaction.user.id}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...managerRoles,
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.EmbedLinks
          ]
        }
      ],
      reason: `Ticket opened by ${interaction.user.tag}`
    });

    const embed = new EmbedBuilder()
      .setColor(0x808080)
      .setTitle(settings.panelTitle)
      .setDescription(settings.ticketMessage)
      .setFooter({ text: `Ticket owner: ${interaction.user.tag}` });

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket:close")
        .setLabel(settings.closeButtonLabel)
        .setStyle(ButtonStyle.Secondary)
    );
    await channel.send({
      content: `<@!${interaction.user.id}>`,
      embeds: [embed],
      components: [closeRow],
      allowedMentions: { users: [interaction.user.id] }
    });

    ticketCreationCooldowns.set(userKey, Date.now());
    await interaction.editReply(`Your ticket has been created: <#${channel.id}>`);
  } catch (error) {
    console.error("Could not open ticket:", error.message);
    await interaction.editReply("Timi could not create your ticket. Check its Manage Channels permission and role limits.");
  } finally {
    ticketCreationLocks.delete(userKey);
    const cutoff = Date.now() - 60_000;
    for (const [key, timestamp] of ticketCreationCooldowns) {
      if (timestamp < cutoff) ticketCreationCooldowns.delete(key);
    }
  }
}

async function handleInteraction(interaction, client) {
  if (!interaction.customId?.startsWith("ticket:")) return false;

  if (!interaction.guild) {
    await interaction.reply({ content: "Tickets can only be used in a server.", ephemeral: true }).catch(() => {});
    return true;
  }

  const id = interaction.customId;

  if (id === "ticket:open") {
    await openTicket(interaction, client);
    return true;
  }

  if (id === "ticket:close") {
    const channel = interaction.channel;
    if (channel?.type !== ChannelType.GuildText || !channel.topic?.startsWith("timi-ticket-owner:")) {
      await interaction.reply({ content: "This is not a Timi ticket channel.", ephemeral: true });
      return true;
    }
    const ownerId = channel.topic.slice("timi-ticket-owner:".length);
    if (interaction.user.id !== ownerId && !isManager(interaction)) {
      await interaction.reply({ content: "Only the ticket owner or a server manager can close this ticket.", ephemeral: true });
      return true;
    }

    const confirm = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket:confirm-close")
        .setLabel("Yes, close it")
        .setStyle(ButtonStyle.Danger)
    );
    await interaction.reply({
      content: "Are you sure you want to close this ticket",
      components: [confirm],
      ephemeral: true
    });
    return true;
  }

  if (id === "ticket:confirm-close") {
    const channel = interaction.channel;
    if (channel?.type !== ChannelType.GuildText || !channel.topic?.startsWith("timi-ticket-owner:")) {
      await interaction.reply({ content: "This is not a Timi ticket channel.", ephemeral: true });
      return true;
    }
    const ownerId = channel.topic.slice("timi-ticket-owner:".length);
    if (interaction.user.id !== ownerId && !isManager(interaction)) {
      await interaction.reply({ content: "Only the ticket owner or a server manager can close this ticket.", ephemeral: true });
      return true;
    }

    await interaction.update({ content: "Closing this ticket in 5 seconds…", components: [] });
    setTimeout(() => {
      channel.delete("Ticket closed by its owner or a server manager").catch(error => {
        console.error("Could not delete closed ticket:", error.message);
      });
    }, 5000);
    return true;
  }

  if (id === "ticket:edit-panel" || id === "ticket:edit-ticket" || id === "ticket:edit-category") {
    if (!isManager(interaction)) {
      await interaction.reply({ content: "You need Manage Server permission to configure tickets.", ephemeral: true });
      return true;
    }
    const settings = getSettings(interaction.guildId);
    let modal;
    if (id === "ticket:edit-panel") {
      modal = new ModalBuilder()
        .setCustomId("ticket:modal-panel")
        .setTitle("Customize Ticket Panel")
        .addComponents(
          new ActionRowBuilder().addComponents(makeInput("title", "Panel title", settings.panelTitle)),
          new ActionRowBuilder().addComponents(makeInput("description", "Panel description", settings.panelDescription, TextInputStyle.Paragraph, 1000)),
          new ActionRowBuilder().addComponents(makeInput("open-label", "Open button label", settings.openButtonLabel, TextInputStyle.Short, 80))
        );
    } else if (id === "ticket:edit-ticket") {
      modal = new ModalBuilder()
        .setCustomId("ticket:modal-ticket")
        .setTitle("Customize Ticket Message")
        .addComponents(
          new ActionRowBuilder().addComponents(makeInput("message", "Message inside each ticket", settings.ticketMessage, TextInputStyle.Paragraph, 1000)),
          new ActionRowBuilder().addComponents(makeInput("close-label", "Close button label", settings.closeButtonLabel, TextInputStyle.Short, 80))
        );
    } else {
      modal = new ModalBuilder()
        .setCustomId("ticket:modal-category")
        .setTitle("Customize Ticket Category")
        .addComponents(
          new ActionRowBuilder().addComponents(makeInput("category", "Category name", settings.categoryName, TextInputStyle.Short, 100))
        );
    }
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit()) {
    if (!isManager(interaction)) {
      await interaction.reply({ content: "You need Manage Server permission to configure tickets.", ephemeral: true });
      return true;
    }
    const settings = getSettings(interaction.guildId);
    if (id === "ticket:modal-panel") {
      settings.panelTitle = interaction.fields.getTextInputValue("title").trim();
      settings.panelDescription = interaction.fields.getTextInputValue("description").trim();
      settings.openButtonLabel = interaction.fields.getTextInputValue("open-label").trim();
    } else if (id === "ticket:modal-ticket") {
      settings.ticketMessage = interaction.fields.getTextInputValue("message").trim();
      settings.closeButtonLabel = interaction.fields.getTextInputValue("close-label").trim();
    } else if (id === "ticket:modal-category") {
      settings.categoryName = interaction.fields.getTextInputValue("category").trim();
    } else {
      return false;
    }

    if (!settings.panelTitle || !settings.panelDescription || !settings.openButtonLabel ||
        !settings.ticketMessage || !settings.closeButtonLabel || !settings.categoryName) {
      await interaction.reply({ content: "All ticket settings must contain text.", ephemeral: true });
      return true;
    }
    saveSettings(interaction.guildId, settings);
    await interaction.update({
      ...buildConfigPanel(settings),
      content: "Ticket settings saved. Updating published panels..."
    });
    await refreshPublishedPanels(interaction.guild, settings);
    await interaction.editReply({
      ...buildConfigPanel(settings),
      content: "Ticket settings saved. Published panels have been updated."
    });
    return true;
  }

  if (id === "ticket:publish") {
    if (!isManager(interaction)) {
      await interaction.reply({ content: "You need Manage Server permission to publish a ticket panel.", ephemeral: true });
      return true;
    }
    const message = await interaction.channel.send(buildPublicPanel(getSettings(interaction.guildId)));
    rememberPublishedPanel(interaction.guildId, interaction.channelId, message.id);
    await interaction.update({
      ...buildConfigPanel(getSettings(interaction.guildId)),
      content: "Ticket panel published. This setup message has been updated; use it to continue configuring tickets."
    });
    return true;
  }

  return false;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ticketconfig")
    .setDescription("Customize and publish the ticket panel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    if (!isManager(interaction)) {
      await interaction.reply({ content: "You need Manage Server permission to configure tickets.", ephemeral: true });
      return;
    }
    await interaction.reply(buildConfigPanel(getSettings(interaction.guildId)));
  },
  handleInteraction
};

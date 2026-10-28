const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits
} = require("discord.js");

const pending = new Map();
const CONFIRMATION_CHANNEL = "timi-confirmations";

async function getConfirmationChannel(guild, client) {
  let channel = guild.channels.cache.find(
    item => item.type === ChannelType.GuildText && item.name === CONFIRMATION_CHANNEL
  );

  if (!channel) {
    const botMember = guild.members.me || await guild.members.fetch(client.user.id);
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new Error("Timi needs Manage Channels to create its confirmation channel.");
    }

    channel = await guild.channels.create({
      name: CONFIRMATION_CHANNEL,
      type: ChannelType.GuildText,
      topic: "Private bot approval requests managed by Timi.",
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: guild.ownerId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory
          ]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.EmbedLinks
          ]
        }
      ],
      reason: "Create private channel for bot approval requests"
    });
  }

  return channel;
}

async function restrictBot(member, client) {
  const guild = member.guild;
  const botMember = guild.members.me || await guild.members.fetch(client.user.id);
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("Timi needs Manage Channels to restrict a newly joined bot.");
  }

  const channel = await getConfirmationChannel(guild, client);

  for (const target of guild.channels.cache.values()) {
    if (target.id === channel.id || !target.permissionOverwrites) continue;
    await target.permissionOverwrites.edit(member.id, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
      Connect: false,
      Speak: false
    }, { reason: "Temporarily restrict bot pending Timi approval" }).catch(error => {
      console.error(`Could not restrict bot in channel ${target.id}:`, error.message);
    });
  }

  // A bot with Administrator bypasses channel overwrites; Discord does not allow Timi to override that.
  const embed = new EmbedBuilder()
    .setColor(0x808080)
    .setTitle("Bot approval required")
    .setDescription("Do you agree on giving this bot permission to serve this server?")
    .addFields(
      { name: "Bot", value: `<@${member.id}> (${member.user.tag})`, inline: false },
      { name: "Server", value: guild.name, inline: false },
      { name: "Access", value: "This bot is temporarily restricted while approval is pending.", inline: false }
    )
    .setFooter({ text: "Only the server owner or a member with Manage Server can decide." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`botguard:yes:${guild.id}:${member.id}`)
      .setLabel("Yes")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`botguard:no:${guild.id}:${member.id}`)
      .setLabel("No")
      .setStyle(ButtonStyle.Danger)
  );

  const message = await channel.send({ embeds: [embed], components: [row] });
  pending.set(`${guild.id}:${member.id}`, { messageId: message.id, channelId: channel.id });
}

async function handleInteraction(interaction, client) {
  const parts = interaction.customId.split(":");
  if (parts.length !== 4 || parts[0] !== "botguard") return false;

  const [, decision, guildId, botId] = parts;
  if (!interaction.guild || interaction.guild.id !== guildId) {
    await interaction.reply({ content: "This request belongs to another server.", ephemeral: true });
    return true;
  }

  const isOwner = interaction.user.id === interaction.guild.ownerId;
  const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!isOwner && !canManage) {
    await interaction.reply({
      content: "Only the server owner or a member with Manage Server can approve or reject bots.",
      ephemeral: true
    });
    return true;
  }

  const key = `${guildId}:${botId}`;
  const record = pending.get(key);
  if (!record || record.messageId !== interaction.message.id) {
    await interaction.reply({ content: "This bot approval request is no longer pending.", ephemeral: true });
    return true;
  }

  const guild = interaction.guild;
  const member = await guild.members.fetch(botId).catch(() => null);

  if (decision === "no") {
    if (member) {
      const botMember = guild.members.me || await guild.members.fetch(client.user.id);
      if (!botMember.permissions.has(PermissionFlagsBits.KickMembers)) {
        await interaction.reply({
          content: "Timi needs Kick Members permission to reject and remove this bot.",
          ephemeral: true
        });
        return true;
      }
      await member.kick(`Bot rejected by ${interaction.user.tag} through Timi bot protection.`);
    }
    pending.delete(key);
    await interaction.update({
      embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x808080).setTitle("Bot rejected").setDescription("The bot was rejected and removed from the server.")],
      components: []
    });
    return true;
  }

  if (decision === "yes") {
    if (!member) {
      pending.delete(key);
      await interaction.update({
        embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setTitle("Bot no longer in server").setDescription("The bot left before approval was completed.")],
        components: []
      });
      return true;
    }

    const botMember = guild.members.me || await guild.members.fetch(client.user.id);
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({ content: "Timi needs Manage Channels permission to restore the bot's access.", ephemeral: true });
      return true;
    }

    const baseline = {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      EmbedLinks: true,
      AttachFiles: true,
      UseApplicationCommands: true,
      Connect: true,
      Speak: true
    };

    for (const target of guild.channels.cache.values()) {
      if (!target.permissionOverwrites) continue;
      await target.permissionOverwrites.edit(botId, baseline, {
        reason: `Bot approved by ${interaction.user.tag} through Timi bot protection`
      }).catch(error => {
        console.error(`Could not grant approved bot access in channel ${target.id}:`, error.message);
      });
    }

    pending.delete(key);
    await interaction.update({
      embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x808080).setTitle("Bot approved").setDescription("The bot was approved. Timi granted a standard set of channel permissions.")],
      components: []
    });
    return true;
  }

  return false;
}

module.exports = {
  async onGuildMemberAdd(member, client) {
    if (!member.user.bot || member.id === client.user.id) return;
    try {
      await restrictBot(member, client);
    } catch (error) {
      console.error("Bot protection could not process a new bot:", error.message);
    }
  },
  handleInteraction
};

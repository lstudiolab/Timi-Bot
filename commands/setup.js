const {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder
} = require("discord.js");

const { getSettings, saveSettings } = require("./moderation-panel");

function privateOverwrites(guild, userId, botId) {
  const allowed = {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    EmbedLinks: true,
    AttachFiles: true
  };

  return [
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
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    },
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageMessages
      ]
    }
  ];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ticket-setup")
    .setDescription("Create Timi's private channels and ticket category.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction, client) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({
        content: "This command can only be used inside a server.",
        ephemeral: true
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "You need the Manage Server permission to run setup.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const botMember = guild.members.me || await guild.members.fetch(client.user.id);

    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.editReply(
        "Timi needs the Manage Channels permission to create the private channels."
      );
      return;
    }

    try {
      // Ensure the standard ticket category exists as part of setup.
      const ticketCategoryName = "ticket";
      let ticketCategory = guild.channels.cache.find(
        channel => channel.type === ChannelType.GuildCategory &&
          channel.name.toLowerCase() === ticketCategoryName
      );
      if (!ticketCategory) {
        ticketCategory = await guild.channels.create({
          name: ticketCategoryName,
          type: ChannelType.GuildCategory,
          reason: `Create ticket category during setup requested by ${interaction.user.tag}`
        });
      }

      const names = [
        { name: "timi-logs", topic: "Private moderation and anti-spam logs for Timi." },
        { name: "timi-confirmations", topic: "Private setup and moderation confirmations for Timi." }
      ];

      const existing = names.find(item => guild.channels.cache.some(
        candidate => candidate.type === ChannelType.GuildText && candidate.name === item.name
      ));
      if (existing) {
        await interaction.editReply(
          `A channel named #${existing.name} already exists. Rename or remove it, then run /setup again. No existing channel permissions were changed.`
        );
        return;
      }

      const created = [];
      const overwrites = privateOverwrites(guild, interaction.user.id, client.user.id);

      for (const item of names) {
        const channel = await guild.channels.create({
          name: item.name,
          type: ChannelType.GuildText,
          topic: item.topic,
          permissionOverwrites: overwrites,
          reason: `Timi setup requested by ${interaction.user.tag}`
        });
        created.push(channel);
      }

      const logChannel = created.find(channel => channel.name === "timi-logs");
      const confirmationChannel = created.find(channel => channel.name === "timi-confirmations");

      // Save the newly created log channel as the moderation panel's log destination.
      const settings = getSettings(guild);
      settings.logChannelId = logChannel.id;
      saveSettings(guild.id, settings);

      // Store the channel IDs in the guild's channel topic so administrators can identify them.
      await confirmationChannel.send({
        content: `Timi setup completed by <@${interaction.user.id}>. The private log channel is <#${logChannel.id}>. These channels are restricted to the server owner, the user who ran /setup, and Timi.`
      });

      await interaction.editReply(
        `Setup complete. Created <#${logChannel.id}>, <#${confirmationChannel.id}>, and the ${ticketCategoryName} category. The private channels are restricted as configured, and the log channel is selected for moderation reports.`
      );
    } catch (error) {
      console.error("Setup command failed:", error);
      await interaction.editReply(
        "Timi could not finish setup. Check that it has Manage Channels permission and that its role is high enough."
      ).catch(() => {});
    }
  }
};

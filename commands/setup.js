const {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder
} = require("discord.js");

const { getSettings } = require("./moderation-panel");

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
    .setName("setup")
    .setDescription("Create Timi's private log and confirmation channels.")
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
      const names = [
        { name: "timi-logs", topic: "Private moderation and anti-spam logs for Timi." },
        { name: "timi-confirmations", topic: "Private setup and moderation confirmations for Timi." }
      ];

      const created = [];
      const overwrites = privateOverwrites(guild, interaction.user.id, client.user.id);

      for (const item of names) {
        let channel = guild.channels.cache.find(
          candidate => candidate.type === ChannelType.GuildText && candidate.name === item.name
        );

        if (!channel) {
          channel = await guild.channels.create({
            name: item.name,
            type: ChannelType.GuildText,
            topic: item.topic,
            permissionOverwrites: overwrites,
            reason: `Timi setup requested by ${interaction.user.tag}`
          });
          created.push(channel);
        } else {
          // Existing channels are not reused automatically because their permissions may be public.
          await interaction.editReply(
            `A channel named #${item.name} already exists. Rename or remove it, then run /setup again. No existing channel permissions were changed.`
          );
          return;
        }
      }

      const logChannel = created.find(channel => channel.name === "timi-logs");
      const confirmationChannel = created.find(channel => channel.name === "timi-confirmations");

      // Save the newly created log channel as the moderation panel's log destination.
      const settings = getSettings(guild);
      settings.logChannelId = logChannel.id;

      // Store the channel IDs in the guild's channel topic so administrators can identify them.
      await confirmationChannel.send({
        content: `Timi setup completed by <@${interaction.user.id}>. The private log channel is <#${logChannel.id}>. These channels are restricted to the server owner, the user who ran /setup, and Timi.`
      });

      await interaction.editReply(
        `Setup complete. Created <#${logChannel.id}> and <#${confirmationChannel.id}>. They are private to you, the server owner, and Timi. The log channel is selected for moderation reports. If you need these settings to survive a restart, select the log channel in /moderation-panel as well.`
      );
    } catch (error) {
      console.error("Setup command failed:", error);
      await interaction.editReply(
        "Timi could not finish setup. Check that it has Manage Channels permission and that its role is high enough."
      ).catch(() => {});
    }
  }
};

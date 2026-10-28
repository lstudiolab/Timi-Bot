const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder().setName("serverinfo").setDescription("Show information about this server."),
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    const guild = interaction.guild;
    const owner = await guild.fetchOwner().catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(0x808080)
      .setTitle(guild.name);
    const iconUrl = guild.iconURL({ size: 256 });
    if (iconUrl) embed.setThumbnail(iconUrl);
    embed.addFields(
        { name: "Owner", value: owner ? "<@" + owner.id + ">" : "Unavailable", inline: true },
        { name: "Members", value: String(guild.memberCount), inline: true },
        { name: "Channels", value: String(guild.channels.cache.size), inline: true },
        { name: "Roles", value: String(guild.roles.cache.size), inline: true },
        { name: "Created", value: "<t:" + Math.floor(guild.createdTimestamp / 1000) + ":D>", inline: true },
        { name: "Server ID", value: guild.id, inline: true }
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};

const { EmbedBuilder, SlashCommandBuilder } = require("discord.js");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Show information about a server member.")
    .addUserOption(option => option.setName("member").setDescription("Member to inspect")),
  async execute(interaction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }
    const user = interaction.options.getUser("member") || interaction.user;
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(0x808080)
      .setTitle(user.tag || user.username)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "User ID", value: user.id, inline: true },
        { name: "Account created", value: "<t:" + Math.floor(user.createdTimestamp / 1000) + ":D>", inline: true },
        { name: "Joined server", value: member?.joinedTimestamp ? "<t:" + Math.floor(member.joinedTimestamp / 1000) + ":D>" : "Not a member", inline: true },
        { name: "Bot account", value: user.bot ? "Yes" : "No", inline: true },
        { name: "Roles", value: member ? member.roles.cache.filter(role => role.id !== interaction.guild.id).map(role => "<@&" + role.id + ">").slice(0, 15).join(", ") || "None" : "Not a member", inline: false }
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
};

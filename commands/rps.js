const { SlashCommandBuilder } = require("discord.js");

const options = ["rock", "paper", "scissors"];
const beats = { rock: "scissors", paper: "rock", scissors: "paper" };

module.exports = {
  data: new SlashCommandBuilder()
    .setName("rps")
    .setDescription("Play rock-paper-scissors against Timi.")
    .addStringOption(option => option.setName("choice").setDescription("Choose rock, paper, or scissors").setRequired(true).addChoices(
      { name: "Rock", value: "rock" },
      { name: "Paper", value: "paper" },
      { name: "Scissors", value: "scissors" }
    )),
  async execute(interaction) {
    const player = interaction.options.getString("choice", true);
    const bot = options[Math.floor(Math.random() * options.length)];
    const result = player === bot ? "It is a tie." : beats[player] === bot ? "You win." : "Timi wins.";
    await interaction.reply({ content: "You chose **" + player + "**. Timi chose **" + bot + "**. " + result });
  }
};

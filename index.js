require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error("Missing DISCORD_TOKEN. Add it to your local .env file.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`Timi is online as ${client.user.tag}`);
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.login(token).catch((error) => {
  console.error("Timi could not log in. Check DISCORD_TOKEN and try again.");
  console.error(error.message);
  process.exit(1);
});

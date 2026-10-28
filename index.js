require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes
} = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token) {
  console.error("Missing DISCORD_TOKEN. Add it to your local .env file.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = new Map();
const commandsPath = path.join(__dirname, "commands");

if (fs.existsSync(commandsPath)) {
  for (const file of fs.readdirSync(commandsPath).filter(name => name.endsWith(".js"))) {
    const command = require(path.join(commandsPath, file));
    if (command.data && command.execute) {
      commands.set(command.data.name, command);
    }
  }
}

async function registerSlashCommands() {
  if (!clientId) {
    console.error("Missing CLIENT_ID. Add your Discord application ID to .env; slash commands were not registered.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);

  await rest.put(route, {
    body: [...commands.values()].map(command => command.data.toJSON())
  });

  console.log(
    `Registered ${commands.size} slash command(s) ${guildId ? `to test server ${guildId}` : "globally"}.`
  );
}

client.once("ready", async () => {
  console.log(`Timi is online as ${client.user.tag}`);
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("Could not register slash commands:", error.message);
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (command) await command.execute(interaction, client);
      return;
    }

    if (
      interaction.customId?.startsWith("modpanel:") &&
      commands.has("moderation-panel")
    ) {
      await commands.get("moderation-panel").handleInteraction(interaction, client);
    }
  } catch (error) {
    console.error("Interaction failed:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Timi could not complete that action. Check the bot console for details.",
        ephemeral: true
      }).catch(() => {});
    }
  }
});

client.on("error", error => {
  console.error("Discord client error:", error);
});

client.login(token).catch(error => {
  console.error("Timi could not log in. Check DISCORD_TOKEN and try again.");
  console.error(error.message);
  process.exit(1);
});

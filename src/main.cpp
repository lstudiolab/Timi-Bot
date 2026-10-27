#include <dpp/dpp.h>

#include <cstdlib>
#include <iostream>
#include <string>

int main() {
    const char* token = std::getenv("DISCORD_TOKEN");
    if (token == nullptr || std::string(token).empty()) {
        std::cerr << "Configuration error: DISCORD_TOKEN is not set.\n";
        return 1;
    }

    dpp::cluster bot(token, dpp::i_default_intents);
    bot.on_log(dpp::utility::cout_logger());

    bot.on_ready([&bot](const dpp::ready_t&) {
        if (!dpp::run_once<struct register_timi_commands>()) {
            return;
        }

        const dpp::snowflake application_id = bot.me.id;
        bot.global_command_create(
            dpp::slashcommand("ping", "Check whether Timi is responding.", application_id)
        );
        bot.global_command_create(
            dpp::slashcommand("about", "Learn what Timi is.", application_id)
        );
        bot.global_command_create(
            dpp::slashcommand("help", "Show the available Timi commands.", application_id)
        );

        std::cout << "Timi is online as " << bot.me.username << ".\n";
    });

    bot.on_slashcommand([](const dpp::slashcommand_t& event) {
        const std::string command = event.command.get_command_name();

        if (command == "ping") {
            event.reply(dpp::message("Pong. Timi is online."));
            return;
        }

        if (command == "about") {
            dpp::embed embed = dpp::embed()
                .set_title("Timi")
                .set_description("A modular Discord bot built in C++.")
                .add_field("Current status", "Core connection and slash commands are active.", false)
                .add_field("Planned systems", "Welcome messages, embeds, buttons, tickets, moderation, and per-server settings.", false)
                .set_color(dpp::rgb(90, 90, 95));
            event.reply(dpp::message().add_embed(embed));
            return;
        }

        if (command == "help") {
            dpp::embed embed = dpp::embed()
                .set_title("Timi commands")
                .set_description("Here are the commands currently available.")
                .add_field("/ping", "Check whether Timi is responding.", false)
                .add_field("/about", "Learn about Timi and its roadmap.", false)
                .add_field("/help", "Show this command list.", false)
                .set_color(dpp::rgb(90, 90, 95));
            event.reply(dpp::message().add_embed(embed));
        }
    });

    bot.start(dpp::st_wait);
    return 0;
}

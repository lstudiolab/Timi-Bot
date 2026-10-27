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

    bot.on_ready([&bot](const dpp::ready_t& event) {
        if (dpp::run_once<struct register_timi_commands>()) {
            bot.global_command_create(
                dpp::slashcommand("ping", "Check whether Timi is responding.", bot.me.id)
            );
            std::cout << "Timi is online as " << bot.me.username << ".\n";
        }
    });

    bot.on_slashcommand([&bot](const dpp::slashcommand_t& event) {
        if (event.command.get_command_name() == "ping") {
            event.reply(dpp::message("Pong. Timi is online."));
        }
    });

    bot.start(dpp::st_wait);
    return 0;
}

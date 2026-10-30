//! Server setup plan. Creation is performed by the Discord gateway layer.
#[derive(Debug, Clone)]
pub struct PrivateChannelSpec { pub name: &'static str, pub topic: &'static str }
pub const PRIVATE_CHANNELS: [PrivateChannelSpec; 2] = [
    PrivateChannelSpec { name:"timi-logs", topic:"Private moderation and anti-spam logs for Timi." },
    PrivateChannelSpec { name:"timi-confirmations", topic:"Private setup and moderation confirmations for Timi." },
];
pub const DEFAULT_TICKET_CATEGORY: &str = "ticket";
pub fn setup_allowed(is_in_guild: bool, has_manage_guild: bool, bot_can_manage_channels: bool) -> Result<(), &'static str> {
    if !is_in_guild { return Err("This command can only be used inside a server."); }
    if !has_manage_guild { return Err("You need the Manage Server permission to run setup."); }
    if !bot_can_manage_channels { return Err("Timi needs the Manage Channels permission to create the private channels."); }
    Ok(())
}

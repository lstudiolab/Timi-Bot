use anyhow::{anyhow, bail, Context as AnyhowContext, Result};
use chrono::{Duration as ChronoDuration, Utc};
use regex::Regex;
use reqwest::{Client as HttpClient, Method, StatusCode};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use serenity::{
    all::{GatewayIntents, GuildChannel, Interaction, Member, Message, Ready, User},
    async_trait,
    prelude::{Context, EventHandler},
    Client as DiscordClient,
};
use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::time::{sleep, Duration};
use tracing::{error, info, warn};

const API: &str = "https://discord.com/api/v10";
const VIEW: u64 = 1 << 10;
const SEND: u64 = 1 << 11;
const MANAGE_CHANNELS: u64 = 1 << 4;
const MANAGE_GUILD: u64 = 1 << 5;
const MANAGE_ROLES: u64 = 1 << 28;
const KICK: u64 = 1 << 1;
const BAN: u64 = 1 << 2;
const MANAGE_MESSAGES: u64 = 1 << 13;
const MANAGE_THREADS: u64 = 1 << 34;
const CREATE_PRIVATE_THREADS: u64 = 1 << 36;
const SEND_MESSAGES_IN_THREADS: u64 = 1 << 38;
const MODERATE: u64 = 1 << 40;
const HISTORY: u64 = 1 << 16;
const ATTACH: u64 = 1 << 15;
const EMBED: u64 = 1 << 14;
const DAY: i64 = 86_400_000;
const WEEK: i64 = 7 * DAY;
const MAX_MESSAGE_BACKUP: usize = 25_000;


// Implementation is split by subsystem to keep debugging and maintenance focused.
include!("config.rs");
include!("discord.rs");
include!("commands.rs");
include!("embeds.rs");\ninclude!("embeds.rs");
include!("tickets.rs");
include!("role_picker.rs");
include!("moderation.rs");
include!("verification.rs");
include!("protection.rs");
include!("recovery.rs");
include!("events.rs");

#[tokio::main]
async fn main()->Result<()>{
    tracing_subscriber::fmt().with_env_filter(env::var("RUST_LOG").unwrap_or_else(|_|"info".into())).init();
    let config=Config::load()?;let state=State::new(config.clone())?;
    let intents=GatewayIntents::GUILDS|GatewayIntents::GUILD_MEMBERS|GatewayIntents::GUILD_MESSAGES|GatewayIntents::MESSAGE_CONTENT;
    let mut client=DiscordClient::builder(&config.token,intents).event_handler(Handler{state}).await.context("Could not create Discord client")?;
    info!("Starting Timi Rust runtime.");
    client.start().await.context("Discord gateway stopped unexpectedly")?;
    Ok(())
}


#[cfg(test)]
include!("tests.rs");

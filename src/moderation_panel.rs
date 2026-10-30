//! Moderation settings and validation used by the moderation configuration UI.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub sanction: String,
    pub timeout_minutes: u64,
    pub log_channel_id: Option<String>,
    pub action_duration_seconds: u64,
    pub max_message_count: usize,
    pub block_invites: bool,
    pub block_mass_mentions: bool,
    pub block_excessive_caps: bool,
    pub panel_channel_id: Option<String>,
    pub panel_message_id: Option<String>,
}
impl Default for Settings {
    fn default() -> Self { Self { enabled:true, sanction:"timeout".into(), timeout_minutes:10,
        log_channel_id:None, action_duration_seconds:3, max_message_count:3,
        block_invites:true, block_mass_mentions:true, block_excessive_caps:true,
        panel_channel_id:None, panel_message_id:None } }
}
impl Settings {
    pub fn normalize(&mut self) {
        if !["timeout","kick","ban","delete"].contains(&self.sanction.as_str()) { self.sanction="timeout".into(); }
        self.timeout_minutes=self.timeout_minutes.clamp(1, 10080);
        self.action_duration_seconds=self.action_duration_seconds.clamp(1, 60);
        self.max_message_count=self.max_message_count.clamp(1, 100);
    }
    pub fn sanction_label(&self) -> String {
        match self.sanction.as_str() {
            "kick"=>"Kick member".into(), "ban"=>"Ban member".into(),
            "delete"=>"Delete messages only".into(),
            _=>format!("Member timeout ({} minutes)", self.timeout_minutes)
        }
    }
}
pub fn is_exempt(has_manage_messages: bool, is_administrator: bool) -> bool {
    has_manage_messages || is_administrator
}

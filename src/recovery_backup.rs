//! Recovery archive retention and bounded storage helpers.
use serde::{Deserialize, Serialize};
pub const RETENTION_DAYS:i64=7;
pub const MAX_MESSAGES_PER_GUILD:usize=25_000;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ArchivedMessage {
    pub id:String, pub channel_id:String, pub author_id:String, pub author_tag:String,
    pub content:String, pub created_at:i64, pub edited_at:Option<i64>,
    #[serde(default)] pub attachments:Vec<serde_json::Value>,
}
pub fn prune_messages(messages:&mut Vec<ArchivedMessage>, now_ms:i64) {
    let cutoff=now_ms-RETENTION_DAYS*86_400_000;
    messages.retain(|message| message.created_at>=cutoff);
    if messages.len()>MAX_MESSAGES_PER_GUILD {
        let excess=messages.len()-MAX_MESSAGES_PER_GUILD;
        messages.drain(0..excess);
    }
}

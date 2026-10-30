//! Bot admission policy and pending approval state.
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision { Approve, Reject }

#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub guild_id: String,
    pub bot_id: String,
    pub message_id: String,
    pub channel_id: String,
}

#[derive(Default)]
pub struct ApprovalRegistry { pending: HashMap<(String, String), PendingApproval> }

impl ApprovalRegistry {
    pub fn insert(&mut self, approval: PendingApproval) {
        self.pending.insert((approval.guild_id.clone(), approval.bot_id.clone()), approval);
    }
    pub fn get(&self, guild_id: &str, bot_id: &str) -> Option<&PendingApproval> {
        self.pending.get(&(guild_id.to_owned(), bot_id.to_owned()))
    }
    pub fn consume(&mut self, guild_id: &str, bot_id: &str, message_id: &str) -> Option<PendingApproval> {
        let key = (guild_id.to_owned(), bot_id.to_owned());
        if self.pending.get(&key).is_some_and(|item| item.message_id == message_id) {
            self.pending.remove(&key)
        } else { None }
    }
    pub fn len(&self) -> usize { self.pending.len() }
    pub fn is_empty(&self) -> bool { self.pending.is_empty() }
}

pub fn may_decide(is_owner: bool, has_manage_guild: bool) -> bool {
    is_owner || has_manage_guild
}

pub fn restriction_permissions() -> [&'static str; 5] {
    ["ViewChannel", "SendMessages", "ReadMessageHistory", "Connect", "Speak"]
}

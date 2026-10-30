//! Ticket panel configuration model and invariants.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub panel_title:String, pub panel_description:String, pub open_button_label:String,
    pub ticket_message:String, pub close_button_label:String, pub category_name:String,
    pub support_role_id:Option<String>, pub transcript_channel_id:Option<String>,
    pub panel_channel_id:Option<String>, pub panel_message_id:Option<String>,
}
impl Default for Settings {
    fn default()->Self { Self { panel_title:"Support Tickets".into(),
        panel_description:"Need help? Open a ticket and our team will assist you.".into(),
        open_button_label:"Open Ticket".into(),
        ticket_message:"Please describe what you need help with. A member of the support team will be with you shortly.".into(),
        close_button_label:"Close Ticket".into(), category_name:"ticket".into(),
        support_role_id:None, transcript_channel_id:None, panel_channel_id:None, panel_message_id:None } }
}
impl Settings {
    pub fn normalize(&mut self) {
        self.panel_title=self.panel_title.trim().chars().take(100).collect();
        self.panel_description=self.panel_description.trim().chars().take(4000).collect();
        self.open_button_label=self.open_button_label.trim().chars().take(80).collect();
        self.close_button_label=self.close_button_label.trim().chars().take(80).collect();
        self.ticket_message=self.ticket_message.trim().chars().take(4000).collect();
        self.category_name=self.category_name.trim().to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c=='-').take(90).collect();
        if self.category_name.is_empty() { self.category_name="ticket".into(); }
    }
}
pub fn ticket_channel_name(username: &str) -> String {
    let normalized:String=username.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let compact=normalized.split('-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    format!("ticket-{}", compact.chars().take(85).collect::<String>())
}

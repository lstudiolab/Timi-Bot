//! Public verification panel defaults and component identifiers.
pub const VERIFY_BUTTON_ID:&str="verify:start";
pub const DEFAULT_TITLE:&str="Verify your account";
pub const DEFAULT_DESCRIPTION:&str="Press Verify to have Timi assess your account and server history.";
pub fn panel_text(title:&str, description:&str)->String {
    format!("{}\n\n{}", if title.trim().is_empty(){DEFAULT_TITLE}else{title.trim()},
        if description.trim().is_empty(){DEFAULT_DESCRIPTION}else{description.trim()})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verification_thresholds_match_policy() {
        let thresholds=Limits{pass:80,review:60};
        assert_eq!(verification_decision(100,false,&thresholds),"pass");
        assert_eq!(verification_decision(80,false,&thresholds),"pass");
        assert_eq!(verification_decision(79,false,&thresholds),"review");
        assert_eq!(verification_decision(60,false,&thresholds),"review");
        assert_eq!(verification_decision(59,false,&thresholds),"kick");
        assert_eq!(verification_decision(0,true,&thresholds),"review");
        assert_eq!(verification_decision(100,true,&thresholds),"review");
    }

    #[test]
    fn duplicate_similarity_uses_jaccard_similarity() {
        assert!((similarity("one two three","one two three")-1.0).abs()<f64::EPSILON);
        assert!((similarity("one two","one three")-(1.0/3.0)).abs()<f64::EPSILON);
        assert_eq!(similarity("one two","three four"),0.0);
        assert_eq!(similarity("","one"),0.0);
    }

    #[test]
    fn message_normalization_removes_case_punctuation_and_ids() {
        assert_eq!(normalize("HELLO, World! https://example.com <@12345678901234567>"),"hello world url mention");
    }

    #[test]
    fn message_normalization_removes_unicode_punctuation_and_symbols() {
        assert_eq!(normalize("Hello, WORLD!!! ＋ café — test."), "hello world café test");
    }

    #[test]
    fn snowflake_validation_rejects_non_discord_ids() {
        assert!(snowflake("12345678901234567"));
        assert!(!snowflake("1234"));
        assert!(!snowflake("1234567890123456x"));
    }
    #[test]
    fn legacy_nullable_settings_are_imported_safely() {
        let settings: ModSettings = serde_json::from_value(json!({
            "enabled": false,
            "logChannelId": null,
            "panelChannelId": null,
            "panelMessageId": null
        })).expect("legacy nullable moderation fields should deserialize");
        assert!(!settings.enabled);
        assert!(settings.log_channel_id.is_empty());
        assert!(settings.panel_channel_id.is_empty());
        assert!(settings.panel_message_id.is_empty());
    }

    
    #[test]
    fn component_modal_openers_are_not_deferred() {
        assert!(component_opens_modal("rolepicker:start", false, false));
        assert!(component_opens_modal("ticket:wizard-start", true, false));
        assert!(component_opens_modal("ticket:edit-ticket", true, false));
        assert!(!component_opens_modal("ticket:wizard-start", false, false));
        assert!(component_opens_modal("modpanel:sanction", true, false));
        assert!(!component_opens_modal("modpanel:log", true, false));
        assert!(component_opens_modal("embed:content:welcome", true, true));
        assert!(!component_opens_modal("embed:content:welcome", false, true));
        assert!(!component_opens_modal("embed:unknown:welcome", true, true));
    }

    
    #[test]
    fn ticket_close_confirmation_has_confirm_and_cancel_actions() {
        let components=ticket_close_confirmation_components();
        assert_eq!(components.len(),1);
        let buttons=components[0]["components"].as_array().expect("confirmation row buttons");
        assert_eq!(buttons.len(),2);
        assert_eq!(buttons[0]["custom_id"],"ticket:confirm-close");
        assert_eq!(buttons[1]["custom_id"],"ticket:cancel-close");
        assert_eq!(buttons[0]["style"],2);
        assert_eq!(buttons[1]["style"],2);
    }

}

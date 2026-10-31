async fn mod_component(s:&Arc<State>,id:&str,t:&str,v:&Value,custom:&str)->Result<()>{
    if !manage_guild(v){return s.reply(id,t,"You need Manage Server permission to edit moderation settings.",true).await;}
    let g=guild_id(v);let x=s.mods(&g);let mut next=x.clone();
    match custom{
        // Modal and ephemeral selector responses are themselves the initial acknowledgement.
        "modpanel:sanction"=>return s.callback(id,t,9,Some(modal("modpanel:sanction-modal","Edit applied sanction",vec![
            input("sanction","Sanction: timeout, kick, ban, delete",&x.sanction,false,12),
            input("timeout-minutes","Timeout duration in minutes",&x.timeout_minutes.to_string(),false,5)]) )).await,
        "modpanel:duration"|"modpanel:max-count"=>{
            let d=custom=="modpanel:duration";
            return s.callback(id,t,9,Some(modal(if d{"modpanel:duration-modal"}else{"modpanel:max-count-modal"},if d{"Edit action duration"}else{"Edit max message count"},
                vec![input("value",if d{"Action duration in seconds"}else{"Maximum message count"},if d{x.action_duration_seconds.to_string()}else{x.max_message_count.to_string()}.as_str(),false,3)]))).await;
        }
        "modpanel:log"=>{
            return s.callback(id,t,4,Some(json!({"content":"Select the channel where moderation logs should be sent.",
                "components":[row(vec![json!({"type":8,"custom_id":"modpanel:log-select","placeholder":"Select a log channel","channel_types":[0],"min_values":1,"max_values":1})])],
                "flags":64}))).await;
        }
        "modpanel:enable"|"modpanel:disable"|"modpanel:log-select"|"modpanel:invites"|"modpanel:mentions"|"modpanel:caps"=>{},
        _=>return Ok(())
    }
    // Acknowledge component clicks before saving, refreshing, or making any REST calls.
    s.callback(id,t,6,None).await?;
    if custom=="modpanel:log-select"{
        let selected=v.pointer("/data/values/0").and_then(Value::as_str).unwrap_or("");
        if !snowflake(selected){return s.edit_original(t,"Select a valid text channel.").await;}
        next.log_channel_id=selected.to_owned();
        s.save_mods(&g,next.clone())?;
        refresh_mod_panel(s,&next).await;
        return s.edit_original(t,&format!("Log channel set to <#{selected}>.")).await;
    }
    match custom{
        "modpanel:enable"|"modpanel:disable"=>next.enabled=custom=="modpanel:enable",
        "modpanel:invites"=>next.block_invites=!next.block_invites,
        "modpanel:mentions"=>next.block_mass_mentions=!next.block_mass_mentions,
        "modpanel:caps"=>next.block_excessive_caps=!next.block_excessive_caps,
        _=>{}
    }
    s.save_mods(&g,next.clone())?;
    s.edit_original_with_components(t,&mod_text(&next),mod_components(&next)).await
}

async fn moderate(s:&Arc<State>,msg:&Message)->Result<()>{
    let Some(gid)=msg.guild_id else{return Ok(());};let g=gid.get().to_string();let u=msg.author.id.get().to_string();
    if msg.author.bot||is_guild_owner(s,&g,&u).await{return Ok(());}let settings=s.mods(&g);if !settings.enabled{return Ok(());}
    let Some(member)=msg.member.as_ref()else{return Ok(());};if is_mod(s,&g,&member.roles).await{return Ok(());}
    let key=format!("{g}:{}:{u}",msg.channel_id.get());let timestamp=now();let content=normalize(&msg.content);
    let blocked=s.store.lock().ok().and_then(|store|store.automod_words.get(&g).cloned()).unwrap_or_default();
    if let Some(word)=blocked.iter().find(|word|!word.is_empty()&&msg.content.to_lowercase().contains(word.as_str())){
        let reason=format!("blocked word or phrase: {word}");
        let _=s.api(Method::DELETE,&format!("/channels/{}/messages/{}",msg.channel_id.get(),msg.id.get()),None).await;
        s.update_member(&g,&u,|r|{r.suspicious+=1;r.last_suspicious=now();r.last_reason=reason.clone();})?;
        log_to(s,&g,&settings.log_channel_id,&format!("AutoMod removed a message from <@{u}> in <#{}>. Reason: {reason}.",msg.channel_id.get())).await;
        return Ok(());
    }
    let mentions=msg.mentions.len()+msg.mention_roles.len();
    let invite=Regex::new(r"(?i)(discord\.gg/|discord(?:app)?\.com/invite/)").unwrap().is_match(&msg.content);
    let letters:Vec<char>=msg.content.chars().filter(|c|c.is_ascii_alphabetic()).collect();
    let upper=letters.iter().filter(|c|c.is_ascii_uppercase()).count();
    let caps=letters.len()>=12&&(upper as f64/letters.len()as f64)>=0.75;
    let links=Regex::new(r"(?i)https?://\S+").unwrap().find_iter(&msg.content).count();
    let mut reason=String::new();let ids:Vec<String>;
    {
        let mut rt=s.runtime.lock().map_err(|_|anyhow!("runtime lock poisoned"))?;let q=rt.spam.entry(key.clone()).or_default();
        while q.front().is_some_and(|e|timestamp-e.at>20_000){q.pop_front();}
        q.push_back(SpamEntry{id:msg.id.get().to_string(),at:timestamp,content:content.clone(),link_count:links});
        while q.len()>100{q.pop_front();}ids=q.iter().filter(|e|timestamp-e.at<=8_000).map(|e|e.id.clone()).collect();
        if q.iter().filter(|e|timestamp-e.at<=8_000).count()>=settings.max_message_count.max(2){reason="message burst".into();}
        if reason.is_empty()&&content.len()>=4&&q.iter().any(|e|e.id!=msg.id.get().to_string()&&similarity(&content,&e.content)>=0.88){reason="repeated or near-identical message".into();}
        if reason.is_empty()&&settings.block_mass_mentions&&(msg.mention_everyone||mentions>=5){reason=if msg.mention_everyone{"mass mention (@everyone or @here)".into()}else{format!("mention spam ({mentions} mentions)")};}
        if reason.is_empty()&&settings.block_invites&&invite{reason="unapproved Discord invite link".into();}
        if reason.is_empty()&&settings.block_excessive_caps&&caps{reason=format!("excessive capital letters ({:.0}% uppercase)",upper as f64/letters.len()as f64*100.0);}
        if reason.is_empty()&&links>=4{reason=format!("link spam ({links} links)");}
        if reason.is_empty()&&q.iter().filter(|e|timestamp-e.at<=8_000).map(|e|e.link_count).sum::<usize>()>=5{reason="rapid link posting".into();}
        if !reason.is_empty(){rt.spam.remove(&key);}
    }
    if reason.is_empty(){return Ok(());}
    s.update_member(&g,&u,|r|{r.suspicious+=1;r.last_suspicious=timestamp;r.last_reason=reason.clone();})?;
    if !ids.is_empty(){let _=s.api(Method::POST,&format!("/channels/{}/messages/bulk-delete",msg.channel_id.get()),Some(json!({"messages":ids.into_iter().take(100).collect::<Vec<_>>()}))).await;}
    let mut action="messages deleted".to_owned();
    match settings.sanction.as_str(){
        "timeout"=>{let until=Utc::now()+ChronoDuration::minutes(settings.timeout_minutes.min(40320)as i64);
            if s.api(Method::PATCH,&format!("/guilds/{g}/members/{u}"),Some(json!({"communication_disabled_until":until.to_rfc3339(),"reason":reason}))).await.is_ok(){action=format!("timed out for {} minute(s)",settings.timeout_minutes)}}
        "kick"=>{if s.api(Method::DELETE,&format!("/guilds/{g}/members/{u}?reason=Anti-spam"),None).await.is_ok(){action="kicked".into();}}
        "ban"=>{if s.api(Method::PUT,&format!("/guilds/{g}/bans/{u}?reason=Anti-spam"),Some(json!({"delete_message_seconds":settings.action_duration_seconds.min(60)}))).await.is_ok(){action="banned".into();}}
        _=>{}
    }
    log_to(s,&g,&settings.log_channel_id,&format!("Anti-spam action: {action}. Member: <@{u}>. Channel: <#{}>. Reason: {reason}.",msg.channel_id.get())).await;
    Ok(())
}

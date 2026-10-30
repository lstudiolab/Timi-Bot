async fn snapshot_channel(s:&State,c:&GuildChannel){
    let g=c.guild_id.get().to_string();let id=c.id.get().to_string();
    if let Ok(raw)=s.api(Method::GET,&format!("/channels/{id}"),None).await{
        if let Ok(mut store)=s.store.lock(){store.channels.insert(format!("{g}:{id}"),raw);}
        let _=s.persist();
    }
}
async fn backup_message(s:&Arc<State>,msg:&Message)->Result<()>{
    let Some(guild)=msg.guild_id else{return Ok(());};
    if msg.author.bot||msg.content.is_empty()&&msg.attachments.is_empty(){return Ok(());}
    let g=guild.get().to_string();let timestamp=snowflake_time(&msg.id.get().to_string());
    let attachments=msg.attachments.iter().take(10).map(|file|json!({
        "name":file.filename,"url":file.url,"content_type":file.content_type,"size":file.size
    })).collect::<Vec<_>>();
    {
        let mut store=s.store.lock().map_err(|_|anyhow!("store lock poisoned"))?;
        let list=store.messages.entry(g).or_default();
        list.push(json!({
            "id":msg.id.get().to_string(),
            "channel_id":msg.channel_id.get().to_string(),
            "author_id":msg.author.id.get().to_string(),
            "author_tag":msg.author.name,
            "content":msg.content.chars().take(4000).collect::<String>(),
            "timestamp_ms":timestamp,
            "attachments":attachments
        }));
        list.retain(|item|timestamp-item["timestamp_ms"].as_i64().unwrap_or(timestamp)<=WEEK);
        if list.len()>MAX_MESSAGE_BACKUP{let excess=list.len()-MAX_MESSAGE_BACKUP;list.drain(0..excess);}
    }
    s.schedule_persist();
    Ok(())
}

async fn channel_delete(s:&Arc<State>,c:&GuildChannel)->Result<()>{
    let g=c.guild_id.get().to_string();let id=c.id.get().to_string();
    // Audit log entries can arrive shortly after the gateway event.
    sleep(Duration::from_millis(1_200)).await;
    let audit=s.api(Method::GET,&format!("/guilds/{g}/audit-logs?limit=8&action_type=12"),None).await?;
    let actor=audit["audit_log_entries"].as_array()
        .and_then(|items|items.iter().find(|entry|entry["target_id"].as_str()==Some(&id)))
        .and_then(|entry|entry["user_id"].as_str()).unwrap_or("").to_owned();
    if actor.is_empty(){return Ok(());}
    let guild=s.api(Method::GET,&format!("/guilds/{g}"),None).await?;
    let me=s.api(Method::GET,"/users/@me",None).await?;
    if actor==guild["owner_id"].as_str().unwrap_or("")||actor==me["id"].as_str().unwrap_or(""){return Ok(());}
    let (count,deleted_ids)={
        let mut rt=s.runtime.lock().map_err(|_|anyhow!("runtime lock poisoned"))?;
        let q=rt.deleted_channels.entry(format!("{g}:{actor}")).or_default();
        while q.front().is_some_and(|(at,_)|now()-*at>60_000){q.pop_front();}
        q.push_back((now(),id.clone()));
        (q.len(),q.iter().map(|(_,channel)|channel.clone()).collect::<Vec<_>>())
    };
    let log=find_channel(s,&g,"timi").await.unwrap_or_default();
    if !log.is_empty(){let _=s.send(&log,json!({"content":format!("Security alert: <@{actor}> deleted #{} ({}). {} channel deletion(s) in 60 seconds.",c.name,id,count),"allowed_mentions":{"parse":[]}})).await;}
    if count<3{return Ok(());}

    let mut restored=0usize;
    for deleted_id in deleted_ids.iter(){
        let saved=s.store.lock().ok().and_then(|store|store.channels.get(&format!("{g}:{deleted_id}")).cloned());
        let Some(snapshot)=saved else {
            if !log.is_empty(){let _=s.send(&log,json!({"content":format!("Recovery incomplete: no saved channel configuration exists for deleted channel ID {deleted_id}."),"allowed_mentions":{"parse":[]}})).await;}
            continue;
        };
        let mut body=json!({"name":snapshot["name"],"type":snapshot["type"],"reason":"Timi recovery after repeated channel deletion"});
        for field in ["topic","parent_id","position","permission_overwrites","nsfw","rate_limit_per_user","bitrate","user_limit"]{
            if !snapshot[field].is_null(){body[field]=snapshot[field].clone();}
        }
        if let Ok(created)=s.api(Method::POST,&format!("/guilds/{g}/channels"),Some(body)).await{
            restored+=1;
            let new_channel=created["id"].as_str().unwrap_or("").to_owned();
            {
                let mut store=s.store.lock().map_err(|_|anyhow!("store lock poisoned"))?;
                if let Some(snapshot)=store.channels.get_mut(&format!("{g}:{deleted_id}")){
                    snapshot["deletedAt"]=json!(now());
                }
            }
            s.schedule_persist();
            let archived=s.store.lock().ok().and_then(|store|store.messages.get(&g).cloned()).unwrap_or_default();
            let cutoff=now()-WEEK;
            let mut channel_messages=archived.into_iter().filter(|message|message["channel_id"].as_str()==Some(deleted_id)&&message["timestamp_ms"].as_i64().unwrap_or_default()>=cutoff).collect::<Vec<_>>();
            channel_messages.sort_by_key(|message|message["timestamp_ms"].as_i64().unwrap_or_default());
            for message in channel_messages{
                let files=message["attachments"].as_array().cloned().unwrap_or_default();
                let attachment_text=files.iter().map(|file|format!("{}: {}",file["name"].as_str().unwrap_or("attachment"),file["url"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(" | ");
                let content=message["content"].as_str().unwrap_or("(no text content)");
                let suffix=if attachment_text.is_empty(){String::new()}else{format!("\nAttachments: {attachment_text}")};
                let stamp=message["timestamp_ms"].as_i64().unwrap_or_default()/1000;
                let body=format!("[Recovered archive • original message {} • <t:{stamp}:F>]\nAuthor ID: {}\n{}{}",message["id"].as_str().unwrap_or("unknown"),message["author_id"].as_str().unwrap_or("unknown"),content,suffix);
                let _=s.send(&new_channel,json!({"content":body.chars().take(1900).collect::<String>(),"allowed_mentions":{"parse":[]}})).await;
            }
        }
    }

    // Check the bot's capabilities and role hierarchy before quarantining the actor.
    let bot_id=me["id"].as_str().unwrap_or("");
    let bot_member=s.api(Method::GET,&format!("/guilds/{g}/members/{bot_id}"),None).await?;
    let actor_member=s.api(Method::GET,&format!("/guilds/{g}/members/{actor}"),None).await?;
    if actor_member.pointer("/user/bot").and_then(Value::as_bool).unwrap_or(false){
        if let Ok(mut rt)=s.runtime.lock(){rt.deleted_channels.remove(&format!("{g}:{actor}"));}
        return Ok(());
    }
    let role_list=s.api(Method::GET,&format!("/guilds/{g}/roles"),None).await?;
    let roles=role_list.as_array().cloned().unwrap_or_default();
    let bot_role_ids=bot_member["roles"].as_array().cloned().unwrap_or_default();
    let actor_role_ids=actor_member["roles"].as_array().cloned().unwrap_or_default();
    let mut bot_permissions=0u64;
    let mut bot_top=0i64;
    let mut actor_top=0i64;
    for role in &roles{
        let role_id=role["id"].as_str().unwrap_or("");
        let position=role["position"].as_i64().unwrap_or(0);
        if role_id==g || bot_role_ids.iter().any(|id|id.as_str()==Some(role_id)){
            bot_permissions|=role["permissions"].as_str().and_then(|v|v.parse::<u64>().ok()).unwrap_or(0);
        }
        if bot_role_ids.iter().any(|id|id.as_str()==Some(role_id)){bot_top=bot_top.max(position);}
        if actor_role_ids.iter().any(|id|id.as_str()==Some(role_id)){actor_top=actor_top.max(position);}
    }
    let can_timeout=bot_permissions&(8|MODERATE)!=0;
    let can_manage_roles=bot_permissions&(8|MANAGE_ROLES)!=0;
    if !can_timeout || !can_manage_roles || actor_top>=bot_top{
        if !log.is_empty(){
            let _=s.send(&log,json!({"content":format!("Critical anti-nuke alert: channel recovery recreated {restored} of {count} deleted channel(s), but Timi did not quarantine <@{actor}>. Required permissions or role hierarchy are insufficient. Manually review the audit log."), "allowed_mentions":{"parse":[]}})).await;
        }
        if let Ok(mut rt)=s.runtime.lock(){rt.deleted_channels.remove(&format!("{g}:{actor}"));}
        return Ok(());
    }
    let removable=roles.iter().filter_map(|role|{
        let role_id=role["id"].as_str()?;
        let position=role["position"].as_i64().unwrap_or(0);
        if role_id!=g && actor_role_ids.iter().any(|id|id.as_str()==Some(role_id))
            && !role["managed"].as_bool().unwrap_or(false) && position<bot_top {
            Some(role_id.to_owned())
        }else{None}
    }).collect::<Vec<_>>();
    let until=Utc::now()+ChronoDuration::minutes(60);
    let timeout=s.api(Method::PATCH,&format!("/guilds/{g}/members/{actor}"),Some(json!({
        "communication_disabled_until":until.to_rfc3339(),
        "reason":format!("Timi anti-nuke: deleted {count} channels within 60 seconds")
    }))).await;
    let mut removed=0usize;
    for role_id in removable{
        if s.api(Method::DELETE,&format!("/guilds/{g}/members/{actor}/roles/{role_id}"),None).await.is_ok(){removed+=1;}
    }
    if !log.is_empty(){
        let status=if timeout.is_ok(){"timed out for 60 minutes"}else{"could not be timed out"};
        let _=s.send(&log,json!({"content":format!("Anti-nuke recovery finished: recreated {restored} of {count} deleted channel(s). <@{actor}> {status}; removed {removed} manageable role(s). Reposted archives are copies with new message IDs; attachment source links may expire."), "allowed_mentions":{"parse":[]}})).await;
    }
    if let Ok(mut rt)=s.runtime.lock(){rt.deleted_channels.remove(&format!("{g}:{actor}"));}
    Ok(())
}

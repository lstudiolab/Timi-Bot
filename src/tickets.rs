async fn component(s:&Arc<State>,id:&str,t:&str,v:Value)->Result<()>{
    let custom=v.pointer("/data/custom_id").and_then(Value::as_str).unwrap_or("").to_owned();
    if custom.starts_with("rolepicker:"){return role_picker_component(s,id,t,&v,&custom).await;}
    if custom.starts_with("ticket:"){return ticket_component(s,id,t,&v,&custom).await;}
    if custom.starts_with("modpanel:"){return mod_component(s,id,t,&v,&custom).await;}
    if custom.starts_with("verify:"){return verify_component(s,id,t,&v,&custom).await;}
    if custom.starts_with("botguard:"){return bot_component(s,id,t,&v,&custom).await;}
    Ok(())
}
async fn ticket_component(s:&Arc<State>,id:&str,t:&str,v:&Value,custom:&str)->Result<()>{
    let g=guild_id(v);let c=channel_id(v);let u=user_id(v);let manager=manage_guild(v);
    if custom=="ticket:wizard-start"{let x=s.ticket(&g);return s.callback(id,t,9,Some(modal("ticket:wizard-stage1","Ticket setup - 1 of 2",vec![
        input("ticket-name","Ticket panel name",&x.panel_title,false,200),input("support-role","Support role ID",&x.support_role_id,false,22),
        input("description","Panel description",&x.panel_description,true,1000),input("button-label","Open button label",&x.open_label,false,80),
        input("category","Ticket category name",&x.category_name,false,100)]))).await;}
    if custom=="ticket:wizard-continue"{let x=s.ticket(&g);return s.callback(id,t,9,Some(modal("ticket:wizard-stage2","Ticket setup - 2 of 2",vec![
        input("ticket-message","Message shown inside tickets",&x.ticket_message,true,1000),optional_input("transcript-channel","Transcript channel ID (optional)",&x.transcript_channel_id,false,22),
        optional_input("panel-channel","Panel channel ID (blank = this channel)",&x.panel_channel_id,false,22)]))).await;}
    if custom=="ticket:open"{s.defer(id,t).await?;return open_ticket(s,t,&g,&u).await;}
    if custom=="ticket:close"||custom=="ticket:confirm-close"{
        let ch=s.api(Method::GET,&format!("/channels/{c}"),None).await?;
        let owner=ch["topic"].as_str().unwrap_or("").strip_prefix("timi-ticket-owner:").unwrap_or("").to_owned();
        if owner.is_empty(){return s.reply(id,t,"This is not a Timi ticket channel.",true).await;}
        if u!=owner&&!manager{return s.reply(id,t,"Only the ticket owner or a server manager can close this ticket.",true).await;}
        if custom=="ticket:close"{return s.callback(id,t,4,Some(json!({"content":"Are you sure you want to close this ticket?","components":[row(vec![button("ticket:confirm-close","Yes, close it",4)])],"flags":64}))).await;}
        s.callback(id,t,7,Some(json!({"content":"Closing this ticket in 5 seconds…","components":[]}))).await?;
        let cloned=s.clone();let guild=g.clone();let channel=c.clone();
        tokio::spawn(async move{sleep(Duration::from_secs(5)).await;close_ticket(&cloned,&guild,&channel).await;});
        return Ok(());
    }
    if !manager{return s.reply(id,t,"You need Manage Server permission to configure tickets.",true).await;}
    let x=s.ticket(&g);
    match custom{
        "ticket:edit-panel"=>s.callback(id,t,9,Some(modal("ticket:modal-panel","Customize Ticket Panel",vec![
            input("title","Panel title",&x.panel_title,false,200),input("description","Panel description",&x.panel_description,true,1000),input("open-label","Open button label",&x.open_label,false,80)]))).await,
        "ticket:edit-ticket"=>s.callback(id,t,9,Some(modal("ticket:modal-ticket","Customize Ticket Message",vec![
            input("message","Message inside each ticket",&x.ticket_message,true,1000),input("close-label","Close button label",&x.close_label,false,80)]))).await,
        "ticket:edit-category"=>s.callback(id,t,9,Some(modal("ticket:modal-category","Customize Ticket Category",vec![input("category","Category name",&x.category_name,false,100)]))).await,
        "ticket:edit-access"=>s.callback(id,t,9,Some(modal("ticket:modal-access","Support and Transcript",vec![
            optional_input("support-role","Support role ID (blank for none)",&x.support_role_id,false,22),
            optional_input("transcript","Transcript channel ID (blank for none)",&x.transcript_channel_id,false,22),
            optional_input("panel-channel","Panel channel ID (blank for current)",&x.panel_channel_id,false,22)]))).await,
        "ticket:publish"=>{
            let dest=publish_ticket(s,&g,&c,x).await?;
            let _=dest;reply_update(s,id,t,&ticket_text(&s.ticket(&g)),ticket_components()).await
        }
        _=>Ok(())
    }
}
async fn open_ticket(s:&Arc<State>,t:&str,g:&str,u:&str)->Result<()>{
    let key=format!("{g}:{u}");
    let cooling_down={
        let mut rt=s.runtime.lock().map_err(|_|anyhow!("runtime lock poisoned"))?;
        if rt.ticket_cooldowns.get(&key).is_some_and(|last|now()-*last<10_000){true}
        else{rt.ticket_cooldowns.insert(key,now());false}
    };
    if cooling_down{
        s.edit_original(t,"Please wait a few seconds before opening another ticket.").await?;
        return Ok(());
    }
    let x=s.ticket(g);let channels=s.api(Method::GET,&format!("/guilds/{g}/channels"),None).await?;
    if let Some(ch)=channels.as_array().and_then(|a|a.iter().find(|c|c["type"].as_u64()==Some(0)&&c["topic"].as_str()==Some(&format!("timi-ticket-owner:{u}")))){
        return s.edit_original(t,&format!("You already have an open ticket: <#{}>",ch["id"].as_str().unwrap_or(""))).await;
    }
    let mut category=channels.as_array().and_then(|a|a.iter().find(|c|c["type"].as_u64()==Some(4)&&c["name"].as_str().unwrap_or("").eq_ignore_ascii_case(&x.category_name))).and_then(|c|c["id"].as_str()).unwrap_or("").to_owned();
    if category.is_empty(){let v=s.api(Method::POST,&format!("/guilds/{g}/channels"),Some(json!({"name":x.category_name,"type":4}))).await?;category=v["id"].as_str().unwrap_or("").into();}
    let me=s.api(Method::GET,"/users/@me",None).await?;let bot=me["id"].as_str().unwrap_or("");
    let member=s.api(Method::GET,&format!("/guilds/{g}/members/{u}"),None).await?;
    let username=member.pointer("/user/username").and_then(Value::as_str).unwrap_or("member").to_lowercase();
    let safe=Regex::new("[^a-z0-9-]").unwrap().replace_all(&username,"-").to_string();
    let safe=Regex::new("-+").unwrap().replace_all(&safe,"-").trim_matches('-').to_owned();
    let name=if safe.is_empty(){format!("ticket-{u}")}else{format!("ticket-{safe}")};
    let roles=s.api(Method::GET,&format!("/guilds/{g}/roles"),None).await?;
    let role_list=roles.as_array().cloned().unwrap_or_default();
    let support_valid=x.support_role_id.is_empty()||role_list.iter().any(|role|
        role["id"].as_str()==Some(&x.support_role_id)&&!role["managed"].as_bool().unwrap_or(false));
    if !support_valid{
        s.edit_original(t,"The configured support role no longer exists or is managed. Update /ticket-settings before opening tickets.").await?;
        return Ok(());
    }
    // Explicitly deny every server role, not just @everyone. This prevents a
    // separate role-level allow from exposing a private ticket to other members.
    let mut overwrites=Vec::new();
    for role in &role_list{
        let role_id=role["id"].as_str().unwrap_or("");
        if role_id==g||role_id==x.support_role_id{continue;}
        overwrites.push(json!({"id":role_id,"type":0,"allow":"0","deny":VIEW.to_string()}));
    }
    let extra=if x.support_role_id.is_empty(){3}else{4};
    if overwrites.len()+extra>100{
        s.edit_original(t,"This server has too many roles to safely create a private ticket channel. Discord allows at most 100 permission overwrites.").await?;
        return Ok(());
    }
    overwrites.push(json!({"id":g,"type":0,"allow":"0","deny":VIEW.to_string()}));
    if !x.support_role_id.is_empty(){
        overwrites.push(json!({"id":x.support_role_id,"type":0,"allow":(VIEW|SEND|HISTORY|ATTACH|EMBED).to_string(),"deny":"0"}));
    }
    overwrites.push(json!({"id":u,"type":1,"allow":(VIEW|SEND|HISTORY|ATTACH|EMBED).to_string(),"deny":"0"}));
    overwrites.push(json!({"id":bot,"type":1,"allow":(VIEW|SEND|HISTORY|MANAGE_CHANNELS|MANAGE_MESSAGES|EMBED).to_string(),"deny":"0"}));
    let created=s.api(Method::POST,&format!("/guilds/{g}/channels"),Some(json!({"name":name.chars().take(100).collect::<String>(),"type":0,"parent_id":category,
        "topic":format!("timi-ticket-owner:{u}"),"permission_overwrites":overwrites,"reason":"Timi ticket opened by member"}))).await?;
    let id=created["id"].as_str().unwrap_or("");
    s.send(id,json!({"content":format!("<@{u}>"),"embeds":[{"color":8421504,"title":x.panel_title,"description":x.ticket_message}],
        "components":[row(vec![button("ticket:close",&x.close_label,2)])],"allowed_mentions":{"users":[u]}})).await?;
    s.edit_original(t,&format!("Your ticket has been created: <#{id}>")).await
}
async fn close_ticket(s:&State,g:&str,c:&str)->Result<()>{
    let settings=s.ticket(g);
    if !settings.transcript_channel_id.is_empty(){
        let mut messages=Vec::<Value>::new();
        let mut before=String::new();
        let mut transcript_failed=false;
        loop{
            if messages.len()>=1000{break;}
            let remaining=(1000-messages.len()).min(100);
            let path=if before.is_empty(){
                format!("/channels/{c}/messages?limit={remaining}")
            }else{
                format!("/channels/{c}/messages?limit={remaining}&before={before}")
            };
            match s.api(Method::GET,&path,None).await{
                Ok(page)=>{
                    let Some(batch)=page.as_array() else{break;};
                    if batch.is_empty(){break;}
                    before=batch.last().and_then(|m|m["id"].as_str()).unwrap_or("").to_owned();
                    let count=batch.len();
                    messages.extend(batch.iter().cloned());
                    if count<remaining{break;}
                }
                Err(error)=>{
                    transcript_failed=true;
                    warn!("Could not fetch all messages for ticket transcript {c}: {error:#}");
                    break;
                }
            }
        }
        messages.sort_by(|a,b|a["timestamp"].as_str().unwrap_or("").cmp(b["timestamp"].as_str().unwrap_or("")));
        let mut lines=messages.iter().map(|m|{
            let timestamp=m["timestamp"].as_str().unwrap_or("time unknown");
            let author=m.pointer("/author/username").and_then(Value::as_str).unwrap_or("unknown");
            let content=m["content"].as_str().filter(|v|!v.is_empty()).unwrap_or("(no text content)");
            let attachments=m["attachments"].as_array().map(|files|files.iter().map(|f|{
                format!("{}: {}",f["filename"].as_str().unwrap_or("attachment"),f["url"].as_str().unwrap_or(""))
            }).collect::<Vec<_>>().join(" | ")).unwrap_or_default();
            let suffix=if attachments.is_empty(){String::new()}else{format!("\nAttachments: {attachments}")};
            format!("[{timestamp}] {author}: {content}{suffix}").chars().take(1700).collect::<String>()
        }).collect::<Vec<_>>();
        if lines.is_empty(){lines.push("(No message history available.)".into());}
        let mut chunk=String::new();
        for line in lines{
            if chunk.len()+line.len()+1>1750{
                let _=s.send(&settings.transcript_channel_id,json!({"content":format!("Transcript for ticket <#{c}>\n{chunk}"),"allowed_mentions":{"parse":[]}})).await;
                chunk.clear();
            }
            chunk.push_str(&line);chunk.push('\n');
        }
        if !chunk.is_empty(){
            let suffix=if transcript_failed{"\n\nTranscript may be incomplete because Discord message history could not be fully retrieved."}else if messages.len()>=1000{"\n\nTranscript limited to the latest 1,000 messages."}else{""};
            let _=s.send(&settings.transcript_channel_id,json!({"content":format!("Transcript for ticket <#{c}>\n{chunk}{suffix}"),"allowed_mentions":{"parse":[]}})).await;
        }
    }
    s.api(Method::DELETE,&format!("/channels/{c}"),None).await?;Ok(())
}
async fn modal_submit(s:&Arc<State>,id:&str,t:&str,v:Value)->Result<()>{
    let custom=v.pointer("/data/custom_id").and_then(Value::as_str).unwrap_or("");
    let g=guild_id(&v);let fields=parse_modal(v.pointer("/data/components").unwrap_or(&Value::Null));
    if custom.starts_with("rolepicker:"){return role_picker_modal_submit(s,id,t,&v,custom,&fields).await;}
    if custom.starts_with("ticket:"){
        if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to edit ticket settings.",true).await;}
        let mut x=s.ticket(&g);
        if custom=="ticket:wizard-stage1"{
            x.panel_title=fields.get("ticket-name").cloned().unwrap_or_default().trim().to_owned();
            x.support_role_id=fields.get("support-role").cloned().unwrap_or_default().trim().to_owned();
            x.panel_description=fields.get("description").cloned().unwrap_or_default().trim().to_owned();
            x.open_label=fields.get("button-label").cloned().unwrap_or_default().trim().to_owned();
            x.category_name=fields.get("category").cloned().unwrap_or_default().trim().to_owned();
            if x.panel_title.is_empty()||x.panel_description.is_empty()||x.open_label.is_empty()||x.category_name.is_empty()||(!x.support_role_id.is_empty()&&!snowflake(&x.support_role_id)){
                return s.reply(id,t,"Complete every required field. The support role must be a valid numeric Discord role ID.",true).await;
            }
            s.save_ticket(&g,x)?;
            return s.callback(id,t,4,Some(json!({"content":"First part saved. Continue with the transcript and panel destination.","components":[row(vec![button("ticket:wizard-continue","Continue setup",1)])],"flags":64}))).await;
        }
        if custom=="ticket:wizard-stage2"{
            x.ticket_message=fields.get("ticket-message").cloned().unwrap_or_default().trim().to_owned();
            x.transcript_channel_id=fields.get("transcript-channel").cloned().unwrap_or_default().trim().to_owned();
            x.panel_channel_id=fields.get("panel-channel").cloned().unwrap_or_default().trim().to_owned();
            if x.ticket_message.is_empty()||[&x.transcript_channel_id,&x.panel_channel_id].iter().any(|v|!v.is_empty()&&!snowflake(v)){
                return s.reply(id,t,"Enter a ticket message and valid numeric channel IDs. Leave optional channel IDs blank to use defaults.",true).await;
            }
            s.save_ticket(&g,x.clone())?;refresh_ticket(s,&g,&x).await;
            return s.callback(id,t,4,Some(json!({"content":format!("Ticket setup saved.\\n\\n{}",ticket_text(&x)),"components":ticket_components(),"flags":64}))).await;
        }
        match custom{
            "ticket:modal-panel"=>{x.panel_title=fields.get("title").cloned().unwrap_or_default().trim().into();x.panel_description=fields.get("description").cloned().unwrap_or_default().trim().into();x.open_label=fields.get("open-label").cloned().unwrap_or_default().trim().into();}
            "ticket:modal-ticket"=>{x.ticket_message=fields.get("message").cloned().unwrap_or_default().trim().into();x.close_label=fields.get("close-label").cloned().unwrap_or_default().trim().into();}
            "ticket:modal-category"=>x.category_name=fields.get("category").cloned().unwrap_or_default().trim().into(),
            "ticket:modal-access"=>{
                x.support_role_id=fields.get("support-role").cloned().unwrap_or_default().trim().into();
                x.transcript_channel_id=fields.get("transcript").cloned().unwrap_or_default().trim().into();
                x.panel_channel_id=fields.get("panel-channel").cloned().unwrap_or_default().trim().into();
                for value in [&x.support_role_id,&x.transcript_channel_id,&x.panel_channel_id]{if !value.is_empty()&&!snowflake(value){return s.reply(id,t,"Role and channel IDs must be valid numeric Discord IDs.",true).await;}}
            }
            _=>return Ok(())
        }
        if x.panel_title.is_empty()||x.panel_description.is_empty()||x.open_label.is_empty()||x.ticket_message.is_empty()||x.close_label.is_empty()||x.category_name.is_empty(){return s.reply(id,t,"Ticket settings must contain text.",true).await;}
        s.save_ticket(&g,x.clone())?;refresh_ticket(s,&g,&x).await;
        return reply_update(s,id,t,&ticket_text(&x),ticket_components()).await;
    }
    if custom.starts_with("modpanel:"){
        if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to edit moderation settings.",true).await;}
        let mut x=s.mods(&g);
        match custom{
            "modpanel:sanction-modal"=>{
                let action=fields.get("sanction").cloned().unwrap_or_default().to_lowercase();
                let mins=fields.get("timeout-minutes").and_then(|v|v.parse::<u64>().ok()).unwrap_or(0);
                if !["timeout","kick","ban","delete"].contains(&action.as_str())||!(1..=40320).contains(&mins){return s.reply(id,t,"Use timeout, kick, ban, or delete; timeout must be 1–40320 minutes.",true).await;}
                x.sanction=action;x.timeout_minutes=mins;
            }
            "modpanel:duration-modal"|"modpanel:max-count-modal"=>{
                let n=fields.get("value").and_then(|v|v.parse::<u64>().ok()).unwrap_or(0);
                if custom=="modpanel:duration-modal"{if !(1..=60).contains(&n){return s.reply(id,t,"Action duration must be 1–60 seconds.",true).await;}x.action_duration_seconds=n;}
                else{if !(1..=100).contains(&n){return s.reply(id,t,"Max message count must be 1–100.",true).await;}x.max_message_count=n as usize;}
            }
            _=>return Ok(())
        }
        s.save_mods(&g,x.clone())?;
        return reply_update(s,id,t,&mod_text(&x),mod_components(&x)).await;
    }
    Ok(())
}
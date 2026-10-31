fn now()->i64{SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64}
fn snowflake_time(id:&str)->i64{id.parse::<u64>().map(|v|((v>>22)as i64)+1_420_070_400_000).unwrap_or(now())}
fn snowflake(id:&str)->bool{id.len()>=15&&id.len()<=22&&id.chars().all(|c|c.is_ascii_digit())}
fn guild_id(v:&Value)->String{v.get("guild_id").and_then(Value::as_str).unwrap_or("").into()}
fn channel_id(v:&Value)->String{v.get("channel_id").and_then(Value::as_str).unwrap_or("").into()}
fn user_id(v:&Value)->String{v.pointer("/member/user/id").or_else(||v.pointer("/user/id")).and_then(Value::as_str).unwrap_or("").into()}
fn manage_guild(v:&Value)->bool{v.pointer("/member/permissions").and_then(Value::as_str).and_then(|s|s.parse::<u64>().ok()).unwrap_or(0)&MANAGE_GUILD!=0}
fn option(options:&Value,name:&str)->Option<Value>{options.as_array()?.iter().find(|v|v.get("name").and_then(Value::as_str)==Some(name))?.get("value").cloned()}
fn opt_str(o:&Value,n:&str)->Option<String>{option(o,n)?.as_str().map(str::to_owned)}
fn opt_num(o:&Value,n:&str)->Option<u64>{option(o,n)?.as_u64()}
fn opt_bool(o:&Value,n:&str)->Option<bool>{option(o,n)?.as_bool()}
fn parse_modal(v:&Value)->HashMap<String,String>{
    fn walk(x:&Value,out:&mut HashMap<String,String>){if let Some(id)=x.get("custom_id").and_then(Value::as_str){if let Some(v)=x.get("value").and_then(Value::as_str){out.insert(id.into(),v.into());}}
        if let Some(a)=x.as_array(){for v in a{walk(v,out);}}if let Some(o)=x.as_object(){for v in o.values(){if v.is_array(){walk(v,out);}}}}
    let mut out=HashMap::new();walk(v,&mut out);out
}
fn button(id:&str,label:&str,style:u8)->Value{json!({"type":2,"style":style,"custom_id":id,"label":label})}
fn row(items:Vec<Value>)->Value{json!({"type":1,"components":items})}
fn input(id:&str,label:&str,value:&str,paragraph:bool,max:u64)->Value{json!({"type":4,"custom_id":id,"label":label,"style":if paragraph{2}else{1},"required":true,"max_length":max,"value":value.chars().take(max as usize).collect::<String>()})}
fn modal(id:&str,title:&str,items:Vec<Value>)->Value{json!({"custom_id":id,"title":title,"components":items.into_iter().map(|v|row(vec![v])).collect::<Vec<_>>()})}
fn optional_input(id:&str,label:&str,value:&str,paragraph:bool,max:u64)->Value{
    let mut field=input(id,label,value,paragraph,max);
    field["required"]=json!(false);
    if value.is_empty(){if let Some(object)=field.as_object_mut(){object.remove("value");}}
    field
}

fn ticket_components()->Vec<Value>{vec![row(vec![button("ticket:edit-panel","Edit panel",2),button("ticket:edit-ticket","Edit ticket message",2),button("ticket:edit-category","Edit category",2)]),row(vec![button("ticket:edit-access","Edit support and transcript",2),button("ticket:publish","Publish panel",1)])]}
async fn publish_ticket(s:&State,g:&str,current_channel:&str,mut settings:TicketSettings)->Result<String>{
    let destination=if settings.panel_channel_id.is_empty(){current_channel.to_owned()}else{settings.panel_channel_id.clone()};
    if let Some(panel)=settings.published_panels.iter().find(|p|p.channel_id==destination){s.edit(&panel.channel_id,&panel.message_id,public_ticket(&settings)).await?;}else{
        let message=s.send(&destination,public_ticket(&settings)).await?;
        settings.published_panels.push(PanelRef{channel_id:destination.clone(),message_id:message["id"].as_str().unwrap_or("").to_owned()});
    }
    settings.panel_channel_id=destination.clone();s.save_ticket(g,settings)?;Ok(destination)
}

fn ticket_text(s:&TicketSettings)->String{format!("**Ticket Panel Configuration**\n\n**Panel title:** {}\n**Panel description:** {}\n**Open button:** {}\n**Ticket message:** {}\n**Close button:** {}\n**Category:** {}\n**Support role:** {}\n**Transcript channel:** {}\n**Panel channel:** {}\n\nEdit a setting, then publish. This configuration message stays in place.",s.panel_title,s.panel_description,s.open_label,s.ticket_message,s.close_label,s.category_name,
    if s.support_role_id.is_empty(){"Not configured".into()}else{format!("<@&{}>",s.support_role_id)},
    if s.transcript_channel_id.is_empty(){"Not configured".into()}else{format!("<#{}>",s.transcript_channel_id)},
    if s.panel_channel_id.is_empty(){"Current channel".into()}else{format!("<#{}>",s.panel_channel_id)})}
fn public_ticket(s:&TicketSettings)->Value{json!({"embeds":[{"color":8421504,"title":s.panel_title,"description":s.panel_description}],"components":[row(vec![button("ticket:open",&s.open_label,1)])]})}
fn mod_text(s:&ModSettings)->String{format!("**Timi Moderation Settings**\n\n**Module:** {}\n**Sanction:** {}\n**Timeout duration:** {} minute(s)\n**Log channel:** {}\n**Action duration:** {} second(s)\n**Maximum messages:** {}\n**Block Discord invites:** {}\n**Block mass mentions:** {}\n**Block excessive caps:** {}",if s.enabled{"Active"}else{"Inactive"},s.sanction,s.timeout_minutes,if s.log_channel_id.is_empty(){"Not configured".into()}else{format!("<#{}>",s.log_channel_id)},s.action_duration_seconds,s.max_message_count,s.block_invites,s.block_mass_mentions,s.block_excessive_caps)}
fn mod_components(s:&ModSettings)->Vec<Value>{vec![row(vec![button(if s.enabled{"modpanel:disable"}else{"modpanel:enable"},if s.enabled{"Disable"}else{"Enable"},if s.enabled{4}else{3}),button("modpanel:sanction","Edit sanction",2),button("modpanel:log","Set log channel",2)]),row(vec![button("modpanel:duration","Action duration",2),button("modpanel:max-count","Max messages",2)]),row(vec![button("modpanel:invites","Toggle invites",2),button("modpanel:mentions","Toggle mentions",2),button("modpanel:caps","Toggle caps",2)])]}
fn verify_panel(s:&VerifySettings)->Value{json!({"embeds":[{"color":8421504,"title":s.panel_title,"description":s.panel_description}],"components":[row(vec![button("verify:start","Verify",1)])]})}
async fn register_commands(s:&State)->Result<()>{
    let commands=json!([
        {"name":"ticket-setup","description":"Create Timi's private channels and ticket category.","default_member_permissions":"32"},
        {"name":"ticket-panel","description":"Create and publish a customizable ticket panel.","default_member_permissions":"32"},
        {"name":"ticket-settings","description":"Edit the settings of your existing ticket panel.","default_member_permissions":"32"},
        {"name":"moderation-settings","description":"Configure Timi moderation and anti-spam protection.","default_member_permissions":"32"},
        {"name":"warn","description":"Record a moderation warning.","default_member_permissions":"32","options":[{"type":6,"name":"member","description":"Member to warn","required":true},{"type":3,"name":"reason","description":"Reason","required":true,"max_length":500}]},
        {"name":"warnings","description":"View a member warning history.","default_member_permissions":"32","options":[{"type":6,"name":"member","description":"Member to inspect","required":true}]},
        {"name":"clear-warnings","description":"Clear a member warning history.","default_member_permissions":"32","options":[{"type":6,"name":"member","description":"Member to clear","required":true}]},
        {"name":"automod-word","description":"Manage blocked words and phrases.","default_member_permissions":"32","options":[{"type":3,"name":"action","description":"List, add, or remove","required":true,"choices":[{"name":"List","value":"list"},{"name":"Add","value":"add"},{"name":"Remove","value":"remove"}]},{"type":3,"name":"word","description":"Word or phrase","required":false,"max_length":80}]},
        {"name":"lockdown","description":"Restrict @everyone from sending messages in channels.","default_member_permissions":"32"},
        {"name":"unlockdown","description":"Remove Timi lockdown send-message denies.","default_member_permissions":"32"},
        {"name":"verify-settings","description":"Configure Timi risk-based verification (server owner only).","options":[
            {"type":8,"name":"role","description":"Role granted after passing","required":false},
            {"type":8,"name":"required-role","description":"Role required before verifying","required":false},
            {"type":5,"name":"clear-required-role","description":"Remove the required-role restriction","required":false},
            {"type":4,"name":"min-age-days","description":"Minimum account age in days","min_value":0,"max_value":3650,"required":false},
            {"type":7,"name":"review-channel","description":"Channel for manual review","channel_types":[0],"required":false},
            {"type":3,"name":"title","description":"Verification panel title","max_length":200,"required":false},
            {"type":3,"name":"description","description":"Verification panel description","max_length":1000,"required":false}]},
        {"name":"verify-panel","description":"Publish the Timi risk-based verification panel.","default_member_permissions":"32"},
        {"name":"setup-role-picker","description":"Create a self-service role picker menu (server owner only)."},
        {"name":"create-embed","description":"Create and customize a reusable server embed.","default_member_permissions":"32"},
        {"name":"place-embed","description":"Place a saved embed in this channel.","default_member_permissions":"32","options":[{"type":3,"name":"name","description":"Name of the saved embed","required":true,"max_length":24}]},
        {"name":"edit-embed","description":"Open the editor for a saved embed.","default_member_permissions":"32","options":[{"type":3,"name":"name","description":"Name of the saved embed","required":true,"max_length":24}]},

    ]);
    let path=if let Some(g)=&s.config.guild_id{format!("/applications/{}/guilds/{g}/commands",s.config.client_id)}else{format!("/applications/{}/commands",s.config.client_id)};
    s.api(Method::PUT,&path,Some(commands)).await?;info!("Registered Rust slash commands.");Ok(())
}
async fn reply_update(s:&State,id:&str,t:&str,content:&str,components:Vec<Value>)->Result<()>{
    s.callback(id,t,7,Some(json!({"content":content,"components":components}))).await
}
async fn refresh_ticket(s:&State,_g:&str,settings:&TicketSettings){for p in &settings.published_panels{let _=s.edit(&p.channel_id,&p.message_id,public_ticket(settings)).await;}}
async fn refresh_mod_panel(s:&State,settings:&ModSettings){
    if settings.panel_channel_id.is_empty()||settings.panel_message_id.is_empty(){return;}
    let _=s.edit(&settings.panel_channel_id,&settings.panel_message_id,
        json!({"content":mod_text(settings),"components":mod_components(settings)})).await;
}


async fn find_channel(s:&State,g:&str,name:&str)->Option<String>{
    let v=s.api(Method::GET,&format!("/guilds/{g}/channels"),None).await.ok()?;
    v.as_array()?.iter().find(|c|c.get("type").and_then(Value::as_u64)==Some(0)&&c.get("name").and_then(Value::as_str)==Some(name)).and_then(|c|c.get("id").and_then(Value::as_str)).map(str::to_owned)
}
async fn validate_verification_role(s:&State,g:&str,role_id:&str,assignable:bool)->std::result::Result<(),String>{
    if !snowflake(role_id)||role_id==g{return Err("Choose a normal server role other than @everyone.".into());}
    let role_list=s.api(Method::GET,&format!("/guilds/{g}/roles"),None).await
        .map_err(|_|"Timi could not read the server roles. Check its permissions.".to_owned())?;
    let roles=role_list.as_array().ok_or_else(||"Timi could not read the server roles.".to_owned())?;
    let target=roles.iter().find(|role|role["id"].as_str()==Some(role_id))
        .ok_or_else(||"That role no longer exists in this server.".to_owned())?;
    if target["managed"].as_bool().unwrap_or(false){
        return Err("Managed integration roles cannot be used for verification.".into());
    }
    if !assignable{return Ok(());}
    let me=s.api(Method::GET,"/users/@me",None).await
        .map_err(|_|"Timi could not read its bot account.".to_owned())?;
    let bot_id=me["id"].as_str().ok_or_else(||"Timi could not read its bot account ID.".to_owned())?;
    let bot_member=s.api(Method::GET,&format!("/guilds/{g}/members/{bot_id}"),None).await
        .map_err(|_|"Timi could not read its server member roles.".to_owned())?;
    let bot_role_ids=bot_member["roles"].as_array().cloned().unwrap_or_default();
    let mut bot_permissions=0u64;
    let mut bot_top=0i64;
    for role in roles{
        let id=role["id"].as_str().unwrap_or("");
        if id==g||bot_role_ids.iter().any(|value|value.as_str()==Some(id)){
            bot_permissions|=role["permissions"].as_str().and_then(|value|value.parse::<u64>().ok()).unwrap_or(0);
            bot_top=bot_top.max(role["position"].as_i64().unwrap_or(0));
        }
    }
    if bot_permissions&(8|MANAGE_ROLES)==0{
        return Err("Timi needs Manage Roles permission to assign the verified role.".into());
    }
    let target_position=target["position"].as_i64().unwrap_or(0);
    if target_position>=bot_top{
        return Err("Move Timi's highest role above the selected verified role, then try again.".into());
    }
    Ok(())
}
async fn log_to(s:&State,g:&str,channel:&str,text:&str){
    let target=if channel.is_empty(){find_channel(s,g,"timi").await.unwrap_or_default()}else{channel.into()};
    if !target.is_empty(){let _=s.send(&target,json!({"content":text,"allowed_mentions":{"parse":[]}})).await;}
}
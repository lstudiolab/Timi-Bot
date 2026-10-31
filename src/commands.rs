async fn command(s:&Arc<State>,id:&str,t:&str,v:Value)->Result<()>{
    let name=v.pointer("/data/name").and_then(Value::as_str).unwrap_or("");
    let g=guild_id(&v);let c=channel_id(&v);let u=user_id(&v);
    let opts=v.pointer("/data/options").cloned().unwrap_or(json!([]));
    if g.is_empty(){return s.reply(id,t,"This command can only be used in a server.",true).await;}
    match name{
        "create-embed"=>{if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to create embeds.",true).await;}
            return s.callback(id,t,9,Some(modal("embed:create","Create an embed",vec![
                input("name","Embed name (no spaces)", "",false,24),
                input("title","Embed title","",false,256),
                input("description","Embed description","",true,4000)
            ]))).await;}
        "edit-embed"=>{if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to edit embeds.",true).await;}
            let name=opt_str(&opts,"name").unwrap_or_default();
            let Some(embed)=s.embed(&g,&name) else{return s.reply(id,t,"No saved embed with that name. Use /create-embed first.",true).await;};
            return s.callback(id,t,4,Some(json!({"flags":64,"content":embed_editor_text(&embed),"embeds":[embed_payload(&embed)],"components":embed_editor_components(&embed)}))).await;}
        "place-embed"=>{if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to place embeds.",true).await;}
            let name=opt_str(&opts,"name").unwrap_or_default();
            let Some(mut embed)=s.embed(&g,&name) else{return s.reply(id,t,"No saved embed with that name. Use /create-embed first.",true).await;};
            s.defer(id,t).await?;
            let message=s.send(&c,json!({"embeds":[embed_payload(&embed)],"allowed_mentions":{"parse":[]}})).await?;
            let message_id=message["id"].as_str().unwrap_or("").to_owned();
            if !message_id.is_empty(){embed.placements.retain(|p|p.channel_id!=c);embed.placements.push(PanelRef{channel_id:c.clone(),message_id});s.save_embed(embed)?;}
            s.edit_original(t,"Embed placed in this channel.").await}

        "ticket-setup"=>{
            if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission.",true).await;}
            s.defer(id,t).await?;
            match setup(s,&g,&u,t).await{Ok(())=>Ok(()),Err(e)=>{let _=s.edit_original(t,"Setup failed. Check Manage Channels permission and role hierarchy.").await;Err(e)}}
        }
        "ticket-panel"=>{
            if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to publish ticket panels.",true).await;}
            s.defer(id,t).await?;
            match publish_ticket(s,&g,&c,s.ticket(&g)).await{
                Ok(destination)=>s.edit_original(t,&format!("Ticket panel published or updated in <#{destination}>.")).await,
                Err(error)=>{let _=s.edit_original(t,"Timi could not publish the ticket panel. Check channel permissions and configuration.").await;Err(error)}
            }
        }
        "ticket-settings"=>{
            if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to configure tickets.",true).await;}
            let settings=s.ticket(&g);
            s.callback(id,t,4,Some(json!({"content":ticket_text(&settings),"components":ticket_components(),"flags":64}))).await
        }
        "moderation-settings"=>{
            if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to change moderation settings.",true).await;}
            s.defer(id,t).await?;
            let mut settings=s.mods(&g);
            if !settings.panel_channel_id.is_empty()&&!settings.panel_message_id.is_empty(){
                if s.edit(&settings.panel_channel_id,&settings.panel_message_id,
                    json!({"content":mod_text(&settings),"components":mod_components(&settings)})).await.is_ok(){
                    return s.edit_original(t,"The existing moderation settings panel was updated.").await;
                }
                settings.panel_channel_id.clear();
                settings.panel_message_id.clear();
            }
            let message=s.send(&c,json!({"content":mod_text(&settings),"components":mod_components(&settings)})).await?;
            settings.panel_channel_id=c.clone();
            settings.panel_message_id=message["id"].as_str().unwrap_or("").to_owned();
            if !settings.panel_message_id.is_empty(){s.save_mods(&g,settings)?;}
            s.edit_original(t,"A persistent moderation settings panel was created in this channel.").await
        }
        "verify-settings"=>{
            // Acknowledge immediately so Discord does not expire the interaction
            // while Timi checks ownership, roles, and channel configuration.
            s.defer(id,t).await?;
            let server=match s.api(Method::GET,&format!("/guilds/{g}"),None).await{
                Ok(server)=>server,
                Err(error)=>{
                    let _=s.edit_original(t,"Timi could not check server ownership. Please try again.").await;
                    return Err(error);
                }
            };
            if server.get("owner_id").and_then(Value::as_str)!=Some(&u){
                return s.edit_original(t,"Only the server owner can change verification settings.").await;
            }
            let mut x=s.verify(&g);
            let role=opt_str(&opts,"role");let required=opt_str(&opts,"required-role");let clear=opt_bool(&opts,"clear-required-role").unwrap_or(false);
            let age=opt_num(&opts,"min-age-days");let review=opt_str(&opts,"review-channel");let title=opt_str(&opts,"title");let desc=opt_str(&opts,"description");
            if role.is_none()&&required.is_none()&&!clear&&age.is_none()&&review.is_none()&&title.is_none()&&desc.is_none(){
                return s.edit_original(t,&format!("**Timi verification settings**\nVerified role: {}\nRequired role: {}\nMinimum account age: {} days\nReview channel: {}\nThresholds: 80+ pass, 60–79 manual review, below 60 kick\nWeights: age 40, history 20, attempts 20, behavior 10, avatar 10",
                    if x.role_id.is_empty(){"Not configured".into()}else{format!("<@&{}>",x.role_id)},
                    if x.required_role_id.is_empty(){"None".into()}else{format!("<@&{}>",x.required_role_id)},x.min_age_days,
                    if x.review_channel_id.is_empty(){"#timi fallback".into()}else{format!("<#{}>",x.review_channel_id)})).await;
            }
            if let Some(v)=role{
                if let Err(reason)=validate_verification_role(s,&g,&v,true).await{
                    return s.edit_original(t,&reason).await;
                }
                x.role_id=v;
            }
            if let Some(v)=required{
                if let Err(reason)=validate_verification_role(s,&g,&v,false).await{
                    return s.edit_original(t,&reason).await;
                }
                x.required_role_id=v;
            }
            if clear{x.required_role_id.clear();}
            if let Some(v)=age{x.min_age_days=v;}
            if let Some(v)=review{
                if !snowflake(&v){return s.edit_original(t,"Select a valid text channel.").await;}
                x.review_channel_id=v;
            }
            if let Some(v)=title{x.panel_title=if v.trim().is_empty(){"Verify your account".into()}else{v.trim().into()};}
            if let Some(v)=desc{x.panel_description=if v.trim().is_empty(){"Press Verify to have Timi assess your account and server history.".into()}else{v.trim().into()};}
            s.save_verify(&g,x.clone())?;
            // Respond immediately after saving. Panel refreshes happen in the
            // background so old panels cannot make the settings interaction time out.
            s.edit_original(t,"Verification settings saved. Refreshing existing panels in the background.").await?;
            let state=Arc::clone(s);
            tokio::spawn(async move{
                let panel=verify_panel(&x);
                for p in &x.published_panels{
                    if let Err(error)=state.edit(&p.channel_id,&p.message_id,panel.clone()).await{
                        warn!("Could not refresh verification panel {} in channel {}: {error:#}",p.message_id,p.channel_id);
                    }
                }
            });
            Ok(())
        }
        "setup-role-picker"=>{
            s.defer(id,t).await?;
            let server=match s.api(Method::GET,&format!("/guilds/{g}"),None).await{
                Ok(value)=>value,
                Err(error)=>{let _=s.edit_original(t,"Timi could not check server ownership. Please try again.").await;return Err(error);}
            };
            if server["owner_id"].as_str()!=Some(&u){return s.edit_original(t,"Only the server owner can create role picker menus.").await;}
            s.edit_original_with_components(t,"**Role picker setup**\n\nCreate a self-service role menu. You can publish multiple menus in different channels. Configure its appearance, choose the allowed roles, then publish.",vec![row(vec![button("rolepicker:start","Configure role picker",1)])]).await
        }
        "verify-panel"=>{
            let server=s.api(Method::GET,&format!("/guilds/{g}"),None).await?;
            if server.get("owner_id").and_then(Value::as_str)!=Some(&u){return s.reply(id,t,"Only the server owner can publish the verification panel.",true).await;}
            let mut x=s.verify(&g);
            let mut updated=false;
            if let Some(panel)=x.published_panels.iter().find(|p|p.channel_id==c).cloned(){
                updated=s.edit(&c,&panel.message_id,verify_panel(&x)).await.is_ok();
            }
            if !updated{
                let message=s.send(&c,verify_panel(&x)).await?;
                x.published_panels.retain(|p|p.channel_id!=c);
                x.published_panels.push(PanelRef{channel_id:c,message_id:message["id"].as_str().unwrap_or("").into()});
                s.save_verify(&g,x)?;
            }
            s.reply(id,t,if updated{"Existing verification panel updated."}else{"Risk-based verification panel published."},true).await
        }
        _=>s.reply(id,t,"Unknown command.",true).await
    }
}
async fn setup(s:&State,g:&str,actor:&str,t:&str)->Result<()>{
    let channels=s.api(Method::GET,&format!("/guilds/{g}/channels"),None).await?;
    let list=channels.as_array().cloned().unwrap_or_default();
    let category=list.iter().find(|c|c["type"].as_u64()==Some(4)&&c["name"].as_str().unwrap_or("").eq_ignore_ascii_case("ticket")).and_then(|c|c["id"].as_str()).unwrap_or("").to_owned();
    if category.is_empty(){s.api(Method::POST,&format!("/guilds/{g}/channels"),Some(json!({"name":"ticket","type":4,"reason":"Timi setup"}))).await?;}
    for name in ["timi-logs","timi-confirmations"]{
        if list.iter().any(|c|c["type"].as_u64()==Some(0)&&c["name"].as_str()==Some(name)){
            s.edit_original(t,&format!("A channel named #{name} already exists. Rename or remove it, then retry. Existing permissions were not changed.")).await?;return Ok(());
        }
    }
    let info=s.api(Method::GET,&format!("/guilds/{g}"),None).await?;let owner=info["owner_id"].as_str().unwrap_or("");
    let me=s.api(Method::GET,"/users/@me",None).await?;let bot=me["id"].as_str().unwrap_or("");
    let overwrites=json!([
        {"id":g,"type":0,"allow":"0","deny":VIEW.to_string()},
        {"id":owner,"type":1,"allow":(VIEW|SEND|HISTORY).to_string(),"deny":"0"},
        {"id":actor,"type":1,"allow":(VIEW|SEND|HISTORY).to_string(),"deny":"0"},
        {"id":bot,"type":1,"allow":(VIEW|SEND|HISTORY|EMBED|ATTACH|MANAGE_MESSAGES).to_string(),"deny":"0"}]);
    let mut ids=Vec::new();
    for (name,topic) in [("timi-logs","Private moderation logs for Timi."),("timi-confirmations","Private setup confirmations for Timi.")]{
        let c=s.api(Method::POST,&format!("/guilds/{g}/channels"),Some(json!({"name":name,"type":0,"topic":topic,"permission_overwrites":overwrites}))).await?;
        ids.push(c["id"].as_str().unwrap_or("").to_owned());
    }
    let mut m=s.mods(g);m.log_channel_id=ids[0].clone();s.save_mods(g,m)?;
    s.send(&ids[1],json!({"content":format!("Timi setup completed by <@{actor}>. Private log channel: <#{}>.",ids[0])})).await?;
    s.edit_original_with_components(t,&format!("Setup complete. Created <#{0}>, <#{1}>, and the ticket category. Start the ticket configuration wizard to set the ticket name, support role, description, button label, category, transcript channel and panel destination.",ids[0],ids[1]),vec![row(vec![button("ticket:wizard-start","Configure ticket system",1)])]).await
}

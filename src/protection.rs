async fn ensure_private(s:&State,g:&str,name:&str)->Result<String>{
    let guild=s.api(Method::GET,&format!("/guilds/{g}"),None).await?;
    let owner=guild["owner_id"].as_str().unwrap_or("");
    let me=s.api(Method::GET,"/users/@me",None).await?;
    let bot=me["id"].as_str().unwrap_or("");
    let overwrites=json!([
        {"id":g,"type":0,"allow":"0","deny":VIEW.to_string()},
        {"id":owner,"type":1,"allow":(VIEW|SEND|HISTORY).to_string(),"deny":"0"},
        {"id":bot,"type":1,"allow":(VIEW|SEND|HISTORY|EMBED|MANAGE_MESSAGES).to_string(),"deny":"0"}
    ]);
    let topic="Private Timi security alerts and bot approval requests. Only the server owner and Timi can view this channel.";
    if let Some(channel)=find_channel(s,g,name).await{
        // Repair existing channels too; do not assume a previously created #timi is private.
        s.api(Method::PATCH,&format!("/channels/{channel}"),Some(json!({
            "topic":topic,"permission_overwrites":overwrites
        }))).await?;
        return Ok(channel);
    }
    let created=s.api(Method::POST,&format!("/guilds/{g}/channels"),Some(json!({
        "name":name,"type":0,"topic":topic,"permission_overwrites":overwrites,
        "reason":"Create private owner-only Timi security channel"
    }))).await?;
    Ok(created["id"].as_str().unwrap_or("").into())
}
async fn bot_join(s:&Arc<State>,g:&str,bot:&str,name:&str)->Result<()>{
    let log=ensure_private(s,g,"timi").await?;let channels=s.api(Method::GET,&format!("/guilds/{g}/channels"),None).await?;
    if let Some(list)=channels.as_array(){for c in list{
        let cid=c["id"].as_str().unwrap_or("");let n=c["name"].as_str().unwrap_or("");
        if cid==log||n=="timi-logs"||n=="timi-confirmations"{continue;}
        let _=s.api(Method::PUT,&format!("/channels/{cid}/permissions/{bot}"),Some(json!({"type":1,"allow":"0","deny":(VIEW|SEND|HISTORY|(1<<20)|(1<<21)).to_string()}))).await;
    }}
    let msg=s.send(&log,json!({"embeds":[{"color":0x808080,"title":"Bot approval required","description":format!("Do you agree on giving this bot permission to serve this server?\n\nBot: <@{bot}> ({name})\nAccess: This bot is temporarily restricted while approval is pending.")}],
        "components":[row(vec![button(&format!("botguard:yes:{g}:{bot}"),"Yes",3),button(&format!("botguard:no:{g}:{bot}"),"No",4)])]})).await?;
    if let Some(mid)=msg["id"].as_str(){s.runtime.lock().map_err(|_|anyhow!("runtime lock poisoned"))?.pending_bots.insert(format!("{g}:{bot}"),mid.into());}
    Ok(())
}
async fn member_join(s:&Arc<State>,member:&Member)->Result<()>{
    let g=member.guild_id.get().to_string();let u=member.user.id.get().to_string();
    s.update_member(&g,&u,|r|{r.joins+=1;r.last_join=now();})?;
    if member.user.bot{return bot_join(s,&g,&u,&member.user.name).await;}
    if is_guild_owner(s,&g,&u).await{return Ok(());}
    let age=now()-snowflake_time(&u);
    if age<7*DAY{
        let log=ensure_private(s,&g,"timi").await?;
        let action=if age<3*DAY{
            let until=Utc::now()+ChronoDuration::minutes(10);
            if s.api(Method::PATCH,&format!("/guilds/{g}/members/{u}"),Some(json!({"communication_disabled_until":until.to_rfc3339(),"reason":"Timi new-account safety timeout"}))).await.is_ok(){"temporarily timed out for 10 minutes"}else{"flagged; timeout could not be applied"}
        }else{"flagged for moderator review"};
        let _=s.send(&log,json!({"content":format!("New-account alert: <@{u}> joined with an account {} day(s) old. Action: {action}.",(age.max(0)/DAY)),"allowed_mentions":{"parse":[]}})).await;
    }
    let count={
        let mut rt=s.runtime.lock().map_err(|_|anyhow!("runtime lock poisoned"))?;
        let q=rt.join_bursts.entry(g.clone()).or_default();while q.front().is_some_and(|t|now()-*t>10_000){q.pop_front();}q.push_back(now());q.len()
    };
    let should_alert={
        let mut rt=s.runtime.lock().map_err(|_|anyhow!("runtime lock poisoned"))?;
        let last=rt.raid_alert_times.get(&g).copied().unwrap_or(0);
        if count>=6 && now()-last>=60_000 {rt.raid_alert_times.insert(g.clone(),now());true}else{false}
    };
    if should_alert{let log=ensure_private(s,&g,"timi").await?;let _=s.send(&log,json!({"content":format!("Security alert: {count} members joined within 10 seconds. Possible raid; review the server. No automatic raid punishment was applied."),"allowed_mentions":{"parse":[]}})).await;}
    Ok(())
}
fn normalize(text:&str)->String{
    let lower=text.to_lowercase();
    let url=Regex::new(r"(?i)https?://\S+").unwrap().replace_all(&lower,"<url>").to_string();
    let mentions=Regex::new(r"<@!?[0-9]+>|<@&[0-9]+>|<#[0-9]+>").unwrap().replace_all(&url,"<mention>").to_string();
    let clean=Regex::new(r"[\p{P}\p{S}]").unwrap().replace_all(&mentions,"").to_string();
    clean.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn verification_decision(points:u32,age_failed:bool,limits:&Limits)->&'static str{
    if age_failed{"review"}else if points>=limits.pass{"pass"}else if points>=limits.review{"review"}else{"kick"}
}
fn similarity(a:&str,b:&str)->f64{
    let x:std::collections::HashSet<&str>=a.split_whitespace().collect();let y:std::collections::HashSet<&str>=b.split_whitespace().collect();
    if x.is_empty()||y.is_empty(){return 0.0;}let intersection=x.intersection(&y).count();intersection as f64/(x.len()+y.len()-intersection) as f64
}
async fn is_guild_owner(s:&State,g:&str,user:&str)->bool{
    if let Some(owner)=s.runtime.lock().ok().and_then(|runtime|runtime.guild_owners.get(g).cloned()){
        return owner==user;
    }
    let Ok(guild)=s.api(Method::GET,&format!("/guilds/{g}"),None).await else{return false;};
    let owner=guild["owner_id"].as_str().unwrap_or("").to_owned();
    if owner.is_empty(){return false;}
    if let Ok(mut runtime)=s.runtime.lock(){runtime.guild_owners.insert(g.to_owned(),owner.clone());}
    owner==user
}
async fn is_mod(s:&State,g:&str,member_roles:&[serenity::all::RoleId])->bool{
    if let Ok(roles)=s.api(Method::GET,&format!("/guilds/{g}/roles"),None).await{
        if let Some(list)=roles.as_array(){for role in list{
            let id=role["id"].as_str().unwrap_or("");
            if id==g||member_roles.iter().any(|r|r.get().to_string()==id){
                let p=role["permissions"].as_str().and_then(|v|v.parse::<u64>().ok()).unwrap_or(0);
                if p&(MANAGE_MESSAGES|8)!=0{return true;}
            }
        }}
    }false
}
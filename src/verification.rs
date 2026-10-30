fn score(s:&State,g:&str,u:&str,user:&Value,settings:&VerifySettings)->(u32,Value,bool){
    let r=s.member(g,u);let timestamp=now();let age=((timestamp-snowflake_time(u))as f64/DAY as f64).max(0.0);let req=settings.min_age_days as f64;let critical=age<req;
    let af=if critical{0.0}else if req==0.0||age/req>=4.0{1.0}else if age/req>=2.0{0.95}else if age/req>=1.5{0.9}else if age/req>=1.2{0.8}else{0.7};
    let ap=(settings.points.age as f64*af).round()as u32;
    let penalty=((r.leaves.saturating_sub(1)as f64*settings.points.history as f64*0.2)+(r.failed as f64*settings.points.history as f64*0.15)).min(settings.points.history as f64);
    let hp=(settings.points.history as f64-penalty).round()as u32;
    let recent_attempts=r.attempts.iter().filter(|t|timestamp-**t<=600_000).count()+1;
    let tf=match recent_attempts{1=>1.0,2=>0.9,3=>0.8,4|5=>0.7,_=>0.6};let tp=(settings.points.attempts as f64*tf).round()as u32;
    let bf=match r.suspicious{0=>1.0,1=>0.65,2|3=>0.3,_=>0.0};let bp=(settings.points.behavior as f64*bf).round()as u32;
    let default_avatar=user.pointer("/avatar").map(Value::is_null).unwrap_or(true);let vp=if default_avatar{(settings.points.avatar as f64*0.25).round()as u32}else{settings.points.avatar};
    let total=ap+hp+tp+bp+vp;
    let details=json!([
        {"name":"Account age","points":ap,"max":settings.points.age,"reason":if critical{format!("Account is {age:.1} days old; minimum is {} days.",settings.min_age_days)}else{format!("Account age: {age:.1} days.")}},
        {"name":"Server history","points":hp,"max":settings.points.history,"reason":format!("{} joins, {} leaves, {} previous failed checks.",r.joins,r.leaves,r.failed)},
        {"name":"Verification attempts","points":tp,"max":settings.points.attempts,"reason":format!("{recent_attempts} attempt(s) in the last 10 minutes.")},
        {"name":"Message behavior","points":bp,"max":settings.points.behavior,"reason":format!("{} suspicious event(s). {}",r.suspicious,r.last_reason)},
        {"name":"Avatar","points":vp,"max":settings.points.avatar,"reason":if default_avatar{"Default avatar; weak signal only."}else{"Custom avatar present."}}
    ]);
    let _=s.update_member(g,u,|m|{m.attempts.retain(|t|timestamp-*t<=600_000);m.attempts.push(timestamp);});
    (total,details,critical)
}
async fn verify_component(s:&Arc<State>,id:&str,t:&str,v:&Value,custom:&str)->Result<()>{
    if custom!="verify:start"{return Ok(());}
    let g=guild_id(v);let u=user_id(v);s.defer(id,t).await?;
    let settings=s.verify(&g);let m=s.api(Method::GET,&format!("/guilds/{g}/members/{u}"),None).await?;
    let roles=m["roles"].as_array().cloned().unwrap_or_default();
    if !settings.role_id.is_empty()&&roles.iter().any(|r|r.as_str()==Some(&settings.role_id)){return s.edit_original(t,"You are already verified.").await;}
    if !settings.required_role_id.is_empty()&&!roles.iter().any(|r|r.as_str()==Some(&settings.required_role_id)){return s.edit_original(t,"You cannot start verification yet. You must first have the configured required role.").await;}
    s.edit_original(t,"**Timi verification in progress**\nRefreshing your account and reviewing server history…").await?;
    let user=m.get("user").cloned().unwrap_or_else(||json!({"id":u}));
    let (points,checks,age_failed)=score(s,&g,&u,&user,&settings);
    let result=verification_decision(points,age_failed,&settings.thresholds);
    let lines=checks.as_array().unwrap().iter().map(|x|format!("**{}:** {}/{} — {}",x["name"],x["points"],x["max"],x["reason"])).collect::<Vec<_>>().join("\n");
    let mut log=settings.review_channel_id.clone();if log.is_empty(){log=find_channel(s,&g,"timi").await.unwrap_or_default();}
    match result{
        "pass"=>{
            if settings.role_id.is_empty(){return s.edit_original(t,&format!("Your score is {points}/100, but the server owner has not configured a verified role.")).await;}
            if let Err(e)=s.api(Method::PUT,&format!("/guilds/{g}/members/{u}/roles/{}",settings.role_id),None).await{return s.edit_original(t,&format!("Your score is {points}/100, but Timi could not assign the role: {e}")).await;}
            let _=s.update_member(&g,&u,|r|r.last_verified=now());
            s.edit_original(t,&format!("**Verification passed — {points}/100**\nYour verified role has been assigned.")).await?;
            log_to(s,&g,&log,&format!("Verification passed for <@{u}> — **{points}/100**\n{lines}")).await;
        }
        "review"=>{
            s.edit_original(t,&format!("**Manual review required — {points}/100**\n{}A moderator must review your verification.",if age_failed{"Your account does not meet the server's minimum age requirement. "}else{""})).await?;
            log_to(s,&g,&log,&format!("**Verification requires manual review**\nMember: <@{u}>\nScore: **{points}/100**\n{lines}")).await;
        }
        _=>{
            s.edit_original(t,&format!("**Verification failed — {points}/100**\nYour account did not meet the server's risk threshold.")).await?;
            let _=s.api(Method::DELETE,&format!("/guilds/{g}/members/{u}?reason=Timi%20verification%20threshold"),None).await;
            let _=s.update_member(&g,&u,|r|r.failed+=1);
            log_to(s,&g,&log,&format!("**Verification failed; kick attempted**\nMember: <@{u}>\nScore: **{points}/100**\n{lines}")).await;
        }
    }
    Ok(())
}
async fn bot_component(s:&Arc<State>,id:&str,t:&str,v:&Value,custom:&str)->Result<()>{
    let bits:Vec<&str>=custom.split(':').collect();if bits.len()!=4{return Ok(());}
    let (decision,g,bot)=(bits[1],bits[2],bits[3]);let user=user_id(v);
    let guild=s.api(Method::GET,&format!("/guilds/{g}"),None).await?;
    if guild["owner_id"].as_str()!=Some(&user)&&!manage_guild(v){
        return s.reply(id,t,"Only the server owner or a member with Manage Server can decide.",true).await;
    }
    let key=format!("{g}:{bot}");
    let pending=s.runtime.lock().ok().and_then(|r|r.pending_bots.get(&key).cloned());
    if pending.as_deref()!=v.pointer("/message/id").and_then(Value::as_str){
        return s.reply(id,t,"This request is no longer pending.",true).await;
    }
    let bot_member=s.api(Method::GET,&format!("/guilds/{g}/members/{bot}"),None).await.ok();
    if decision=="no"{
        if bot_member.is_some(){
            if let Err(error)=s.api(Method::DELETE,&format!("/guilds/{g}/members/{bot}?reason=Bot%20rejected%20through%20Timi%20bot%20protection"),None).await{
                return s.reply(id,t,&format!("Timi could not remove the rejected bot. Check Kick Members permission and role hierarchy. Details: {error}"),true).await;
            }
        }
        s.runtime.lock().ok().map(|mut r|r.pending_bots.remove(&key));
        let content=if bot_member.is_some(){"Bot rejected and removed from the server."}else{"Bot was already no longer in the server; the approval request was cleared."};
        return s.callback(id,t,7,Some(json!({"content":content,"embeds":[],"components":[]}))).await;
    }
    if decision=="yes"{
        if bot_member.is_none(){
            s.runtime.lock().ok().map(|mut r|r.pending_bots.remove(&key));
            return s.callback(id,t,7,Some(json!({"content":"The bot left before approval was completed. The request has been cleared.","embeds":[],"components":[]}))).await;
        }
        let channels=s.api(Method::GET,&format!("/guilds/{g}/channels"),None).await?;
        let mut failures=0usize;
        if let Some(items)=channels.as_array(){for channel in items{
            let cid=channel["id"].as_str().unwrap_or("");
            let name=channel["name"].as_str().unwrap_or("");
            let has_overwrite=channel["permission_overwrites"].as_array()
                .is_some_and(|a|a.iter().any(|o|o["id"].as_str()==Some(bot)));
            if !has_overwrite{continue;}
            let result=if ["timi","timi-logs","timi-confirmations"].contains(&name){
                s.api(Method::PUT,&format!("/channels/{cid}/permissions/{bot}"),Some(json!({
                    "type":1,"allow":"0","deny":(VIEW|SEND|HISTORY).to_string()
                }))).await
            }else{
                s.api(Method::DELETE,&format!("/channels/{cid}/permissions/{bot}"),None).await
            };
            if result.is_err(){failures+=1;}
        }}
        s.runtime.lock().ok().map(|mut r|r.pending_bots.remove(&key));
        let content=if failures==0{
            "Bot approved. Temporary restrictions were removed; private Timi channels remain inaccessible."
        }else{
            "Bot approved, but Timi could not update every temporary channel restriction. Check Manage Channels permission and review the bot's channel permissions."
        };
        return s.callback(id,t,7,Some(json!({"content":content,"embeds":[],"components":[]}))).await;
    }
    Ok(())
}
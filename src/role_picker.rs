fn role_picker_setup_components(draft_id:&str,selected:&[String])->Vec<Value>{
    let mut select=json!({"type":6,"custom_id":format!("rolepicker:setup-roles:{draft_id}"),
        "placeholder":"Choose the roles members can pick","min_values":1,"max_values":25});
    if !selected.is_empty(){select["default_values"]=json!(selected.iter().map(|id|json!({"id":id,"type":"role"})).collect::<Vec<_>>());}
    vec![row(vec![select]),row(vec![button(&format!("rolepicker:publish:{draft_id}"),"Publish role menu",1)])]
}
fn role_picker_public_payload(menu:&RolePickerMenu)->Value{
    let options=menu.roles.iter().map(|r|json!({"label":r.name.chars().take(100).collect::<String>(),"value":r.id})).collect::<Vec<_>>();
    let max=menu.roles.len().max(1).min(25);
    let select=json!({"type":3,"custom_id":format!("rolepicker:menu:{}",menu.id),
        "placeholder":menu.placeholder.chars().take(150).collect::<String>(),
        "min_values":0,"max_values":max,"options":options});
    let mut components=vec![row(vec![select])];
    if !menu.footer_text.trim().is_empty()&&!menu.footer_channel_id.is_empty(){
        components.push(row(vec![json!({"type":2,"style":5,"label":menu.footer_text.chars().take(80).collect::<String>(),
            "url":format!("https://discord.com/channels/{}/{}",menu.guild_id,menu.footer_channel_id)})]));
    }
    json!({"embeds":[{"color":8421504,"title":menu.title,"description":menu.description}],
        "components":components,"allowed_mentions":{"parse":[]}})
}
async fn role_picker_component(s:&Arc<State>,id:&str,t:&str,v:&Value,custom:&str)->Result<()>{
    let g=guild_id(v);let u=user_id(v);let channel=channel_id(v);
    if custom=="rolepicker:start"{
        let server=s.api(Method::GET,&format!("/guilds/{g}"),None).await?;
        if server["owner_id"].as_str()!=Some(&u){return s.reply(id,t,"Only the server owner can configure role picker menus.",true).await;}
        return s.callback(id,t,9,Some(modal("rolepicker:details","Role picker settings",vec![
            input("rp-title","Menu title","notifications",false,100),
            input("rp-description","Description","choose what you want to be pinged for.",true,500),
            input("rp-placeholder","Dropdown placeholder","select...",false,150),
            optional_input("rp-footer","Bottom button text","Done reading? Check out #chat.",false,80),
            optional_input("rp-footer-channel","Bottom button channel ID (optional)","",false,22)
        ]))).await;
    }
    if let Some(draft_id)=custom.strip_prefix("rolepicker:setup-roles:"){
        let mut draft=match s.role_picker_draft(draft_id){Some(d)=>d,None=>return s.reply(id,t,"This setup has expired. Run /setup-role-picker again.",true).await};
        if draft.guild_id!=g{return s.reply(id,t,"This setup belongs to another server.",true).await;}
        draft.roles=v.pointer("/data/values").and_then(Value::as_array).map(|a|a.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        if draft.roles.is_empty(){return s.reply(id,t,"Select at least one role for this menu.",true).await;}
        if draft.roles.len()>25{return s.reply(id,t,"Discord role menus support up to 25 roles.",true).await;}
        s.save_role_picker_draft(draft_id,draft.clone())?;
        return reply_update(s,id,t,&format!("**{}**\n{}\n\n**Roles included:** {}\n\nChange the selection above or publish this menu.",draft.title,draft.description,draft.roles.len()),role_picker_setup_components(draft_id,&draft.roles)).await;
    }
    if let Some(draft_id)=custom.strip_prefix("rolepicker:publish:"){
        let draft=match s.role_picker_draft(draft_id){Some(d)=>d,None=>return s.reply(id,t,"This setup has expired. Run /setup-role-picker again.",true).await};
        if draft.guild_id!=g||draft.roles.is_empty(){return s.reply(id,t,"Choose at least one role before publishing.",true).await;}
        s.defer(id,t).await?;
        let list=s.api(Method::GET,&format!("/guilds/{g}/roles"),None).await?;
        let all=list.as_array().cloned().unwrap_or_default();
        let mut roles=Vec::new();
        for role_id in &draft.roles{
            let role=match all.iter().find(|r|r["id"].as_str()==Some(role_id)){
                Some(r)=>r,None=>return s.edit_original(t,"One of the selected roles no longer exists. Reopen setup and select the roles again.").await
            };
            if let Err(reason)=validate_verification_role(s,&g,role_id,true).await{return s.edit_original(t,&reason).await;}
            roles.push(RolePickerRole{id:role_id.clone(),name:role["name"].as_str().unwrap_or("Role").to_owned()});
        }
        let menu_id=format!("{}-{}",now(),id);
        let mut menu=RolePickerMenu{id:menu_id.clone(),guild_id:g.clone(),channel_id:draft.channel_id.clone(),
            title:draft.title,description:draft.description,placeholder:draft.placeholder,
            footer_text:draft.footer_text,footer_channel_id:draft.footer_channel_id,roles,selections:HashMap::new(),message_id:String::new()};
        let message=s.send(&menu.channel_id,role_picker_public_payload(&menu)).await?;
        menu.message_id=message["id"].as_str().unwrap_or("").to_owned();
        s.save_role_picker_menu(menu)?;
        if let Ok(mut store)=s.store.lock(){store.role_picker_drafts.remove(draft_id);}
        s.persist()?;
        return s.edit_original(t,&format!("Role picker menu published in <#{}>. Menu ID: {}. Run /setup-role-picker to create another menu.",draft.channel_id,menu_id)).await;
    }
    if let Some(menu_id)=custom.strip_prefix("rolepicker:menu:"){
        let mut menu=match s.role_picker_menu(menu_id){Some(m)=>m,None=>return s.reply(id,t,"This role picker is no longer available.",true).await};
        if menu.guild_id!=g{return s.reply(id,t,"This role picker belongs to another server.",true).await;}
        let selected=v.pointer("/data/values").and_then(Value::as_array).map(|a|a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()).unwrap_or_default();
        let previous=menu.selections.get(&u).cloned().unwrap_or_default();
        let add=selected.iter().filter(|r|!previous.contains(r)).cloned().collect::<Vec<_>>();
        let remove=previous.iter().filter(|r|!selected.contains(r)).cloned().collect::<Vec<_>>();
        for role in &add{
            if let Err(error)=s.api(Method::PUT,&format!("/guilds/{g}/members/{u}/roles/{role}"),None).await{
                return s.reply(id,t,&format!("Timi could not assign a selected role. Check Manage Roles and role hierarchy. {error}"),true).await;
            }
        }
        for role in &remove{
            if let Err(error)=s.api(Method::DELETE,&format!("/guilds/{g}/members/{u}/roles/{role}"),None).await{
                return s.reply(id,t,&format!("Timi could not remove a deselected role. Check Manage Roles and role hierarchy. {error}"),true).await;
            }
        }
        menu.selections.insert(u,selected.clone());
        s.save_role_picker_menu(menu)?;
        return s.reply(id,t,if selected.is_empty(){"Your role selections have been cleared."}else{"Your role selections have been updated."},true).await;
    }
    Ok(())
}
async fn role_picker_modal_submit(s:&Arc<State>,id:&str,t:&str,v:&Value,custom:&str,fields:&HashMap<String,String>)->Result<()>{
    if custom!="rolepicker:details"{return Ok(());}
    let g=guild_id(v);let u=user_id(v);let channel=channel_id(v);
    let server=s.api(Method::GET,&format!("/guilds/{g}"),None).await?;
    if server["owner_id"].as_str()!=Some(&u){return s.reply(id,t,"Only the server owner can configure role picker menus.",true).await;}
    let title=fields.get("rp-title").cloned().unwrap_or_default().trim().to_owned();
    let description=fields.get("rp-description").cloned().unwrap_or_default().trim().to_owned();
    let placeholder=fields.get("rp-placeholder").cloned().unwrap_or_default().trim().to_owned();
    let footer_text=fields.get("rp-footer").cloned().unwrap_or_default().trim().to_owned();
    let footer_channel_id=fields.get("rp-footer-channel").cloned().unwrap_or_default().trim().to_owned();
    if title.is_empty()||description.is_empty()||placeholder.is_empty(){return s.reply(id,t,"Menu title, description, and placeholder are required.",true).await;}
    if !footer_channel_id.is_empty()&&!snowflake(&footer_channel_id){return s.reply(id,t,"The bottom button channel must be a valid channel ID.",true).await;}
    let draft_id=format!("{}-{}",g,id);
    let draft=RolePickerDraft{guild_id:g.clone(),channel_id:channel,title,description,placeholder,footer_text,footer_channel_id,roles:Vec::new()};
    s.save_role_picker_draft(&draft_id,draft.clone())?;
    let roles=s.api(Method::GET,&format!("/guilds/{g}/roles"),None).await?;
    let count=roles.as_array().map(|a|a.iter().filter(|r|r["id"].as_str()!=Some(&draft.guild_id)&&!r["managed"].as_bool().unwrap_or(false)).count()).unwrap_or(0);
    let select=json!({"type":6,"custom_id":format!("rolepicker:setup-roles:{draft_id}"),
        "placeholder":"Choose the roles members can pick","min_values":1,"max_values":25});
    s.callback(id,t,4,Some(json!({"content":format!("**{}**\n{}\n\nChoose which roles members can select. {} assignable roles were found. Select up to 25.",draft.title,draft.description,count),"components":[row(vec![select])],"flags":64}))).await
}

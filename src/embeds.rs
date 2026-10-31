
fn embed_key_name(custom:&str)->&str{custom.rsplit(':').next().unwrap_or("")}
fn embed_payload(e:&SavedEmbed)->Value{
    let mut v=json!({"color":0x808080});
    if !e.title.is_empty(){v["title"]=json!(e.title);}
    if !e.description.is_empty(){v["description"]=json!(e.description);}
    if !e.author.is_empty(){v["author"]=json!({"name":e.author});}
    if !e.footer.is_empty(){v["footer"]=json!({"text":e.footer});}
    if !e.url.is_empty(){v["url"]=json!(e.url);}
    if !e.thumbnail.is_empty(){v["thumbnail"]=json!({"url":e.thumbnail});}
    if !e.image.is_empty(){v["image"]=json!({"url":e.image});}
    if !e.fields.is_empty(){v["fields"]=json!(e.fields.iter().map(|f|json!({"name":f.name,"value":f.value,"inline":f.inline})).collect::<Vec<_>>());}
    v
}
fn embed_editor_text(e:&SavedEmbed)->String{
    format!("**Embed editor: {}**\n\nTitle: {}\nDescription: {}\nColor: #808080\nAuthor: {}\nFooter: {}\nFields: {}\n{}\nThumbnail: {}\nImage: {}\nURL: {}\n\nChanges save automatically and update every message placed with /place-embed.",
        e.name,if e.title.is_empty(){"—"}else{&e.title},if e.description.is_empty(){"—"}else{&e.description},
        if e.author.is_empty(){"—"}else{&e.author},if e.footer.is_empty(){"—"}else{&e.footer},e.fields.len(),
        if e.fields.is_empty(){ "No fields".to_owned() }else{e.fields.iter().enumerate().map(|(i,f)|format!("{}. {}{}",i+1,f.name,if f.inline{" (inline)"}else{""})).collect::<Vec<_>>().join("\\n")},
        if e.thumbnail.is_empty(){"—"}else{"Set"},if e.image.is_empty(){"—"}else{"Set"},if e.url.is_empty(){"—"}else{&e.url})
}
fn embed_editor_components(e:&SavedEmbed)->Vec<Value>{
    let n=&e.name;
    vec![row(vec![button(&format!("embed:content:{n}"),"Title & description",1),button(&format!("embed:style:{n}"),"Appearance",2)]),
         row(vec![button(&format!("embed:media:{n}"),"Images & link",2),button(&format!("embed:add-field:{n}"),"Add field",2),button(&format!("embed:remove-field:{n}"),"Remove field",4)])]
}
async fn refresh_saved_embed(s:&State,e:&SavedEmbed){
    let payload=json!({"embeds":[embed_payload(e)],"allowed_mentions":{"parse":[]}});
    for p in &e.placements{if let Err(error)=s.edit(&p.channel_id,&p.message_id,payload.clone()).await{warn!("Could not refresh placed embed {} in channel {}: {error:#}",e.name,p.channel_id);}}
}
async fn embed_component(s:&Arc<State>,id:&str,t:&str,v:&Value,custom:&str)->Result<()>{
    let g=guild_id(v);let u=user_id(v);
    if !manage_guild(v){return s.reply(id,t,"You need Manage Server permission to edit embeds.",true).await;}
    let name=embed_key_name(custom);
    let Some(e)=s.embed(&g,name) else{return s.reply(id,t,"This saved embed no longer exists.",true).await;};
    if e.creator_id!=u&&!manage_guild(v){return s.reply(id,t,"Only the embed creator or a server manager can edit it.",true).await;}
    let modal_data=match custom.split(':').nth(1).unwrap_or(""){
        "content"=>Some(modal(&format!("embed:content:{name}"),"Edit embed content",vec![input("title","Title",&e.title,false,256),input("description","Description",&e.description,true,4000)])),
        "style"=>Some(modal(&format!("embed:style:{name}"),"Edit embed appearance",vec![optional_input("author","Author",&e.author,false,256),optional_input("footer","Footer",&e.footer,false,2048)])),
        "media"=>Some(modal(&format!("embed:media:{name}"),"Edit embed images and link",vec![optional_input("thumbnail","Thumbnail image URL",&e.thumbnail,false,500),optional_input("image","Main image URL",&e.image,false,500),optional_input("url","Title URL",&e.url,false,500)])),
        "add-field"=>Some(modal(&format!("embed:add-field:{name}"),"Add embed field",vec![input("field-name","Field name","",false,256),input("field-value","Field value","",true,1024),optional_input("inline","Inline? type true or false","false",false,5)])),
        "remove-field"=>Some(modal(&format!("embed:remove-field:{name}"),"Remove embed field",vec![input("field-index","Field number to remove (1-based)","",false,2)])),
        _=>None
    };
    if let Some(m)=modal_data{return s.callback(id,t,9,Some(m)).await;}
    Ok(())
}
async fn embed_modal_submit(s:&Arc<State>,t:&str,v:&Value,custom:&str,fields:&HashMap<String,String>)->Result<()>{
    let g=guild_id(v);let u=user_id(v);
    if !manage_guild(v){return s.edit_original(t,"You need Manage Server permission to edit embeds.").await;}
    if custom=="embed:create"{
        let name=fields.get("name").cloned().unwrap_or_default().trim().to_lowercase();
        let title=fields.get("title").cloned().unwrap_or_default().trim().to_owned();
        let description=fields.get("description").cloned().unwrap_or_default().trim().to_owned();
        if name.is_empty()||!name.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'||c=='_')||title.is_empty()||description.is_empty(){return s.edit_original(t,"Enter a name using letters, numbers, - or _, plus a title and description.").await;}
        if s.embed(&g,&name).is_some(){return s.edit_original(t,"An embed with that name already exists. Use /edit-embed to change it.").await;}
        let e=SavedEmbed{guild_id:g,name,creator_id:u,title,description,..SavedEmbed::default()};
        s.save_embed(e.clone())?;
        return s.edit_original_with_components(t,&embed_editor_text(&e),embed_editor_components(&e)).await;
    }
    let name=embed_key_name(custom);
    let Some(mut e)=s.embed(&g,name) else{return s.edit_original(t,"This saved embed no longer exists.").await;};
    
    match custom.split(':').nth(1).unwrap_or(""){
        "content"=>{e.title=fields.get("title").cloned().unwrap_or_default().trim().into();e.description=fields.get("description").cloned().unwrap_or_default().trim().into();}
        "style"=>{
            e.color=0x808080;
            e.author=fields.get("author").cloned().unwrap_or_default().trim().into();e.footer=fields.get("footer").cloned().unwrap_or_default().trim().into();
        }
        "media"=>{
            e.thumbnail=fields.get("thumbnail").cloned().unwrap_or_default().trim().into();e.image=fields.get("image").cloned().unwrap_or_default().trim().into();e.url=fields.get("url").cloned().unwrap_or_default().trim().into();
            for url in [&e.thumbnail,&e.image,&e.url]{if !url.is_empty()&&!url.starts_with("https://"){return s.edit_original(t,"Image and title links must use HTTPS URLs.").await;}}
        }
        "add-field"=>{
            if e.fields.len()>=25{return s.edit_original(t,"Discord embeds support up to 25 fields.").await;}
            let name=fields.get("field-name").cloned().unwrap_or_default().trim().to_owned();let value=fields.get("field-value").cloned().unwrap_or_default().trim().to_owned();
            if name.is_empty()||value.is_empty(){return s.edit_original(t,"Field name and value are required.").await;}
            let inline=fields.get("inline").is_some_and(|v|v.eq_ignore_ascii_case("true")||v=="yes");e.fields.push(EmbedField{name,value,inline});
        }
        "remove-field"=>{
            let index=fields.get("field-index").and_then(|v|v.parse::<usize>().ok()).unwrap_or(0);
            if index==0||index>e.fields.len(){return s.edit_original(t,"Enter a valid field number shown in the embed editor.").await;}e.fields.remove(index-1);
        }
        _=>return Ok(())
    }
    s.save_embed(e.clone())?;refresh_saved_embed(s,&e).await;
    s.edit_original_with_components(t,&embed_editor_text(&e),embed_editor_components(&e)).await
}

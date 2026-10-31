#[derive(Clone)]
struct Config { token: String, client_id: String, guild_id: Option<String>, data_dir: PathBuf }
impl Config {
    fn load() -> Result<Self> {
        dotenvy::dotenv().ok();
        let token = env::var("DISCORD_TOKEN").context("DISCORD_TOKEN is missing from .env")?;
        let client_id = env::var("CLIENT_ID").context("CLIENT_ID is missing from .env")?;
        let guild_id = env::var("GUILD_ID").ok().filter(|v| !v.trim().is_empty());
        if !client_id.chars().all(|c| c.is_ascii_digit()) { bail!("CLIENT_ID must be numeric."); }
        if guild_id.as_ref().is_some_and(|v| !v.chars().all(|c| c.is_ascii_digit())) { bail!("GUILD_ID must be numeric."); }
        let data_dir = PathBuf::from(env::var("DATA_DIR").unwrap_or_else(|_| "data".into()));
        fs::create_dir_all(&data_dir)?;
        Ok(Self { token, client_id, guild_id, data_dir })
    }
}

fn null_to_empty<'de,D>(deserializer:D)->std::result::Result<String,D::Error>
where D:Deserializer<'de>{
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelRef { channel_id: String, message_id: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TicketSettings {
    panel_title: String, panel_description: String,
    #[serde(rename = "openButtonLabel")] open_label: String,
    ticket_message: String,
    #[serde(rename = "closeButtonLabel")] close_label: String,
    category_name: String, #[serde(deserialize_with = "null_to_empty")] support_role_id: String,
    #[serde(deserialize_with = "null_to_empty")] transcript_channel_id: String,
    #[serde(deserialize_with = "null_to_empty")] panel_channel_id: String, published_panels: Vec<PanelRef>,
}
impl Default for TicketSettings {
    fn default() -> Self {
        Self { panel_title:"Support Tickets".into(),
            panel_description:"Need help? Open a ticket and our team will assist you.".into(),
            open_label:"Open Ticket".into(),
            ticket_message:"Please describe what you need help with. A member of the support team will be with you shortly.".into(),
            close_label:"Close Ticket".into(), category_name:"ticket".into(),
            support_role_id:String::new(), transcript_channel_id:String::new(),
            panel_channel_id:String::new(), published_panels:Vec::new() }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ModSettings {
    enabled: bool, sanction: String, timeout_minutes: u64,
    #[serde(deserialize_with = "null_to_empty")] log_channel_id: String,
    action_duration_seconds: u64, max_message_count: usize, block_invites: bool,
    block_mass_mentions: bool, block_excessive_caps: bool,
    #[serde(deserialize_with = "null_to_empty")] panel_channel_id: String,
    #[serde(deserialize_with = "null_to_empty")] panel_message_id: String,
}
impl Default for ModSettings {
    fn default() -> Self { Self { enabled:true, sanction:"timeout".into(), timeout_minutes:10,
        log_channel_id:String::new(), action_duration_seconds:3, max_message_count:3,
        block_invites:true, block_mass_mentions:true, block_excessive_caps:true,
        panel_channel_id:String::new(), panel_message_id:String::new() } }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Points { age:u32, history:u32, attempts:u32, behavior:u32, avatar:u32 }
impl Default for Points { fn default()->Self { Self{age:40,history:20,attempts:20,behavior:10,avatar:10} } }
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Limits { pass:u32, review:u32 }
impl Default for Limits { fn default()->Self { Self{pass:80,review:60} } }
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct VerifySettings {
    #[serde(deserialize_with = "null_to_empty")] role_id:String,
    #[serde(deserialize_with = "null_to_empty")] required_role_id:String,
    #[serde(deserialize_with = "null_to_empty")] review_channel_id:String,
    #[serde(rename = "minAccountAgeDays")] min_age_days:u64,
    panel_title:String, panel_description:String, published_panels:Vec<PanelRef>,
    #[serde(rename = "pointMax")] points:Points, thresholds:Limits,
}
impl Default for VerifySettings {
    fn default()->Self { Self{role_id:String::new(),required_role_id:String::new(),review_channel_id:String::new(),
        min_age_days:7,panel_title:"Verify your account".into(),
        panel_description:"Press Verify to have Timi assess your account and server history.".into(),
        published_panels:Vec::new(),points:Points::default(),thresholds:Limits::default()} }
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct MemberRecord {
    joins:u64, leaves:u64,
    #[serde(rename = "verificationAttempts")] attempts:Vec<i64>,
    #[serde(rename = "failedChecks")] failed:u64,
    #[serde(rename = "suspiciousMessages")] suspicious:u64,
    #[serde(rename = "lastJoinAt")] last_join:i64,
    #[serde(rename = "lastVerifiedAt")] last_verified:i64,
    #[serde(rename = "lastSuspiciousAt")] last_suspicious:i64,
    #[serde(rename = "lastSuspiciousReason")] last_reason:String,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct RolePickerRole { id:String, name:String }
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct RolePickerDraft {
    guild_id:String, channel_id:String, title:String, description:String,
    placeholder:String, footer_text:String, footer_channel_id:String, roles:Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct RolePickerMenu {
    id:String, guild_id:String, channel_id:String, message_id:String, title:String,
    description:String, placeholder:String, footer_text:String, footer_channel_id:String,
    roles:Vec<RolePickerRole>, selections:HashMap<String,Vec<String>>,
}
#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)] tickets:HashMap<String,TicketSettings>,
    #[serde(default)] moderation:HashMap<String,ModSettings>,
    #[serde(default)] verification:HashMap<String,VerifySettings>,
    #[serde(default)] members:HashMap<String,MemberRecord>,
    #[serde(default)] channels:HashMap<String,Value>,
    #[serde(default)] messages:HashMap<String,Vec<Value>>,
    #[serde(default)] role_picker_menus:HashMap<String,RolePickerMenu>,
    #[serde(default)] role_picker_drafts:HashMap<String,RolePickerDraft>,
    #[serde(default)] embeds:HashMap<String,SavedEmbed>,
    #[serde(default)] moderation_cases:HashMap<String,Vec<Value>>,
    #[serde(default)] automod_words:HashMap<String,Vec<String>>,
}
fn migrate_legacy_data(dir:&std::path::Path,store:&mut Store)->Result<bool>{
    fn read(path:&PathBuf)->Option<Value>{fs::read(path).ok().and_then(|b|serde_json::from_slice(&b).ok())}
    let mut changed=false;
    if let Some(raw)=read(&dir.join("ticket-settings.json")){
        if let Some(guilds)=raw.as_object(){for (guild,value) in guilds{
            if store.tickets.contains_key(guild){continue;}
            if let Ok(mut settings)=serde_json::from_value::<TicketSettings>(value.clone()){
                if settings.published_panels.is_empty(){
                    settings.published_panels=value.get("publishedPanels").and_then(Value::as_array)
                        .cloned().unwrap_or_default().into_iter().filter_map(|p|serde_json::from_value(p).ok()).collect();
                }
                store.tickets.insert(guild.clone(),settings);changed=true;
            }
        }}
    }
    if let Some(raw)=read(&dir.join("moderation-settings.json")){
        if let Some(guilds)=raw.as_object(){for (guild,value) in guilds{
            if store.moderation.contains_key(guild){continue;}
            if let Ok(settings)=serde_json::from_value::<ModSettings>(value.clone()){
                store.moderation.insert(guild.clone(),settings);changed=true;
            }
        }}
    }
    if let Some(raw)=read(&dir.join("verification.json")){
        if let Some(guilds)=raw.get("guilds").and_then(Value::as_object){for (guild,value) in guilds{
            if store.verification.contains_key(guild){continue;}
            if let Ok(settings)=serde_json::from_value::<VerifySettings>(value.clone()){
                store.verification.insert(guild.clone(),settings);changed=true;
            }
        }}
        if let Some(members)=raw.get("members").and_then(Value::as_object){for (key,value) in members{
            if store.members.contains_key(key){continue;}
            if let Ok(record)=serde_json::from_value::<MemberRecord>(value.clone()){
                store.members.insert(key.clone(),record);changed=true;
            }
        }}
    }
    if let Some(raw)=read(&dir.join("recovery-backup.json")){
        if let Some(guilds)=raw.get("guilds").and_then(Value::as_object){for (guild,data) in guilds{
            if let Some(channels)=data.get("channels").and_then(Value::as_object){for (channel_id,channel) in channels{
                let key=format!("{guild}:{channel_id}");
                if store.channels.contains_key(&key){continue;}
                let mut snapshot=channel.clone();
                if let Some(obj)=snapshot.as_object_mut(){
                    for (old,new) in [("parentId","parent_id"),("rateLimitPerUser","rate_limit_per_user"),("userLimit","user_limit"),("permissionOverwrites","permission_overwrites")]{
                        if let Some(v)=obj.remove(old){obj.insert(new.into(),v);}
                    }
                    if let Some(permissions)=obj.get_mut("permission_overwrites").and_then(Value::as_array_mut){
                        for permission in permissions{
                            if let Some(fields)=permission.as_object_mut(){
                                if let Some(v)=fields.remove("allow"){fields.insert("allow".into(),v);}
                                if let Some(v)=fields.remove("deny"){fields.insert("deny".into(),v);}
                            }
                        }
                    }
                }
                store.channels.insert(key,snapshot);changed=true;
            }}
            if let Some(messages)=data.get("messages").and_then(Value::as_array){
                let target=store.messages.entry(guild.clone()).or_default();
                for message in messages{
                    let channel=message.get("channelId").or_else(||message.get("channel_id")).cloned().unwrap_or(Value::Null);
                    let author=message.get("authorId").or_else(||message.get("author_id")).cloned().unwrap_or(Value::Null);
                    let content=message.get("content").cloned().unwrap_or(Value::String(String::new()));
                    let created=message.get("createdAt").or_else(||message.get("timestamp_ms")).and_then(Value::as_i64).unwrap_or(0);
                    let converted=json!({"id":message.get("id").cloned().unwrap_or(Value::Null),
                        "channel_id":channel,"author_id":author,"content":content,"timestamp_ms":created,
                        "attachments":message.get("attachments").cloned().unwrap_or(json!([]))});
                    let duplicate=target.iter().any(|m|m.get("id")==converted.get("id"));
                    if !duplicate{target.push(converted);changed=true;}
                }
                let cutoff=now()-WEEK;
                target.retain(|m|m.get("timestamp_ms").and_then(Value::as_i64).unwrap_or(0)>=cutoff);
                if target.len()>MAX_MESSAGE_BACKUP{let n=target.len()-MAX_MESSAGE_BACKUP;target.drain(0..n);}
            }
        }}
    }
    Ok(changed)
}
struct SpamEntry { id:String, at:i64, content:String, link_count:usize }
#[derive(Default)]
struct Runtime {
    spam:HashMap<String,VecDeque<SpamEntry>>,
    ticket_cooldowns:HashMap<String,i64>,
    join_bursts:HashMap<String,VecDeque<i64>>,
    raid_alert_times:HashMap<String,i64>,
    guild_owners:HashMap<String,String>,
    deleted_channels:HashMap<String,VecDeque<(i64,String)>>,
    pending_bots:HashMap<String,String>,
    persist_dirty:bool,
    persist_pending:bool,
}
struct State {
    config:Config, http:HttpClient, store:Mutex<Store>, runtime:Mutex<Runtime>,
}
impl State {
    fn new(config:Config)->Result<Arc<Self>> {
        let path=config.data_dir.join("timi.json");
        let mut store=if path.exists(){serde_json::from_slice(&fs::read(&path)?).unwrap_or_default()}else{Store::default()};
        if migrate_legacy_data(&config.data_dir,&mut store)? {
            let bytes=serde_json::to_vec_pretty(&store)?;
            let temp=config.data_dir.join("timi.json.tmp");
            fs::write(&temp,bytes)?;
            fs::rename(temp,&path)?;
            info!("Imported legacy Timi JSON settings and recovery records into data/timi.json.");
        }
        Ok(Arc::new(Self{config,http:HttpClient::builder().user_agent("TimiBot/2.0").build()?,
            store:Mutex::new(store),runtime:Mutex::new(Runtime::default())}))
    }
    fn persist(&self)->Result<()> {
        let data={let s=self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?;serde_json::to_vec_pretty(&*s)?};
        let path=self.config.data_dir.join("timi.json");let tmp=self.config.data_dir.join("timi.json.tmp");
        fs::write(&tmp,data)?;fs::rename(tmp,path)?;Ok(())
    }
    fn schedule_persist(self:&Arc<Self>){
        let start={
            let Ok(mut runtime)=self.runtime.lock() else{return;};
            runtime.persist_dirty=true;
            if runtime.persist_pending{false}else{runtime.persist_pending=true;true}
        };
        if !start{return;}
        let state=Arc::clone(self);
        tokio::spawn(async move{
            loop{
                sleep(Duration::from_millis(750)).await;
                let should_write={
                    let Ok(mut runtime)=state.runtime.lock() else{return;};
                    if !runtime.persist_dirty{runtime.persist_pending=false;return;}
                    runtime.persist_dirty=false;
                    true
                };
                if should_write{
                    if let Err(error)=state.persist(){error!("Debounced data persistence failed: {error:#}");}
                }
                let finished={
                    let Ok(mut runtime)=state.runtime.lock() else{return;};
                    if runtime.persist_dirty{false}else{runtime.persist_pending=false;true}
                };
                if finished{return;}
            }
        });
    }
    fn ticket(&self,g:&str)->TicketSettings { self.store.lock().ok().and_then(|s|s.tickets.get(g).cloned()).unwrap_or_default() }
    fn mods(&self,g:&str)->ModSettings { self.store.lock().ok().and_then(|s|s.moderation.get(g).cloned()).unwrap_or_default() }
    fn verify(&self,g:&str)->VerifySettings { self.store.lock().ok().and_then(|s|s.verification.get(g).cloned()).unwrap_or_default() }
    fn member(&self,g:&str,u:&str)->MemberRecord { self.store.lock().ok().and_then(|s|s.members.get(&format!("{g}:{u}")).cloned()).unwrap_or_default() }
    fn role_picker_draft(&self,id:&str)->Option<RolePickerDraft>{self.store.lock().ok().and_then(|s|s.role_picker_drafts.get(id).cloned())}
    fn role_picker_menu(&self,id:&str)->Option<RolePickerMenu>{self.store.lock().ok().and_then(|s|s.role_picker_menus.get(id).cloned())}
    fn embed(&self,g:&str,n:&str)->Option<SavedEmbed>{self.store.lock().ok().and_then(|s|s.embeds.get(&format!("{g}:{n}")).cloned())}
    fn save_embed(&self,e:SavedEmbed)->Result<()>{let key=format!("{}:{}",e.guild_id,e.name);self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?.embeds.insert(key,e);self.persist()}
    fn save_role_picker_draft(&self,id:&str,draft:RolePickerDraft)->Result<()>{
        self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?.role_picker_drafts.insert(id.into(),draft);self.persist()
    }
    fn save_role_picker_menu(&self,menu:RolePickerMenu)->Result<()>{
        self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?.role_picker_menus.insert(menu.id.clone(),menu);self.persist()
    }
    fn save_ticket(&self,g:&str,v:TicketSettings)->Result<()> { self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?.tickets.insert(g.into(),v);self.persist() }
    fn queue_mods(self:&Arc<Self>,g:&str,v:ModSettings)->Result<()> {
        self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?.moderation.insert(g.into(),v);
        self.schedule_persist();
        Ok(())
    }
    fn save_mods(&self,g:&str,v:ModSettings)->Result<()> { self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?.moderation.insert(g.into(),v);self.persist() }
    fn save_verify(&self,g:&str,v:VerifySettings)->Result<()> { self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?.verification.insert(g.into(),v);self.persist() }
    fn update_member<F:FnOnce(&mut MemberRecord)>(&self,g:&str,u:&str,f:F)->Result<()> {
        {let mut s=self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?;f(s.members.entry(format!("{g}:{u}")).or_default());}self.persist()
    }
    async fn api(&self,method:Method,path:&str,body:Option<Value>)->Result<Value> {
        for attempt in 0..=5u32 {
            let mut req=self.http.request(method.clone(),format!("{API}{path}"))
                .header("Authorization",format!("Bot {}",self.config.token));
            if let Some(payload)=&body{req=req.json(payload);}
            let response=req.send().await?;
            let status=response.status();
            let text=response.text().await.unwrap_or_default();
            if status==StatusCode::TOO_MANY_REQUESTS {
                if attempt==5{bail!("Discord API rate limit persisted after retries at {path}.");}
                let retry=serde_json::from_str::<Value>(&text).ok()
                    .and_then(|v|v.get("retry_after").and_then(Value::as_f64))
                    .unwrap_or(1.0).clamp(0.25,30.0);
                warn!("Discord rate limit at {path}; retrying after {retry:.2}s.");
                sleep(Duration::from_secs_f64(retry)).await;
                continue;
            }
            if status.is_server_error() && attempt<3 {
                let delay=Duration::from_millis(500u64.saturating_mul(2u64.pow(attempt)));
                warn!("Discord API returned {status} at {path}; retrying.");
                sleep(delay).await;
                continue;
            }
            if !status.is_success()&&status!=StatusCode::NO_CONTENT {
                bail!("Discord API {status} at {path}: {}",text.chars().take(600).collect::<String>());
            }
            if text.is_empty(){return Ok(Value::Null);}
            return Ok(serde_json::from_str(&text).unwrap_or(Value::String(text)));
        }
        bail!("Discord API request exhausted retries at {path}.")
    }
    async fn callback(&self,id:&str,t:&str,kind:u8,data:Option<Value>)->Result<()> {
        let mut v=json!({"type":kind});if let Some(d)=data{v["data"]=d;}
        self.api(Method::POST,&format!("/interactions/{id}/{t}/callback"),Some(v)).await?;Ok(())
    }
    async fn reply(&self,id:&str,t:&str,text:&str,ephemeral:bool)->Result<()> {
        self.callback(id,t,4,Some(json!({"content":text,"flags":if ephemeral{64}else{0}}))).await
    }
    async fn defer(&self,id:&str,t:&str)->Result<()> {self.callback(id,t,5,Some(json!({"flags":64}))).await}
    async fn edit_original(&self,t:&str,text:&str)->Result<()> {
        self.api(Method::PATCH,&format!("/webhooks/{}/{}/messages/@original",self.config.client_id,t),Some(json!({"content":text}))).await?;Ok(())
    }
    async fn edit_original_with_components(&self,t:&str,text:&str,components:Vec<Value>)->Result<()> {
        self.api(Method::PATCH,&format!("/webhooks/{}/{}/messages/@original",self.config.client_id,t),Some(json!({"content":text,"components":components}))).await?;Ok(())
    }
    async fn send(&self,c:&str,p:Value)->Result<Value>{self.api(Method::POST,&format!("/channels/{c}/messages"),Some(p)).await}
    async fn edit(&self,c:&str,m:&str,p:Value)->Result<Value>{self.api(Method::PATCH,&format!("/channels/{c}/messages/{m}"),Some(p)).await}
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct EmbedField { name:String, value:String, inline:bool }
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SavedEmbed {
    guild_id:String, name:String, creator_id:String, title:String, description:String,
    color:u32, author:String, footer:String, thumbnail:String, image:String,
    url:String, fields:Vec<EmbedField>, placements:Vec<PanelRef>,
}
impl Default for SavedEmbed {
    fn default()->Self{Self{guild_id:String::new(),name:String::new(),creator_id:String::new(),title:String::new(),description:String::new(),
        color:0x5865F2,author:String::new(),footer:String::new(),thumbnail:String::new(),image:String::new(),url:String::new(),fields:Vec::new(),placements:Vec::new()}}
}

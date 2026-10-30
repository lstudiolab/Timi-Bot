use anyhow::{anyhow, bail, Context as AnyhowContext, Result};
use chrono::{Duration as ChronoDuration, Utc};
use regex::Regex;
use reqwest::{Client as HttpClient, Method, StatusCode};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use serenity::{
    all::{GatewayIntents, GuildChannel, Interaction, Member, Message, Ready, User},
    async_trait,
    prelude::{Context, EventHandler},
    Client as DiscordClient,
};
use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::time::{sleep, Duration};
use tracing::{error, info, warn};

const API: &str = "https://discord.com/api/v10";
const VIEW: u64 = 1 << 10;
const SEND: u64 = 1 << 11;
const MANAGE_CHANNELS: u64 = 1 << 4;
const MANAGE_GUILD: u64 = 1 << 5;
const MANAGE_ROLES: u64 = 1 << 28;
const KICK: u64 = 1 << 1;
const BAN: u64 = 1 << 2;
const MANAGE_MESSAGES: u64 = 1 << 13;
const MODERATE: u64 = 1 << 40;
const HISTORY: u64 = 1 << 16;
const ATTACH: u64 = 1 << 15;
const EMBED: u64 = 1 << 14;
const DAY: i64 = 86_400_000;
const WEEK: i64 = 7 * DAY;
const MAX_MESSAGE_BACKUP: usize = 25_000;

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
#[derive(Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)] tickets:HashMap<String,TicketSettings>,
    #[serde(default)] moderation:HashMap<String,ModSettings>,
    #[serde(default)] verification:HashMap<String,VerifySettings>,
    #[serde(default)] members:HashMap<String,MemberRecord>,
    #[serde(default)] channels:HashMap<String,Value>,
    #[serde(default)] messages:HashMap<String,Vec<Value>>,
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
    fn save_ticket(&self,g:&str,v:TicketSettings)->Result<()> { self.store.lock().map_err(|_|anyhow!("store lock poisoned"))?.tickets.insert(g.into(),v);self.persist() }
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
        {"name":"verify-settings","description":"Configure Timi risk-based verification (server owner only).","options":[
            {"type":8,"name":"role","description":"Role granted after passing","required":false},
            {"type":8,"name":"required-role","description":"Role required before verifying","required":false},
            {"type":5,"name":"clear-required-role","description":"Remove the required-role restriction","required":false},
            {"type":4,"name":"min-age-days","description":"Minimum account age in days","min_value":0,"max_value":3650,"required":false},
            {"type":7,"name":"review-channel","description":"Channel for manual review","channel_types":[0],"required":false},
            {"type":3,"name":"title","description":"Verification panel title","max_length":200,"required":false},
            {"type":3,"name":"description","description":"Verification panel description","max_length":1000,"required":false}]},
        {"name":"verify-panel","description":"Publish the Timi risk-based verification panel.","default_member_permissions":"32"}
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
async fn command(s:&Arc<State>,id:&str,t:&str,v:Value)->Result<()>{
    let name=v.pointer("/data/name").and_then(Value::as_str).unwrap_or("");
    let g=guild_id(&v);let c=channel_id(&v);let u=user_id(&v);
    let opts=v.pointer("/data/options").cloned().unwrap_or(json!([]));
    if g.is_empty(){return s.reply(id,t,"This command can only be used in a server.",true).await;}
    match name{
        "ticket-setup"=>{
            if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission.",true).await;}
            s.defer(id,t).await?;
            match setup(s,&g,&u,t).await{Ok(())=>Ok(()),Err(e)=>{let _=s.edit_original(t,"Setup failed. Check Manage Channels permission and role hierarchy.").await;Err(e)}}
        }
        "ticket-panel"=>{
            if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to publish ticket panels.",true).await;}
            let settings=s.ticket(&g);let destination=publish_ticket(s,&g,&c,settings).await?;
            s.reply(id,t,&format!("Ticket panel published or updated in <#{destination}>."),true).await
        }
        "ticket-settings"=>{
            if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to configure tickets.",true).await;}
            let settings=s.ticket(&g);
            s.callback(id,t,4,Some(json!({"content":ticket_text(&settings),"components":ticket_components(),"flags":64}))).await
        }
        "moderation-settings"=>{
            if !manage_guild(&v){return s.reply(id,t,"You need Manage Server permission to change moderation settings.",true).await;}
            let mut settings=s.mods(&g);
            if !settings.panel_channel_id.is_empty()&&!settings.panel_message_id.is_empty(){
                if s.edit(&settings.panel_channel_id,&settings.panel_message_id,
                    json!({"content":mod_text(&settings),"components":mod_components(&settings)})).await.is_ok(){
                    return s.reply(id,t,"The existing moderation settings panel was updated.",true).await;
                }
                settings.panel_channel_id.clear();
                settings.panel_message_id.clear();
            }
            // Create one persistent panel only when no saved panel can be edited.
            s.callback(id,t,4,Some(json!({"content":mod_text(&settings),"components":mod_components(&settings)}))).await?;
            if let Ok(message)=s.api(Method::GET,&format!("/webhooks/{}/{}/messages/@original",s.config.client_id,t),None).await{
                settings.panel_channel_id=message["channel_id"].as_str().unwrap_or("").to_owned();
                settings.panel_message_id=message["id"].as_str().unwrap_or("").to_owned();
                if !settings.panel_channel_id.is_empty()&&!settings.panel_message_id.is_empty(){s.save_mods(&g,settings)?;}
            }
            Ok(())
        }
        "verify-settings"=>{
            let server=s.api(Method::GET,&format!("/guilds/{g}"),None).await?;
            if server.get("owner_id").and_then(Value::as_str)!=Some(&u){return s.reply(id,t,"Only the server owner can change verification settings.",true).await;}
            let mut x=s.verify(&g);
            let role=opt_str(&opts,"role");let required=opt_str(&opts,"required-role");let clear=opt_bool(&opts,"clear-required-role").unwrap_or(false);
            let age=opt_num(&opts,"min-age-days");let review=opt_str(&opts,"review-channel");let title=opt_str(&opts,"title");let desc=opt_str(&opts,"description");
            if role.is_none()&&required.is_none()&&!clear&&age.is_none()&&review.is_none()&&title.is_none()&&desc.is_none(){
                return s.reply(id,t,&format!("**Timi verification settings**\nVerified role: {}\nRequired role: {}\nMinimum account age: {} days\nReview channel: {}\nThresholds: 80+ pass, 60–79 manual review, below 60 kick\nWeights: age 40, history 20, attempts 20, behavior 10, avatar 10",
                    if x.role_id.is_empty(){"Not configured".into()}else{format!("<@&{}>",x.role_id)},
                    if x.required_role_id.is_empty(){"None".into()}else{format!("<@&{}>",x.required_role_id)},x.min_age_days,
                    if x.review_channel_id.is_empty(){"#timi fallback".into()}else{format!("<#{}>",x.review_channel_id)}),true).await;
            }
            if let Some(v)=role{if let Err(reason)=validate_verification_role(s,&g,&v,true).await{return s.reply(id,t,&reason,true).await;}x.role_id=v;}
            if let Some(v)=required{if let Err(reason)=validate_verification_role(s,&g,&v,false).await{return s.reply(id,t,&reason,true).await;}x.required_role_id=v;}
            if clear{x.required_role_id.clear();}
            if let Some(v)=age{x.min_age_days=v;}
            if let Some(v)=review{if !snowflake(&v){return s.reply(id,t,"Select a valid text channel.",true).await;}x.review_channel_id=v;}
            if let Some(v)=title{x.panel_title=if v.trim().is_empty(){"Verify your account".into()}else{v.trim().into()};}
            if let Some(v)=desc{x.panel_description=if v.trim().is_empty(){"Press Verify to have Timi assess your account and server history.".into()}else{v.trim().into()};}
            s.save_verify(&g,x.clone())?;
            for p in &x.published_panels{let _=s.edit(&p.channel_id,&p.message_id,verify_panel(&x)).await;}
            s.reply(id,t,"Verification settings saved. Existing panels have been refreshed.",true).await
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

async fn component(s:&Arc<State>,id:&str,t:&str,v:Value)->Result<()>{
    let custom=v.pointer("/data/custom_id").and_then(Value::as_str).unwrap_or("").to_owned();
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
async fn mod_component(s:&Arc<State>,id:&str,t:&str,v:&Value,custom:&str)->Result<()>{
    if !manage_guild(v){return s.reply(id,t,"You need Manage Server permission to edit moderation settings.",true).await;}
    let g=guild_id(v);let x=s.mods(&g);let mut next=x.clone();
    match custom{
        "modpanel:enable"|"modpanel:disable"=>{next.enabled=custom=="modpanel:enable";s.save_mods(&g,next.clone())?;return reply_update(s,id,t,&mod_text(&next),mod_components(&next)).await;}
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
        "modpanel:log-select"=>{
            let selected=v.pointer("/data/values/0").and_then(Value::as_str).unwrap_or("");
            if !snowflake(selected){return s.reply(id,t,"Select a valid text channel.",true).await;}
            next.log_channel_id=selected.to_owned();
            s.save_mods(&g,next.clone())?;
            refresh_mod_panel(s,&next).await;
            return s.callback(id,t,7,Some(json!({"content":format!("Log channel set to <#{selected}>."),"components":[]}))).await;
        }
        "modpanel:invites"=>next.block_invites=!next.block_invites,
        "modpanel:mentions"=>next.block_mass_mentions=!next.block_mass_mentions,
        "modpanel:caps"=>next.block_excessive_caps=!next.block_excessive_caps,
        _=>return Ok(())
    }
    s.save_mods(&g,next.clone())?;reply_update(s,id,t,&mod_text(&next),mod_components(&next)).await
}

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
            if let Err(e)=s.api(Method::PUT,&format!("/guilds/{g}/members/{u}/roles/{}",settings.role_id),Some(json!({"reason":format!("Timi verification passed: {points}/100")}))).await{return s.edit_original(t,&format!("Your score is {points}/100, but Timi could not assign the role: {e}")).await;}
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
    let msg=s.send(&log,json!({"embeds":[{"color":8421504,"title":"Bot approval required","description":format!("Do you agree on giving this bot permission to serve this server?\n\nBot: <@{bot}> ({name})\nAccess: This bot is temporarily restricted while approval is pending.")}],
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
async fn moderate(s:&Arc<State>,msg:&Message)->Result<()>{
    let Some(gid)=msg.guild_id else{return Ok(());};let g=gid.get().to_string();let u=msg.author.id.get().to_string();
    if msg.author.bot||is_guild_owner(s,&g,&u).await{return Ok(());}let settings=s.mods(&g);if !settings.enabled{return Ok(());}
    let Some(member)=msg.member.as_ref()else{return Ok(());};if is_mod(s,&g,&member.roles).await{return Ok(());}
    let key=format!("{g}:{}:{u}",msg.channel_id.get());let timestamp=now();let content=normalize(&msg.content);
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
            let mut channel_messages=archived.into_iter().filter(|message|message["channel_id"].as_str()==Some(deleted_id)).collect::<Vec<_>>();
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

async fn report_interaction_error(s:&State,id:&str,token:&str,error:anyhow::Error){
    error!("Interaction {id} failed: {error:#}");
    let message="Timi could not complete that action. Check the bot's permissions, role hierarchy, and logs.";
    // A deferred interaction must be edited; an unacknowledged one needs a first response.
    if s.edit_original(token,message).await.is_err(){
        let _=s.reply(id,token,message,true).await;
    }
}

struct Handler{state:Arc<State>}
#[async_trait]
impl EventHandler for Handler{
    async fn guild_create(&self,_ctx:Context,guild:serenity::all::Guild,_is_new:Option<bool>){
        let guild_id=guild.id.get().to_string();
        if let Err(e)=ensure_private(&self.state,&guild_id,"timi").await{
            warn!("Could not secure the private #timi channel after joining guild {}: {e:#}",guild.name);
        }
        match self.state.api(Method::GET,&format!("/guilds/{guild_id}/channels"),None).await{
            Ok(channels)=>{
                if let Some(items)=channels.as_array(){
                    if let Ok(mut store)=self.state.store.lock(){
                        for channel in items{
                            if let Some(id)=channel["id"].as_str(){
                                store.channels.insert(format!("{guild_id}:{id}"),channel.clone());
                            }
                        }
                    }
                    let _=self.state.persist();
                }
            }
            Err(e)=>warn!("Could not snapshot channels for new guild {}: {e:#}",guild.name)
        }
    }
    async fn ready(&self,_ctx:Context,ready:Ready){
        info!("Timi is online as {}",ready.user.name);
        if let Err(e)=register_commands(&self.state).await{error!("Slash command registration failed: {e:#}");}
        for guild in ready.guilds{
            if let Err(e)=ensure_private(&self.state,&guild.id.get().to_string(),"timi").await{
                warn!("Could not create or secure the private #timi channel in guild {}: {e:#}",guild.id);
            }
            if let Ok(channels)=self.state.api(Method::GET,&format!("/guilds/{}/channels",guild.id.get()),None).await{
                if let Some(list)=channels.as_array(){for c in list{if let Some(id)=c["id"].as_str(){self.state.store.lock().ok().map(|mut s|s.channels.insert(format!("{}:{id}",guild.id.get()),c.clone()));}}}
            }
        }
        let _=self.state.persist();
    }
    async fn interaction_create(&self,_ctx:Context,i:Interaction){
        match i{
            Interaction::Command(v)=>{
                let id=v.id.get().to_string();let token=v.token.clone();
                let value=serde_json::to_value(&v).unwrap_or(Value::Null);
                if let Err(e)=command(&self.state,&id,&token,value).await{
                    report_interaction_error(&self.state,&id,&token,e).await;
                }
            }
            Interaction::Component(v)=>{
                let id=v.id.get().to_string();let token=v.token.clone();
                let value=serde_json::to_value(&v).unwrap_or(Value::Null);
                if let Err(e)=component(&self.state,&id,&token,value).await{
                    report_interaction_error(&self.state,&id,&token,e).await;
                }
            }
            Interaction::Modal(v)=>{
                let id=v.id.get().to_string();let token=v.token.clone();
                let value=serde_json::to_value(&v).unwrap_or(Value::Null);
                if let Err(e)=modal_submit(&self.state,&id,&token,value).await{
                    report_interaction_error(&self.state,&id,&token,e).await;
                }
            }
            _=>{}
        }
    }
    async fn message(&self,_ctx:Context,msg:Message){
        if let Err(e)=backup_message(&self.state,&msg).await{error!("Message backup failed: {e:#}");}
        if let Err(e)=moderate(&self.state,&msg).await{error!("Message processing failed: {e:#}");}
    }
    async fn guild_member_addition(&self,_ctx:Context,member:Member){if let Err(e)=member_join(&self.state,&member).await{error!("Join handler failed: {e:#}");}}
    async fn guild_member_removal(&self,_ctx:Context,g:serenity::all::GuildId,u:User,_member:Option<Member>){
        if let Err(e)=self.state.update_member(&g.get().to_string(),&u.id.get().to_string(),|r|r.leaves+=1){error!("Could not record member leave: {e:#}");}
    }
    async fn channel_create(&self,_ctx:Context,c:GuildChannel){snapshot_channel(&self.state,&c).await;}
    async fn channel_update(&self,_ctx:Context,_old:Option<GuildChannel>,c:GuildChannel){snapshot_channel(&self.state,&c).await;}
    async fn channel_delete(&self,_ctx:Context,c:GuildChannel,_messages:Option<Vec<Message>>){if let Err(e)=channel_delete(&self.state,&c).await{error!("Recovery handler failed: {e:#}");}}
}

#[tokio::main]
async fn main()->Result<()>{
    tracing_subscriber::fmt().with_env_filter(env::var("RUST_LOG").unwrap_or_else(|_|"info".into())).init();
    let config=Config::load()?;let state=State::new(config.clone())?;
    let intents=GatewayIntents::GUILDS|GatewayIntents::GUILD_MEMBERS|GatewayIntents::GUILD_MESSAGES|GatewayIntents::MESSAGE_CONTENT;
    let mut client=DiscordClient::builder(&config.token,intents).event_handler(Handler{state}).await.context("Could not create Discord client")?;
    info!("Starting Timi Rust runtime.");
    client.start().await.context("Discord gateway stopped unexpectedly")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verification_thresholds_match_policy() {
        let thresholds=Limits{pass:80,review:60};
        assert_eq!(verification_decision(100,false,&thresholds),"pass");
        assert_eq!(verification_decision(80,false,&thresholds),"pass");
        assert_eq!(verification_decision(79,false,&thresholds),"review");
        assert_eq!(verification_decision(60,false,&thresholds),"review");
        assert_eq!(verification_decision(59,false,&thresholds),"kick");
        assert_eq!(verification_decision(0,true,&thresholds),"review");
        assert_eq!(verification_decision(100,true,&thresholds),"review");
    }

    #[test]
    fn duplicate_similarity_uses_jaccard_similarity() {
        assert!((similarity("one two three","one two three")-1.0).abs()<f64::EPSILON);
        assert!((similarity("one two","one three")-(1.0/3.0)).abs()<f64::EPSILON);
        assert_eq!(similarity("one two","three four"),0.0);
        assert_eq!(similarity("","one"),0.0);
    }

    #[test]
    fn message_normalization_removes_case_punctuation_and_ids() {
        assert_eq!(normalize("HELLO, World! https://example.com <@12345678901234567>"),"hello world url mention");
    }

    #[test]
    fn message_normalization_removes_unicode_punctuation_and_symbols() {
        assert_eq!(normalize("Hello, WORLD!!! ＋ café — test."), "hello world café test");
    }

    #[test]
    fn snowflake_validation_rejects_non_discord_ids() {
        assert!(snowflake("12345678901234567"));
        assert!(!snowflake("1234"));
        assert!(!snowflake("1234567890123456x"));
    }
    #[test]
    fn legacy_nullable_settings_are_imported_safely() {
        let settings: ModSettings = serde_json::from_value(json!({
            "enabled": false,
            "logChannelId": null,
            "panelChannelId": null,
            "panelMessageId": null
        })).expect("legacy nullable moderation fields should deserialize");
        assert!(!settings.enabled);
        assert!(settings.log_channel_id.is_empty());
        assert!(settings.panel_channel_id.is_empty());
        assert!(settings.panel_message_id.is_empty());
    }

}

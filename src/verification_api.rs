//! Verification API session/job domain model (transport-independent Rust port).
use std::collections::HashMap;
use serde::{Deserialize,Serialize};

pub const CODE_TTL_MS:u64=600_000;
pub const SESSION_TTL_MS:u64=1_800_000;
pub const MAX_ATTEMPTS:u8=5;
pub const MAX_BODY_BYTES:usize=8192;

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Session {
    pub user_id:String, pub guild_id:String, pub created_at:u64, pub expires_at:u64,
    pub attempts:u8, pub used:bool, pub status:String,
}
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct JobResult { pub ok:bool, pub message:String, #[serde(default)] pub role_name:String }
#[derive(Debug,Clone,Serialize,Deserialize)]
pub struct Job { pub id:String, pub token:String, pub user_id:String, pub guild_id:String, pub status:String, pub result:Option<JobResult> }
#[derive(Default)]
pub struct SessionStore { pub sessions:HashMap<String,Session>, pub jobs:HashMap<String,Job> }
impl SessionStore {
    pub fn create_session(&mut self,token:String,user_id:String,guild_id:String,now:u64)->Result<(), &'static str> {
        if !valid_discord_id(&user_id)||!valid_discord_id(&guild_id){return Err("Invalid Discord identifiers.");}
        self.sessions.insert(token,Session{user_id,guild_id,created_at:now,expires_at:now+SESSION_TTL_MS,attempts:0,used:false,status:"awaiting_email".into()});
        Ok(())
    }
    pub fn get_valid(&self,token:&str,now:u64)->Option<&Session> {
        if !valid_token(token){return None;}
        self.sessions.get(token).filter(|s|s.expires_at>=now&&!s.used)
    }
    pub fn consume(&mut self,token:&str,now:u64)->bool {
        if let Some(session)=self.sessions.get_mut(token){if session.expires_at>=now&&!session.used{session.used=true;return true;}}
        false
    }
    pub fn prune(&mut self,now:u64) {
        self.sessions.retain(|_,s|s.expires_at>=now&&!s.used);
        self.jobs.retain(|_,j|j.status=="pending"||j.status=="processing");
    }
}
pub fn valid_token(token:&str)->bool { token.len()==64&&token.bytes().all(|b|b.is_ascii_hexdigit()) }
pub fn valid_discord_id(id:&str)->bool { (15..=22).contains(&id.len())&&id.bytes().all(|b|b.is_ascii_digit()) }
pub fn constant_time_eq(a:&[u8],b:&[u8])->bool {
    if a.len()!=b.len(){return false;}
    a.iter().zip(b).fold(0u8,|acc,(x,y)|acc|(x^y))==0
}

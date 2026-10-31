async fn report_interaction_error(s:&State,id:&str,_token:&str,error:anyhow::Error){
    // Interaction handlers own their user-facing responses. A global fallback
    // reply can create a second initial response or overwrite a useful message
    // after a handler has already acknowledged Discord and continued its work.
    // Keep the detailed failure in logs; never inject a generic message.
    error!("Interaction {id} failed: {error:#}");
    let acknowledged=s.take_callback_acknowledged(id);
    let attempted=s.take_callback_attempt(id);
    if acknowledged || attempted {
        tracing::debug!("Interaction {id} failed after its response was attempted; preserving the handler's response.");
    }
    s.clear_callback_attempt(id);
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
                match command(&self.state,&id,&token,value).await {
                    Ok(())=>self.state.clear_callback_attempt(&id),
                    Err(e)=>report_interaction_error(&self.state,&id,&token,e).await,
                }
            }
            Interaction::Component(v)=>{
                let id=v.id.get().to_string();let token=v.token.clone();
                let value=serde_json::to_value(&v).unwrap_or(Value::Null);
                match component(&self.state,&id,&token,value).await {
                    Ok(())=>self.state.clear_callback_attempt(&id),
                    Err(e)=>report_interaction_error(&self.state,&id,&token,e).await,
                }
            }
            Interaction::Modal(v)=>{
                let id=v.id.get().to_string();let token=v.token.clone();
                let value=serde_json::to_value(&v).unwrap_or(Value::Null);
                match modal_submit(&self.state,&id,&token,value).await {
                    Ok(())=>self.state.clear_callback_attempt(&id),
                    Err(e)=>report_interaction_error(&self.state,&id,&token,e).await,
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

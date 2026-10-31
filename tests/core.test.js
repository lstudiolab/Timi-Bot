import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSnowflake, normalizeMessage, jaccard, cleanChannelName, snowflakeTime } from "../src/utils.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

const quiet={debug(){},info(){},warn(){},error(){}};

test("Snowflake validation accepts Discord IDs only",()=>{
  assert.equal(isSnowflake("123456789012345678"),true);
  assert.equal(isSnowflake("not-an-id"),false);
  assert.equal(isSnowflake("123"),false);
});
test("message normalization removes invite and mention formatting",()=>{
  assert.equal(normalizeMessage("HELLO!!! https://example.com <@123456789012345678>"),"hello url mention");
});
test("Jaccard similarity handles repeated and unrelated messages",()=>{
  assert.equal(jaccard("same same","same"),1);
  assert.equal(jaccard("one two","three four"),0);
});
test("channel names are normalized and bounded",()=>{
  assert.equal(cleanChannelName("Hello World!!"),"hello-world");
  assert.ok(cleanChannelName("a".repeat(150)).length<=90);
});
test("Snowflake timestamps are positive",()=>{
  assert.ok(snowflakeTime("123456789012345678")>0);
});
test(".env loader reads credentials and creates its data directory",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"timi-config-"));
  const keys=["DISCORD_TOKEN","CLIENT_ID","GUILD_ID","DATA_DIR","LOG_LEVEL"];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
    for(const key of keys)delete process.env[key];
    fs.writeFileSync(path.join(dir,".env"),"DISCORD_TOKEN=test-token\r\nCLIENT_ID=123456789012345678\r\nGUILD_ID=\r\nDATA_DIR=state\r\n");
    const config=loadConfig(dir);
    assert.equal(config.token,"test-token");
    assert.equal(config.clientId,"123456789012345678");
    assert.equal(config.guildId,null);
    assert.equal(config.dataDir,path.join(dir,"state"));
    assert.ok(fs.existsSync(config.dataDir));
  }finally{
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
test("persistent store saves defaults and reloads settings",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"timi-store-"));
  try{
    const store=new Store(dir,quiet),settings=store.ticket("123456789012345678");
    settings.panel_title="Help Desk";store.save();
    const reloaded=new Store(dir,quiet);
    assert.equal(reloaded.ticket("123456789012345678").panel_title,"Help Desk");
    assert.ok(fs.existsSync(path.join(dir,"timi.json")));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("pending moderation jobs survive a bot restart",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"timi-moderation-jobs-"));
  try{
    const store=new Store(dir,quiet);
    store.data.moderation_jobs["guild-a"]=[{
      id:"automod:guild-a:message-a",type:"automod-sanction",status:"pending",
      guild_id:"guild-a",user_id:"user-a",channel_id:"channel-a",message_ids:["message-a"],
      reason:"message burst",steps:{deleted:true,sanction:false,logged:false},attempts:1
    }];
    store.save();
    const restarted=new Store(dir,quiet);
    const [job]=restarted.data.moderation_jobs["guild-a"];
    assert.equal(job.status,"pending");
    assert.equal(job.steps.deleted,true);
    assert.equal(job.steps.sanction,false);
    assert.equal(job.id,"automod:guild-a:message-a");
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test("legacy configuration files are imported without overwriting new data",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"timi-legacy-"));
  try{
    fs.writeFileSync(path.join(dir,"ticket-settings.json"),JSON.stringify({"123456789012345678":{panelTitle:"Legacy Support"}}));
    const store=new Store(dir,quiet);
    assert.equal(store.ticket("123456789012345678").panel_title,"Legacy Support");
    const reloaded=new Store(dir,quiet);
    assert.equal(reloaded.ticket("123456789012345678").panel_title,"Legacy Support");
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

import { LibraryManager } from "../src/module-manager.js";
import { LIBRARIES, normalizeLibraryName } from "../src/libraries/index.js";

test("Timi exposes three concrete first-party libraries",()=>{
  assert.deepEqual(Object.keys(LIBRARIES),["Moderation","Support","Foundation"]);
  for(const library of Object.values(LIBRARIES)){
    assert.equal(typeof library.create,"function");
    assert.ok(library.systems.length>0);
    assert.ok(library.description.length>20);
  }
  assert.equal(normalizeLibraryName(" moderation "),"Moderation");
  assert.equal(normalizeLibraryName("Support"),"Support");
  assert.equal(normalizeLibraryName("Unknown"),null);
});
test("library installation is isolated per server and preserves data",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"timi-libraries-"));
  try{
    const store=new Store(dir,quiet),manager=new LibraryManager(store,quiet);
    store.ticket("guild-a").panel_title="Saved support";store.save();
    assert.equal(manager.install("guild-a","Support").ok,true);
    assert.equal(manager.installed("guild-a","Support"),true);
    assert.equal(manager.installed("guild-b","Support"),false);
    assert.equal(manager.install("guild-a","Support").ok,false);
    assert.equal(manager.uninstall("guild-a","Support").ok,true);
    assert.equal(manager.installed("guild-a","Support"),false);
    assert.equal(new Store(dir,quiet).ticket("guild-a").panel_title,"Saved support");
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

import { commandData } from "../src/commands.js";
test("library management commands are registered with the intended option behavior",()=>{
  const install=commandData.find(command=>command.name==="install-library");
  const uninstall=commandData.find(command=>command.name==="uninstall-library");
  const list=commandData.find(command=>command.name==="library-list");
  assert.ok(install&&uninstall&&list);
  assert.equal(install.options[0].name,"libraryname");
  assert.equal(install.options[0].required,false);
  assert.equal(uninstall.options[0].required,true);
  assert.ok(commandData.some(command=>command.name==="automod-word"));
});


test("pending moderation jobs survive a process restart",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"timi-moderation-jobs-"));
  try{
    const first=new Store(dir,quiet);
    first.data.moderation_jobs["guild-a"]=[{
      id:"automod:guild-a:message-a",type:"automod-sanction",status:"pending",
      guild_id:"guild-a",user_id:"user-a",channel_id:"channel-a",message_ids:["message-a"],
      reason:"message burst",warning_id:1,action:"timeout",timeout_minutes:10,
      action_duration_seconds:3,steps:{deleted:false,sanction:false,logged:false},attempts:0
    }];
    first.save();
    const restarted=new Store(dir,quiet);
    const [job]=restarted.data.moderation_jobs["guild-a"];
    assert.equal(job.status,"pending");
    assert.equal(job.user_id,"user-a");
    assert.deepEqual(job.steps,{deleted:false,sanction:false,logged:false});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

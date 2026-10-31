import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots=["src","tests","scripts"];
const files=[];
function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())walk(full);
    else if(entry.isFile()&&full.endsWith(".js"))files.push(full);
  }
}
for(const root of roots)if(fs.existsSync(root))walk(root);
files.push("package.json");
let failed=false;
for(const file of files){
  if(file.endsWith("package.json")){JSON.parse(fs.readFileSync(file,"utf8"));continue;}
  const result=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
  if(result.status!==0){failed=true;console.error(result.stderr||result.stdout);}
}
if(failed)process.exit(1);
console.log(`Syntax check passed for ${files.length-1} JavaScript files.`);

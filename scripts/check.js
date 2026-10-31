import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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
for(const file of files){
  const result=spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
  if(result.status!==0){console.error(result.stderr||result.stdout);process.exit(1);}
}
JSON.parse(fs.readFileSync("package.json","utf8"));

const importable=files.filter(file=>file.startsWith("src/")&&!["src/index.js","src/deploy-commands.js"].includes(file));
for(const file of importable)await import(pathToFileURL(path.resolve(file)).href);
console.log(`Syntax and import checks passed for ${files.length} JavaScript files; ${importable.length} application modules loaded.`);

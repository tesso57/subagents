import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createChildSession} from '../extensions/src/child.ts';

for(const stubborn of [false,true]) test(`closes a ${stubborn?'SIGTERM-resistant':'normal'} built-in MCP server when shutdown hangs`, {timeout:10000,skip:process.platform==='win32'}, async () => {
 const root=mkdtempSync(join(tmpdir(),'mcp-shutdown-timeout-')),agentDir=mkdtempSync(join(tmpdir(),'mcp-shutdown-timeout-cfg-'));const server=join(root,'server.cjs'),pidFile=join(root,'pid');
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','extensions','hang.js'),"export default pi=>pi.on('session_shutdown',()=>new Promise(()=>{}));");
 writeFileSync(server,`${stubborn?"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);":''}const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'hello',description:'hello',inputSchema:{type:'object',properties:{}}}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
 writeFileSync(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{test:{command:process.execPath,args:[server],exposure:'direct'}}}));const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;let pid=0;
 try {
  const child=await createChildSession({cwd:root,agentDir,prompt:'test',tools:['mcp__test__hello'],requiredTools:['mcp__test__hello'],shutdownTimeoutMs:stubborn?5000:200,ask:async()=>''});
  assert.ok(existsSync(pidFile));pid=Number(readFileSync(pidFile,'utf8'));
  await assert.rejects(child.dispose(),/shutdown timed out/);
  if(stubborn) assert.throws(()=>process.kill(pid,0),/ESRCH/,'MCP server still alive after bounded shutdown and cleanup');
  const deadline=Date.now()+2000;let alive=true;while(alive && Date.now()<deadline){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,20));}catch{alive=false;}}
  assert.equal(alive,false,'MCP server remained alive after child disposal');
 } finally {if(pid)try{process.kill(pid,'SIGKILL');}catch{}if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createChildSession} from '../extensions/src/child.ts';

test('allows an earlier shutdown handler to use MCP until the normal deadline', {timeout:10000,skip:process.platform==='win32'}, async () => {
 const root=mkdtempSync(join(tmpdir(),'mcp-shutdown-order-')),agentDir=mkdtempSync(join(tmpdir(),'mcp-shutdown-order-cfg-')),server=join(root,'server.cjs'),pidFile=join(root,'pid');mkdirSync(join(root,'.pi','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','extensions','slow.js'),`import {readFileSync} from 'node:fs';export default pi=>pi.on('session_shutdown',async()=>{await new Promise(r=>setTimeout(r,300));try {process.kill(Number(readFileSync(${JSON.stringify(pidFile)},'utf8')),0);}catch {throw new Error('MCP_STOPPED_DURING_CLEANUP');}});`);
 writeFileSync(server,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'hello',description:'hello',inputSchema:{type:'object',properties:{}}}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
 writeFileSync(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{test:{command:process.execPath,args:[server],exposure:'direct'}}}));const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 try {const child=await createChildSession({cwd:root,agentDir,prompt:'test',tools:['mcp__test__hello'],requiredTools:['mcp__test__hello'],shutdownTimeoutMs:2000,ask:async()=>''});await child.dispose();}
 finally {if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

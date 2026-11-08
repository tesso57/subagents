import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createChildSession} from '../src/child.ts';

test('loads project instructions and the agent prompt into a separate session', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-session-'));
 const agentDir=mkdtempSync(join(tmpdir(),'child-config-'));
 writeFileSync(join(root,'AGENTS.md'),'Project instruction sentinel');
 const child=await createChildSession({cwd:root,agentDir,prompt:'Child instruction sentinel',ask:async()=> 'ok'});
 try {
  assert.match(child.session.systemPrompt,/Project instruction sentinel/);
  assert.match(child.session.systemPrompt,/Child instruction sentinel/);
  assert.equal(child.session.messages.length,0);
 } finally { await child.dispose(); }
});

test('child can consult parent and continue after the reply', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const root=mkdtempSync(join(tmpdir(),'child-dialog-')), agentDir=mkdtempSync(join(tmpdir(),'child-dialog-cfg-'));
 const model={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000} as any;
 const child=await createChildSession({cwd:root,agentDir,prompt:'ask parent',model,ask:async message=>{assert.equal(message,'Need choice');return 'Use A';}});
 child.session.modelRuntime.hasConfiguredAuth = () => true;
 let calls=0;
 child.session.agent.streamFunction=(() => {
  const stream=createAssistantMessageEventStream(); const isFirst=calls++===0;
  const message:any={role:'assistant',content:isFirst?[{type:'toolCall',id:'q1',name:'contact_parent',arguments:{message:'Need choice'}}]:[{type:'text',text:'Done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:isFirst?'toolUse':'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});
  return stream;
 }) as any;
 try {await child.session.prompt('Begin');assert.equal(child.session.getLastAssistantText(),'Done');assert.ok(child.session.messages.some((m:any)=>m.role==='toolResult' && JSON.stringify(m).includes('Use A')));} finally {await child.dispose();}
});

test('child loads repository skills and extensions', async () => {
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-resource-')), agentDir=mkdtempSync(join(tmpdir(),'child-cfg-'));
 mkdirSync(join(root,'.pi','skills','sample'),{recursive:true});
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','skills','sample','SKILL.md'),'---\nname: sample\ndescription: A sample skill for testing\n---\nUse sentinel skill.\n');
 writeFileSync(join(root,'.pi','extensions','sample.js'),`export default function(pi) { pi.registerTool({name:'sample_extension_tool',label:'Sample',description:'sample tool',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}]})}); }`);
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',ask:async()=>''});
 try {assert.match(child.session.systemPrompt,/sample/);assert.ok(child.session.getActiveToolNames().includes('sample_extension_tool'));} finally {await child.dispose();}
});

test('child shutdown is bounded when an extension hangs', async () => {
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-hang-')), agentDir=mkdtempSync(join(tmpdir(),'child-hang-cfg-'));
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','extensions','hang.js'),`export default function(pi){pi.on('session_shutdown',()=>new Promise(()=>{}));}`);
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',ask:async()=>'',shutdownTimeoutMs:30});
 await assert.rejects(child.dispose(),/timed out/);
});

test('fails closed if an active parent tool cannot be inherited', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-missing-')), agentDir=mkdtempSync(join(tmpdir(),'child-missing-cfg-'));
 await assert.rejects(createChildSession({cwd:root,agentDir,prompt:'test',ask:async()=>'',requiredTools:['not_available']}),/could not inherit.*not_available/);
});

test('explicit codemode is loaded for a child tool allowlist', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-code-')), agentDir=mkdtempSync(join(tmpdir(),'child-code-cfg-'));
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',tools:['codemode'],ask:async()=>''});
 try {assert.ok(child.session.getActiveToolNames().includes('codemode'));} finally {await child.dispose();}
});

test('waits for an asynchronously connected MCP tool', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-mcp-')), agentDir=mkdtempSync(join(tmpdir(),'child-mcp-cfg-'));
 const server=join(root,'server.cjs');
 writeFileSync(server,`const rl=require('node:readline').createInterface({input:process.stdin});\nrl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}};if(m.method==='tools/list'){require('node:fs').writeFileSync('mcp-marker','connected');result={tools:[{name:'hello',description:'say hello',inputSchema:{type:'object',properties:{}}}]};}setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})),75);});`);
 writeFileSync(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{test:{command:process.execPath,args:[server],exposure:'direct'}}}));
 const previous=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=agentDir;
 try {
  const child=await createChildSession({cwd:root,agentDir,prompt:'test',tools:['mcp__test__hello'],ask:async()=>''});
  try {assert.ok(child.session.getActiveToolNames().includes('mcp__test__hello'));} finally {await child.dispose();}
  const {unlinkSync,existsSync}=await import('node:fs');unlinkSync(join(root,'mcp-marker'));
  writeFileSync(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{test:{command:process.execPath,args:[server],exposure:'codemode'}}}));
  const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
  const viaCode=await createChildSession({cwd:root,agentDir,prompt:'test',model,tools:['codemode'],ask:async()=>''});
  try {
   const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
   viaCode.session.modelRuntime.hasConfiguredAuth=()=>true; let calls=0;
   viaCode.session.agent.streamFunction=(()=>{const stream=createAssistantMessageEventStream(),first=calls++===0;const message:any={role:'assistant',content:first?[{type:'toolCall',id:'code1',name:'codemode',arguments:{code:`text(await searchTools('hello'));`}}]:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;}) as any;
   await viaCode.session.prompt('Find MCP tool');
   assert.ok(existsSync(join(root,'mcp-marker')),'codemode MCP server was not connected');
   assert.ok(viaCode.session.messages.some((m:any)=>m.role==='toolResult' && JSON.stringify(m).includes('mcp__test__hello')),'codemode did not discover MCP tool');
  } finally {await viaCode.dispose();}
 } finally { if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous; }
});

test('aborting a child cancels its running bash command', {timeout:8000}, async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {existsSync,readFileSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-abort-')), agentDir=mkdtempSync(join(tmpdir(),'child-abort-cfg-'));
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',model,tools:['bash'],ask:async()=>''});
 child.session.modelRuntime.hasConfiguredAuth=()=>true;let calls=0;
 child.session.agent.streamFunction=(()=>{
  const stream=createAssistantMessageEventStream(), first=calls++===0;
  const message:any={role:'assistant',content:first?[{type:'toolCall',id:'bash1',name:'bash',arguments:{command:'echo $$ > pid; exec sleep 4'}}]:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;
 }) as any;
 const run=child.session.prompt('start'); let pid=0;
 try {
  for(let i=0;i<100 && !existsSync(join(root,'pid'));i++) await new Promise(r=>setTimeout(r,20));
  assert.ok(existsSync(join(root,'pid')),'bash process did not start');pid=Number(readFileSync(join(root,'pid'),'utf8'));
  const stopped=await Promise.race([child.session.abort().then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),1500))]);
  if(!stopped) {try {process.kill(pid,'SIGKILL');} catch {}}
  await run.catch(()=>{});assert.ok(stopped,'session abort timed out');
  assert.throws(()=>process.kill(pid,0),/ESRCH/);
 } finally {await child.dispose();}
});

test('inherits explicit hook-only extensions into child sessions', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-hook-')), agentDir=mkdtempSync(join(tmpdir(),'child-hook-cfg-'));
 const guard=join(root,'guard.js');
 writeFileSync(guard,`export default function(pi){pi.on('tool_call', event => event.toolName==='bash' ? {block:true,reason:'blocked by parent guard'} : undefined);}`);
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',extraExtensions:[guard],ask:async()=>''});
 try {const result=await child.session.extensionRunner.emitToolCall({type:'tool_call',toolCallId:'x',toolName:'bash',input:{command:'echo unsafe'}});assert.equal(result?.block,true);} finally {await child.dispose();}
});

test('honors disabled extension and skill discovery in the child', async () => {
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-disable-')), agentDir=mkdtempSync(join(tmpdir(),'child-disable-cfg-'));
 mkdirSync(join(root,'.pi','skills','special'),{recursive:true});mkdirSync(join(root,'.pi','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','skills','special','SKILL.md'),'---\nname: special\ndescription: unique-discovery-sentinel\n---\nbody');
 writeFileSync(join(root,'.pi','extensions','guard.js'),"export default function(pi){pi.on('tool_call',()=>({block:true,reason:'guard'}));}");
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',noExtensions:true,noSkills:true,ask:async()=>''});
 try {assert.doesNotMatch(child.session.systemPrompt,/unique-discovery-sentinel/);assert.equal(child.session.extensionRunner.hasHandlers('tool_call'),false);} finally {await child.dispose();}
});

test('does not auto-connect MCP when parent disabled extensions', async () => {
 const {existsSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-mcp-disabled-')),agentDir=mkdtempSync(join(tmpdir(),'child-mcp-disabled-cfg-'));
 const server=join(root,'server.cjs');writeFileSync(server,"require('fs').writeFileSync('mcp-marker','started'); setInterval(()=>{},1000)");
 writeFileSync(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{test:{command:process.execPath,args:[server]}}}));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 try {const child=await createChildSession({cwd:root,agentDir,prompt:'test',tools:['codemode'],noExtensions:true,ask:async()=>''});try {await new Promise(r=>setTimeout(r,250));assert.equal(existsSync(join(root,'mcp-marker')),false);} finally {await child.dispose();}}
 finally {if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('noSkills suppresses skills provided by extensions', async () => {
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-no-skill-')),agentDir=mkdtempSync(join(tmpdir(),'child-no-skill-cfg-'));
 const skill=join(root,'provided');mkdirSync(skill,{recursive:true});
 writeFileSync(join(skill,'SKILL.md'),'---\nname: provided\ndescription: extension-provided-sentinel\n---\nbody');
 const ext=join(root,'provider.js');writeFileSync(ext,`export default function(pi){pi.on('resources_discover',()=>({skillPaths:[${JSON.stringify(skill)}]}));}`);
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',noSkills:true,extraExtensions:[ext],ask:async()=>''});
 try {assert.doesNotMatch(child.session.systemPrompt,/extension-provided-sentinel/);} finally {await child.dispose();}
});

test('child without its own allowlist inherits only active parent tools', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-parent-tools-')),agentDir=mkdtempSync(join(tmpdir(),'child-parent-tools-cfg-'));
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',requiredTools:['read'],ask:async()=>''});
 try {assert.deepEqual(child.session.getActiveToolNames().sort(),['contact_parent','read']);} finally {await child.dispose();}
});

test('an agent allowlist cannot widen the parent tool ceiling', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-ceiling-')),agentDir=mkdtempSync(join(tmpdir(),'child-ceiling-cfg-'));
 await assert.rejects(createChildSession({cwd:root,agentDir,prompt:'test',tools:['bash'],requiredTools:['read'],ask:async()=>''}),/outside parent/);
});

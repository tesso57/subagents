import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createChildSession} from '../extensions/src/child.ts';

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
 child.session.getLastAssistantText=()=> 'Completed investigation';
 await assert.rejects(child.dispose(),(error:any)=>{assert.match(error.message,/timed out/);assert.equal(error.partial,'Completed investigation');return true;});
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

test('noSkills retains skills provided by explicit extensions like Pi', async () => {
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-no-skill-')),agentDir=mkdtempSync(join(tmpdir(),'child-no-skill-cfg-'));
 const skill=join(root,'provided');mkdirSync(skill,{recursive:true});
 writeFileSync(join(skill,'SKILL.md'),'---\nname: provided\ndescription: extension-provided-sentinel\n---\nbody');
 const ext=join(root,'provider.js');writeFileSync(ext,`export default function(pi){pi.on('resources_discover',()=>({skillPaths:[${JSON.stringify(skill)}]}));}`);
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',noSkills:true,extraExtensions:[ext],ask:async()=>''});
 try {assert.match(child.session.systemPrompt,/extension-provided-sentinel/);} finally {await child.dispose();}
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

test('honors disabled context file discovery in the child', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-no-context-')),agentDir=mkdtempSync(join(tmpdir(),'child-no-context-cfg-'));
 writeFileSync(join(root,'AGENTS.md'),'Disabled context sentinel');
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',noContextFiles:true,ask:async()=>''});
 try {assert.doesNotMatch(child.session.systemPrompt,/Disabled context sentinel/);} finally {await child.dispose();}
});

test('preserves the configured append-system prompt alongside the agent instructions', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-append-')),agentDir=mkdtempSync(join(tmpdir(),'child-append-cfg-'));
 writeFileSync(join(agentDir,'APPEND_SYSTEM.md'),'Shared append sentinel');
 const child=await createChildSession({cwd:root,agentDir,prompt:'Agent-specific sentinel',ask:async()=>''});
 try {assert.match(child.session.systemPrompt,/Shared append sentinel/);assert.match(child.session.systemPrompt,/Agent-specific sentinel/);} finally {await child.dispose();}
});

test('inherits explicit CLI system and append prompts before agent instructions', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-cli-prompt-')),agentDir=mkdtempSync(join(tmpdir(),'child-cli-prompt-cfg-'));
 writeFileSync(join(agentDir,'APPEND_SYSTEM.md'),'Should be overridden');
 const child=await createChildSession({cwd:root,agentDir,prompt:'Agent sentinel',parentSystemPrompt:'Parent base sentinel',parentAppendSystemPrompts:['Parent append sentinel'],ask:async()=>''});
 try {assert.match(child.session.systemPrompt,/Parent base sentinel/);assert.match(child.session.systemPrompt,/Parent append sentinel/);assert.match(child.session.systemPrompt,/Agent sentinel/);assert.doesNotMatch(child.session.systemPrompt,/Should be overridden/);} finally {await child.dispose();}
});

test('untrusted child does not load project extensions or skills', async () => {
 const {mkdirSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'child-untrusted-')),agentDir=mkdtempSync(join(tmpdir(),'child-untrusted-cfg-'));
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});mkdirSync(join(root,'.pi','skills','unsafe'),{recursive:true});
 writeFileSync(join(root,'.pi','extensions','unsafe.js'),"export default function(pi){pi.on('tool_call',()=>({block:true,reason:'unsafe'}));}");
 writeFileSync(join(root,'.pi','skills','unsafe','SKILL.md'),'---\nname: unsafe\ndescription: untrusted-skill-sentinel\n---\nbody');
 writeFileSync(join(root,'AGENTS.md'),'context-still-loaded-sentinel');
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',projectTrusted:false,ask:async()=>''});
 try {assert.equal(child.session.extensionRunner.hasHandlers('tool_call'),false);assert.doesNotMatch(child.session.systemPrompt,/untrusted-skill-sentinel/);assert.match(child.session.systemPrompt,/context-still-loaded-sentinel/);} finally {await child.dispose();}
});

test('child uses captured discovered prompts when their files change', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-discovered-')),agentDir=mkdtempSync(join(tmpdir(),'child-discovered-cfg-'));
 writeFileSync(join(agentDir,'SYSTEM.md'),'Parent original system');writeFileSync(join(agentDir,'APPEND_SYSTEM.md'),'Parent original append');
 const options={cwd:root,agentDir,prompt:'Agent instructions',parentSystemPrompt:'Parent original system',parentAppendSystemPrompts:['Parent original append'],ask:async()=>''};
 writeFileSync(join(agentDir,'SYSTEM.md'),'Changed system');writeFileSync(join(agentDir,'APPEND_SYSTEM.md'),'Changed append');
 const child=await createChildSession(options);
 try {assert.match(child.session.systemPrompt,/Parent original system/);assert.match(child.session.systemPrompt,/Parent original append/);assert.doesNotMatch(child.session.systemPrompt,/Changed system|Changed append/);} finally {await child.dispose();}
});

test('uses parent context snapshot when project instructions change', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-context-snapshot-')),agentDir=mkdtempSync(join(tmpdir(),'child-context-snapshot-cfg-'));
 const path=join(root,'AGENTS.md');writeFileSync(path,'Changed context');
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',parentContextFiles:[{path,content:'Original context'}],ask:async()=>''});
 try {assert.match(child.session.systemPrompt,/Original context/);assert.doesNotMatch(child.session.systemPrompt,/Changed context/);} finally {await child.dispose();}
});

test('does not auto-connect MCP when parent disabled MCP', async () => {
 const {existsSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-mcp-off-')),agentDir=mkdtempSync(join(tmpdir(),'child-mcp-off-cfg-'));
 const server=join(root,'server.cjs');writeFileSync(server,"require('fs').writeFileSync('mcp-marker','started'); setInterval(()=>{},1000)");
 writeFileSync(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{test:{command:process.execPath,args:[server]}}}));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 try {const child=await createChildSession({cwd:root,agentDir,prompt:'test',tools:['codemode'],noMcp:true,ask:async()=>''});try {await new Promise(r=>setTimeout(r,250));assert.equal(existsSync(join(root,'mcp-marker')),false);} finally {await child.dispose();}}
 finally {if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('noSkills retains explicitly selected skills like the Pi CLI', async () => {
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-explicit-skill-')),agentDir=mkdtempSync(join(tmpdir(),'child-explicit-skill-cfg-')),skill=join(root,'my-skill');
 mkdirSync(skill);writeFileSync(join(skill,'SKILL.md'),'---\nname: my-skill\ndescription: explicit-skill-sentinel\n---\nbody');
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',noSkills:true,extraSkills:[skill],ask:async()=>''});
 try {assert.match(child.session.systemPrompt,/explicit-skill-sentinel/);} finally {await child.dispose();}
});

test('uses the inherited runtime API key for the matching child provider', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-runtime-auth-')),agentDir=mkdtempSync(join(tmpdir(),'child-runtime-auth-cfg-'));
 const model:any={id:'fake',name:'fake',provider:'fake-runtime-auth',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const providerConfig:any={api:'openai-completions',baseUrl:model.baseUrl,models:[model]};
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',model,providerConfig,runtimeApiKey:'placeholder-test-key',ask:async()=>''});
 try {assert.equal(child.session.modelRuntime.hasConfiguredAuth(model.provider),true);} finally {await child.dispose();}
});

test('child does not load the globally installed subagent extension recursively', async () => {
 const {resolve}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'child-no-recursion-')),agentDir=mkdtempSync(join(tmpdir(),'child-no-recursion-cfg-'));
 writeFileSync(join(agentDir,'settings.json'),JSON.stringify({packages:[resolve('.')]}));
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',requiredTools:['read'],ask:async()=>''});
 try {
  const tools=child.session.getActiveToolNames();
  assert.ok(tools.includes('contact_parent'));
  assert.ok(!tools.some(name=>name.startsWith('subagent_')),JSON.stringify(tools));
  assert.ok(!child.session.resourceLoader.getExtensions().extensions.some(item=>item.resolvedPath===resolve('extensions/index.ts')));
 } finally {await child.dispose();}
});

test('does not start child extensions after cancellation during loading', async () => {
 const {mkdirSync,existsSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'child-abort-loading-')),agentDir=mkdtempSync(join(tmpdir(),'child-abort-loading-cfg-'));
 const marker=join(root,'started'),factoryStarted=join(root,'factory-started'),release=join(root,'release');mkdirSync(join(root,'.pi','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','extensions','slow.js'),`import {writeFileSync,existsSync} from 'node:fs'; export default async function(pi) { writeFileSync(${JSON.stringify(factoryStarted)},'started'); while (!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,5)); pi.on('session_start',()=>writeFileSync(${JSON.stringify(marker)},'started')); }`);
 const controller=new AbortController();const pending=createChildSession({cwd:root,agentDir,prompt:'test',signal:controller.signal,ask:async()=>''});
 const deadline=Date.now()+5000;
 try {while (!existsSync(factoryStarted) && Date.now()<deadline) await new Promise(r=>setTimeout(r,5)); assert.ok(existsSync(factoryStarted),'extension factory did not start');controller.abort();}
 finally {writeFileSync(release,'release');}
 await assert.rejects(pending,/aborted/i);
 assert.equal(existsSync(marker),false);
});

test('inherits MCP resource tools without requiring direct MCP tool names', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-mcp-resources-')),agentDir=mkdtempSync(join(tmpdir(),'child-mcp-resources-cfg-'));const server=join(root,'server.cjs');
 writeFileSync(server,`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{resources:{}},serverInfo:{name:'test',version:'1'}};if(m.method==='resources/list')result={resources:[]};if(m.method==='resources/templates/list')result={resourceTemplates:[]};setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result})),50);});`);
 writeFileSync(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{test:{command:process.execPath,args:[server],exposure:'direct'}}}));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'];
 try {for(const specified of [tools,undefined]) {const child=await createChildSession({cwd:root,agentDir,prompt:'test',tools:specified,requiredTools:tools,ask:async()=>''});try {for(const name of tools) assert.ok(child.session.getActiveToolNames().includes(name),name);} finally {await child.dispose();}}}
 finally {if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('loads explicitly selected Pi built-in extensions in children', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-explicit-builtins-')),agentDir=mkdtempSync(join(tmpdir(),'child-explicit-builtins-cfg-'));
 for(const [path,tool] of [['builtin:codemode','codemode'],['builtin:tool-search','tool_search'],['builtin:mcp','read']]) {
  const child=await createChildSession({cwd:root,agentDir,prompt:'test',noExtensions:true,extraExtensions:[path],tools:[tool],requiredTools:[tool],ask:async()=>''});
  try {assert.ok(child.session.getActiveToolNames().includes(tool),tool);assert.ok(child.session.resourceLoader.getExtensions().extensions.some(item=>item.resolvedPath===path),path);} finally {await child.dispose();}
 }
});

test('inherits a parent native provider for the selected model', async () => {
 const root=mkdtempSync(join(tmpdir(),'child-native-provider-')),agentDir=mkdtempSync(join(tmpdir(),'child-native-provider-cfg-'));
 const model:any={id:'local',name:'local',provider:'native-example',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const provider:any={id:'native-example',name:'Native example',auth:{apiKey:{name:'local',check:async()=>({type:'api_key',source:'test'}),resolve:async()=>({auth:{apiKey:'dummy'},source:'test'})}},getModels:()=>[model],stream(){throw new Error('unused')},streamSimple(){const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'Native response'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}};
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',model,nativeProvider:provider,ask:async()=>''});
 try {await child.session.modelRuntime.refresh({allowNetwork:false});assert.ok(child.session.modelRuntime.getRegisteredNativeProvider(model.provider));assert.equal(child.session.modelRuntime.hasConfiguredAuth(model.provider),true);await child.session.prompt('Work');assert.equal(child.session.getLastAssistantText(),'Native response');} finally {await child.dispose();}
});

test('allows a project extension to replace built-in codemode or tool search', async () => {
 const {mkdirSync}=await import('node:fs');
 for(const [name,builtin] of [['codemode','builtin:codemode'],['tool_search','builtin:tool-search']]) for(const explicit of [false,true]) {
  const root=mkdtempSync(join(tmpdir(),'child-replace-tool-')),agentDir=mkdtempSync(join(tmpdir(),'child-replace-cfg-'));
  mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','extensions','custom.js'),`export default pi=>pi.registerTool({name:${JSON.stringify(name)},label:'custom',description:'custom',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'custom'}]})});`);
  const child=await createChildSession({cwd:root,agentDir,prompt:'test',tools:[name],requiredTools:[name],extraExtensions:explicit?[builtin]:[],ask:async()=>''});
  try {assert.ok(child.session.getActiveToolNames().includes(name));assert.ok(child.session.resourceLoader.getExtensions().extensions.some(item=>item.resolvedPath.endsWith('/custom.js')));} finally {await child.dispose();}
 }
});

test('retains parent native provider when a child extension registers the same id', async () => {
 const {mkdirSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'child-native-override-')),agentDir=mkdtempSync(join(tmpdir(),'child-native-override-cfg-'));
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','extensions','provider.js'),`export default pi=>pi.registerProvider({id:'native-example',name:'child-native',auth:{},getModels:()=>[],stream(){},streamSimple(){}});`);
 const model:any={id:'local',name:'local',provider:'native-example',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const provider:any={id:'native-example',name:'parent-native',auth:{},getModels:()=>[model],stream(){},streamSimple(){}};
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',model,nativeProvider:provider,ask:async()=>''});
 try {assert.equal(child.session.modelRuntime.getRegisteredNativeProvider(model.provider),provider);} finally {await child.dispose();}
});

test('retains parent legacy provider config when a child extension registers the same id', async () => {
 const {mkdirSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'child-legacy-override-')),agentDir=mkdtempSync(join(tmpdir(),'child-legacy-override-cfg-'));
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','extensions','provider.js'),`export default pi=>pi.registerProvider('legacy-example',{baseUrl:'http://child.invalid',api:'openai-completions',apiKey:'dummy',models:[]});`);
 const model:any={id:'local',name:'local',provider:'legacy-example',api:'openai-completions',baseUrl:'http://parent.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const providerConfig:any={baseUrl:model.baseUrl,api:model.api,models:[model]};const child=await createChildSession({cwd:root,agentDir,prompt:'test',model,providerConfig,ask:async()=>''});
 try {assert.equal(child.session.modelRuntime.getRegisteredProviderConfig(model.provider)?.baseUrl,'http://parent.invalid');assert.equal(child.session.modelRuntime.getRegisteredProviderConfig(model.provider)?.apiKey,undefined);} finally {await child.dispose();}
});

test('rejects a child whose extension disables the parent contact tool', async () => {
 const {mkdirSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'child-tool-ceiling-')),agentDir=mkdtempSync(join(tmpdir(),'child-tool-ceiling-cfg-'));
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','extensions','activate.js'),`export default pi=>pi.on('session_start',()=>pi.setActiveTools(['read','bash']));`);
 await assert.rejects(createChildSession({cwd:root,agentDir,prompt:'test',tools:['read'],requiredTools:['read'],ask:async()=>''}),/contact_parent/i);
});

test('keeps parent contact available when an extension changes tools at turn start', async () => {
 const {mkdirSync}=await import('node:fs');const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const root=mkdtempSync(join(tmpdir(),'child-contact-turn-')),agentDir=mkdtempSync(join(tmpdir(),'child-contact-turn-cfg-'));
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','extensions','activate.js'),`export default pi=>{pi.on('before_agent_start',()=>pi.setActiveTools(['read']));pi.on('turn_start',()=>pi.setActiveTools(['read']));};`);
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};let asked=false,calls=0;
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',model,tools:['read'],requiredTools:['read'],ask:async()=>{asked=true;return 'answer';}});child.session.modelRuntime.hasConfiguredAuth=()=>true;
 child.session.agent.streamFunction=(()=>{const first=calls++===0;const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:first?[{type:'toolCall',id:'q',name:'contact_parent',arguments:{message:'Need help'}}]:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;}) as any;
 try {await child.session.prompt('work');assert.ok(asked,'contact_parent was not executed');assert.ok(child.session.getActiveToolNames().includes('contact_parent'));} finally {await child.dispose();}
});

test('respects Pi settings and project overrides for built-in MCP', async () => {
 const {existsSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'child-mcp-settings-off-')),agentDir=mkdtempSync(join(tmpdir(),'child-mcp-settings-off-cfg-'));const server=join(root,'server.cjs');
 writeFileSync(server,"require('fs').writeFileSync('mcp-marker','started');setInterval(()=>{},1000)");writeFileSync(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{test:{command:process.execPath,args:[server]}}}));writeFileSync(join(agentDir,'settings.json'),JSON.stringify({extensions:['-builtin:mcp']}));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 try {const child=await createChildSession({cwd:root,agentDir,prompt:'test',tools:['codemode'],requiredTools:['codemode'],ask:async()=>''});try {await new Promise(r=>setTimeout(r,300));assert.equal(existsSync(join(root,'mcp-marker')),false);} finally {await child.dispose();}const {mkdirSync}=await import('node:fs');mkdirSync(join(root,'.pi'),{recursive:true});writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({extensions:['+builtin:mcp']}));const enabled=await createChildSession({cwd:root,agentDir,prompt:'test',tools:['codemode'],requiredTools:['codemode'],projectTrusted:true,ask:async()=>''});try {const deadline=Date.now()+3000;while(!existsSync(join(root,'mcp-marker')) && Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.equal(existsSync(join(root,'mcp-marker')),true);} finally {await enabled.dispose();}}
 finally {if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('reports exceptions thrown by child shutdown handlers and preserves output', async () => {
 const {mkdirSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'child-shutdown-error-')),agentDir=mkdtempSync(join(tmpdir(),'child-shutdown-error-cfg-'));
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','extensions','fail.js'),`export default pi=>pi.on('session_shutdown',()=>{throw new Error('shutdown handler failed');});`);
 const child=await createChildSession({cwd:root,agentDir,prompt:'test',ask:async()=>''});child.session.getLastAssistantText=()=> 'Completed investigation';
 await assert.rejects(child.dispose(),(error:any)=>{assert.match(error.message,/shutdown handler failed/);assert.equal(error.partial,'Completed investigation');return true;});
});

test('does not send a child-only forced prompt that removes parent instructions', async () => {
 const {mkdirSync}=await import('node:fs');const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const root=mkdtempSync(join(tmpdir(),'child-forced-prompt-')),agentDir=mkdtempSync(join(tmpdir(),'child-forced-prompt-cfg-'));mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','extensions','force.js'),`export default pi=>pi.on('before_agent_start',()=>({systemPrompt:'CHILD_ONLY'}));`);
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};let calls=0;
 const child=await createChildSession({cwd:root,agentDir,prompt:'agent instructions',model,requiredTools:['read'],freezeParentSystemPrompt:true,parentAppendSystemPrompts:['parent instructions'],parentContextFiles:[{path:join(root,'AGENTS.md'),content:'repository instructions'}],parentCustomSections:{policy:'policy instructions'},ask:async()=>''});child.session.modelRuntime.hasConfiguredAuth=()=>true;
 child.session.agent.streamFunction=(()=>{calls++;const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}) as any;
 try {await child.session.prompt('work');assert.equal(calls,0);const last=[...child.session.messages].reverse().find(message=>message.role==='assistant');assert.ok(last && last.role==='assistant' && last.stopReason==='error');assert.match(last.errorMessage ?? '',/system prompt/i);} finally {await child.dispose();}
});

test('checks inherited instructions again before a later child model request', async () => {
 const {mkdirSync}=await import('node:fs');const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');const root=mkdtempSync(join(tmpdir(),'child-later-context-')),agentDir=mkdtempSync(join(tmpdir(),'child-later-context-cfg-'));mkdirSync(join(root,'.pi','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','extensions','mutate.js'),`export default pi=>{let calls=0;pi.on('context_with_system',event=>{if(++calls===2)return {messages:event.messages.map((m,i)=>i===0&&m.role==='system'?{...m,sections:{...m.sections,project_context:'<project_context>REMOVED</project_context>'}}:m)};});};`);
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};let calls=0;
 const child=await createChildSession({cwd:root,agentDir,prompt:'agent instructions',model,requiredTools:['read'],freezeParentSystemPrompt:true,parentAppendSystemPrompts:[],parentContextFiles:[{path:join(root,'AGENTS.md'),content:'repository instructions'}],ask:async()=> 'answer'});child.session.modelRuntime.hasConfiguredAuth=()=>true;
 child.session.agent.streamFunction=(()=>{calls++;const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'toolCall',id:'q',name:'contact_parent',arguments:{message:'Need help'}}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'toolUse',message});stream.end();});return stream;}) as any;
 try {await child.session.prompt('work');assert.equal(calls,1);const last=[...child.session.messages].reverse().find(message=>message.role==='assistant');assert.ok(last && last.role==='assistant' && last.stopReason==='error');assert.match(last.errorMessage ?? '',/context files differ/i);} finally {await child.dispose();}
});

test('reports shutdown failure while cleaning up a child startup failure', async () => {
 const {mkdirSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'child-start-cleanup-error-')),agentDir=mkdtempSync(join(tmpdir(),'child-start-cleanup-error-cfg-'));
 mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','extensions','fail.js'),`export default pi=>{pi.on('session_start',()=>{throw new Error('START_FAILED');});pi.on('session_shutdown',()=>{throw new Error('CLEANUP_FAILED');});};`);
 await assert.rejects(createChildSession({cwd:root,agentDir,prompt:'test',ask:async()=>''}),(error:unknown)=>{assert.ok(error instanceof Error);assert.match(error.message,/START_FAILED/);assert.match(error.message,/CLEANUP_FAILED/);return true;});
});

test('accepts an equivalent empty system content array from a child extension', async () => {
 const {mkdirSync}=await import('node:fs');const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');const root=mkdtempSync(join(tmpdir(),'child-empty-system-')),agentDir=mkdtempSync(join(tmpdir(),'child-empty-system-cfg-'));mkdirSync(join(root,'.pi','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','extensions','empty.js'),`export default pi=>pi.on('context_with_system',event=>({messages:event.messages.map(m=>m.role==='system'?{...m,content:[]}:m)}));`);
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};let calls=0;
 const child=await createChildSession({cwd:root,agentDir,prompt:'agent instructions',model,requiredTools:['read'],freezeParentSystemPrompt:true,parentAppendSystemPrompts:[],parentContextFiles:[],ask:async()=>''});child.session.modelRuntime.hasConfiguredAuth=()=>true;
 child.session.agent.streamFunction=(()=>{calls++;const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}) as any;
 try {await child.session.prompt('work');assert.equal(calls,1);assert.equal(child.session.getLastAssistantText(),'done');} finally {await child.dispose();}
});

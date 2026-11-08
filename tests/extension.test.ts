import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import extension from '../index.ts';

test('registers parent tools and shutdown handler', () => {
 const tools:string[]=[], events:string[]=[];
 extension({registerTool(t:any){tools.push(t.name)},on(event:string){events.push(event)},sendMessage(){}} as any);
 for (const name of ['subagent_start','subagent_wait','subagent_status','subagent_steer','subagent_reply','subagent_stop']) assert.ok(tools.includes(name),name);
 assert.ok(events.includes('session_shutdown'));
});

test('Pi SDK loads extension and exposes the registered tools', async () => {
 const {DefaultResourceLoader,createAgentSession,SessionManager} = await import('@earendil-works/pi-coding-agent');
 const {mkdtempSync} = await import('node:fs'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const cwd=mkdtempSync(join(tmpdir(),'pi-extension-test-')), agentDir=mkdtempSync(join(tmpdir(),'pi-config-'));
 const loader=new DefaultResourceLoader({cwd,agentDir,additionalExtensionPaths:[new URL('../index.ts',import.meta.url).pathname]});
 await loader.reload();
 assert.deepEqual(loader.getExtensions().errors,[]);
 const {session}=await createAgentSession({cwd,agentDir,resourceLoader:loader,sessionManager:SessionManager.inMemory(cwd)});
 try {await session.bindExtensions({mode:'print'});assert.ok(session.getActiveToolNames().includes('subagent_start'));} finally {session.dispose();}
});

test('parent tools launch a real child session, receive its question, reply and await completion', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');
 const {execFileSync}=await import('node:child_process'); const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'subagent-e2e-'));execFileSync('git',['init',root],{stdio:'ignore'});
 mkdirSync(join(root,'nested'),{recursive:true}); writeFileSync(join(root,'nested','AGENTS.md'),'Nested instructions sentinel');
 mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nAsk the parent.');
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 let calls=0; let seenSystemPrompt=''; const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:(_model:any,context:any)=>{
  seenSystemPrompt=JSON.stringify(context);
  const stream=createAssistantMessageEventStream(), first=calls++===0;
  const msg:any={role:'assistant',content:first?[{type:'toolCall',id:'q1',name:'contact_parent',arguments:{message:'Need choice'}}]:[{type:'text',text:'Finished A'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'start',partial:msg});stream.push({type:'done',reason:msg.stopReason,message:msg});stream.end();});return stream;
 }};
 const agentDir=mkdtempSync(join(tmpdir(),'subagent-e2e-cfg-'));
 const previous=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=agentDir;
 const registered=new Map<string,any>(), events=new Map<string,any>();
 const api:any={registerTool(t:any){registered.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read','bash','edit','write']},getAllTools(){return []},sendMessage(){}};
 extension(api);
 const ctx:any={cwd:join(root,'nested'),model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const call=async (name:string,params:any)=>{const r=await registered.get(name).execute('x',params,undefined,undefined,ctx); const parsed=JSON.parse(r.content[0].text);if(r.isError)throw new Error(JSON.stringify(parsed));return parsed;};
 try {
  const started=await call('subagent_start',{agent:'worker',task:'Work',mode:'background',workspace:'shared'});
  const waiting=await call('subagent_wait',{ids:[started.id]});
  assert.equal(waiting.questions[0]?.message,'Need choice',JSON.stringify(waiting));
  await call('subagent_reply',{id:started.id,requestId:waiting.questions[0].requestId,answer:'Use A'});
  const finished=await call('subagent_wait',{ids:[started.id],cursor:waiting.cursor});
  assert.equal(finished.done[0].state,'completed');assert.equal(finished.done[0].result,'Finished A');assert.match(seenSystemPrompt,/Nested instructions sentinel/);
 } finally {await events.get('session_shutdown')(); if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('background child completion wakes an actual Pi parent session', {timeout:5000}, async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {DefaultResourceLoader,createAgentSession,SessionManager}=await import('@earendil-works/pi-coding-agent');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'parent-notify-')),agentDir=mkdtempSync(join(tmpdir(),'parent-notify-cfg-'));
 execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nDo the task.');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const eventStream=(content:any[],stopReason:string,delay=0)=>{const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason,timestamp:Date.now()};setTimeout(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:stopReason as any,message});stream.end();},delay);return stream;};
 const loader=new DefaultResourceLoader({cwd:root,agentDir,additionalExtensionPaths:[new URL('../index.ts',import.meta.url).pathname]});await loader.reload();
 const {session}=await createAgentSession({cwd:root,agentDir,model,resourceLoader:loader,sessionManager:SessionManager.inMemory(root)});
 session.modelRuntime.registerProvider('fake',{api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>eventStream([{type:'text',text:'Child completed'}],'stop',100)});
 session.modelRuntime.hasConfiguredAuth=()=>true;let parentCalls=0;
 session.agent.streamFunction=(()=>{parentCalls++;return parentCalls===1?eventStream([{type:'toolCall',id:'start1',name:'subagent_start',arguments:{agent:'worker',task:'test',mode:'background',workspace:'shared'}}],'toolUse'):eventStream([{type:'text',text:'parent response'}],'stop');}) as any;
 try {
  await session.bindExtensions({mode:'print'});await session.prompt('Start child');
  for(let i=0;i<100 && parentCalls<3;i++) await new Promise(r=>setTimeout(r,20));
  assert.ok(parentCalls>=3,`completion did not wake parent; calls=${parentCalls}`);
 } finally {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

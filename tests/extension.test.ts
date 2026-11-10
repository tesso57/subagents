import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import extension from '../extensions/index.ts';
import { createMockPi } from './helpers/mock-pi.ts';

const PI_DEFAULT_PREAMBLE='You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.';

test('registers parent tools and shutdown handler', async () => {
 const mock=createMockPi();
 extension(mock.pi);
 for (const name of ['subagent_start','subagent_wait','subagent_status','subagent_steer','subagent_reply','subagent_stop']) assert.ok(mock.tools.has(name),name);
 await mock.emit('session_shutdown',{type:'session_shutdown',reason:'quit'});
});

test('Pi SDK loads extension and exposes the registered tools', async () => {
 const {DefaultResourceLoader,createAgentSession,SessionManager} = await import('@earendil-works/pi-coding-agent');
 const {mkdtempSync} = await import('node:fs'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const cwd=mkdtempSync(join(tmpdir(),'pi-extension-test-')), agentDir=mkdtempSync(join(tmpdir(),'pi-config-'));
 const loader=new DefaultResourceLoader({cwd,agentDir,additionalExtensionPaths:[new URL('../extensions/index.ts',import.meta.url).pathname]});
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
 const ctx:any={cwd:join(root,'nested'),isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const call=async (name:string,params:any)=>{const r=await registered.get(name).execute('x',params,undefined,undefined,ctx); const parsed=JSON.parse(r.content[0].text);if(r.isError)throw new Error(JSON.stringify(parsed));return parsed;};
 const contextSection=`<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${join(root,'nested','AGENTS.md')}">\nNested instructions sentinel\n</project_instructions>\n</project_context>`;
 events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,project_context:contextSection}}]});
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
 const loader=new DefaultResourceLoader({cwd:root,agentDir,additionalExtensionPaths:[new URL('../extensions/index.ts',import.meta.url).pathname]});await loader.reload();
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

test('waiting parent receives child events without duplicate notifications', async () => {
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
  setTimeout(()=>{stream.push({type:'start',partial:msg});stream.push({type:'done',reason:msg.stopReason,message:msg});stream.end();},first?0:50);return stream;
 }};
 const agentDir=mkdtempSync(join(tmpdir(),'subagent-e2e-cfg-'));
 const previous=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=agentDir;
 const registered=new Map<string,any>(), events=new Map<string,any>();const notifications:string[]=[];
 const api:any={registerTool(t:any){registered.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read','bash','edit','write']},getAllTools(){return []},sendMessage(message:any){notifications.push(message.content)}};
 extension(api);
 const ctx:any={cwd:join(root,'nested'),isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const call=async (name:string,params:any)=>{const r=await registered.get(name).execute('x',params,undefined,undefined,ctx); const parsed=JSON.parse(r.content[0].text);if(r.isError)throw new Error(JSON.stringify(parsed));return parsed;};
 const contextSection=`<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${join(root,'nested','AGENTS.md')}">\nNested instructions sentinel\n</project_instructions>\n</project_context>`;
 events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,project_context:contextSection}}]});
 try {
  const started=await call('subagent_start',{agent:'worker',task:'Work',mode:'wait',workspace:'shared'});
  const waiting=started;
  assert.equal(waiting.questions[0]?.message,'Need choice',JSON.stringify(waiting));
  await call('subagent_reply',{id:started.id,requestId:waiting.questions[0].requestId,answer:'Use A'});
  const finished=await call('subagent_wait',{ids:[started.id],cursor:waiting.cursor});
  assert.equal(finished.done[0].state,'completed');assert.equal(finished.done[0].result,'Finished A');assert.match(seenSystemPrompt,/Nested instructions sentinel/);assert.deepEqual(notifications,[]);
 } finally {await events.get('session_shutdown')(); if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('subagent tools remain usable after a Pi session is replaced', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {createAgentSessionRuntime,createAgentSessionFromServices,createAgentSessionServices,SessionManager}=await import('@earendil-works/pi-coding-agent');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-session-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-session-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'AGENTS.md'),'Actual parent context');
 const previousDir=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;writeFileSync(join(agentDir,'APPEND_SYSTEM.md'),'Parent append sentinel');
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const factory=async ({cwd,sessionManager,sessionStartEvent}:any)=>{const services=await createAgentSessionServices({cwd,agentDir,resourceLoaderOptions:{additionalExtensionPaths:[new URL('../extensions/index.ts',import.meta.url).pathname]}});return {...await createAgentSessionFromServices({services,sessionManager,sessionStartEvent,model}),services,diagnostics:services.diagnostics};};
 const runtime=await createAgentSessionRuntime(factory,{cwd:root,agentDir,sessionManager:SessionManager.inMemory(root)});
 async function runStatus(expected:string,changeAfterBind=false) {
  const session=runtime.session;await session.bindExtensions({mode:'print'});if(changeAfterBind)writeFileSync(join(root,'AGENTS.md'),'Changed parent context');session.modelRuntime.hasConfiguredAuth=()=>true;let calls=0,childContext='';
  session.modelRuntime.registerProvider('fake',{api:'openai-completions',apiKey:'fake',models:[model],streamSimple:(_model:any,context:any)=>{childContext=JSON.stringify(context);const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'child done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}});
  session.agent.streamFunction=(()=>{const stream=createAssistantMessageEventStream(),first=calls++===0;const message:any={role:'assistant',content:first?[{type:'toolCall',id:'status1',name:'subagent_start',arguments:{agent:'worker',task:'work',mode:'wait',workspace:'shared'}}]:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;}) as any;
  await session.prompt('Check status');
  const result=session.messages.find((m:any)=>m.role==='toolResult');assert.ok(result && result.role==='toolResult' && !result.isError,JSON.stringify(result));
  const payload=JSON.parse((result.content[0] as any).text);assert.equal(payload.done[0].state,'completed',JSON.stringify(payload));assert.ok(childContext.includes(expected),childContext);
 }
 try {await runStatus('Actual parent context',true);await runtime.newSession();await runStatus('Changed parent context');} finally {await runtime.dispose();if(previousDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousDir;}
});

test('rejects project agent launch when the project is untrusted', async () => {
 const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'untrusted-project-'));execFileSync('git',['init',root],{stdio:'ignore'});
 const tools=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(){},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>false};
 const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);
 assert.match(result.content[0].text,/Project is not trusted/);
});

test('child uses the parent CLI prompt snapshot after its source file changes', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'parent-prompt-')),agentDir=mkdtempSync(join(tmpdir(),'parent-prompt-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});
 mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const promptFile=join(root,'prompt.md');writeFileSync(promptFile,'Original parent instruction');
 const previousArgv=process.argv,previousDir=process.env.PI_CODING_AGENT_DIR;process.argv=['node','pi','--append-system-prompt',promptFile];process.env.PI_CODING_AGENT_DIR=agentDir;
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};let seen='';
 const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:(_model:any,context:any)=>{seen=JSON.stringify(context);const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}};
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 writeFileSync(promptFile,'Changed parent instruction');
 const ctx:any={cwd:root,isProjectTrusted:()=>true,getSystemPrompt:()=> `${PI_DEFAULT_PREAMBLE}\n\n<addendum>\nOriginal parent instruction\n</addendum>`,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,addendum:'<addendum>\nOriginal parent instruction\n</addendum>'}}]});
 try {
  const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'shared'},undefined,undefined,ctx);
  assert.equal(result.isError,undefined,result.content[0].text);assert.match(seen,/Original parent instruction/);assert.doesNotMatch(seen,/Changed parent instruction/);
 } finally {await events.get('session_shutdown')();process.argv=previousArgv;if(previousDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousDir;}
});

test('child inherits discovered parent prompts after their files change', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'parent-prompt-')),agentDir=mkdtempSync(join(tmpdir(),'parent-prompt-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});
 mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const promptFile=join(agentDir,'APPEND_SYSTEM.md');writeFileSync(promptFile,'Original parent instruction');
 const previousArgv=process.argv,previousDir=process.env.PI_CODING_AGENT_DIR;process.argv=['node','pi'];process.env.PI_CODING_AGENT_DIR=agentDir;
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};let seen='';
 const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:(_model:any,context:any)=>{seen=JSON.stringify(context);const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}};
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,getSystemPrompt:()=> `${PI_DEFAULT_PREAMBLE}\n\n<addendum>\nOriginal parent instruction\n</addendum>`,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 await events.get('session_start')({type:'session_start',reason:'startup'},ctx);writeFileSync(promptFile,'Changed parent instruction');
 events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,addendum:'<addendum>\nOriginal parent instruction\n</addendum>'}}]});
 try {
  const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'shared'},undefined,undefined,ctx);
  assert.equal(result.isError,undefined,result.content[0].text);assert.match(seen,/Original parent instruction/);assert.doesNotMatch(seen,/Changed parent instruction/);
 } finally {await events.get('session_shutdown')();process.argv=previousArgv;if(previousDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousDir;}
});

test('rejects launch when the parent prompt changed during initialization', async () => {
 const {mkdtempSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'prompt-mismatch-')),file=join(root,'prompt.md');writeFileSync(file,'Original instruction');
 const previous=process.argv;process.argv=['node','pi','--append-system-prompt',file];
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},sendMessage(){}};
 try {
  extension(api);writeFileSync(file,'Changed instruction');
  const ctx:any={cwd:root,isProjectTrusted:()=>true,getSystemPrompt:()=> 'Changed instruction'};
  events.get('session_start')({type:'session_start',reason:'startup'},ctx);
  events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,addendum:'<addendum>\nChanged instruction\n</addendum>'}}]});
  const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);
  assert.match(result.content[0].text,/differs from captured/);
 } finally {process.argv=previous;}
});

test('worktree child receives parent instructions at the worktree path', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');const {loadProjectContextFiles}=await import('@earendil-works/pi-coding-agent');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'parent-worktree-')),agentDir=mkdtempSync(join(tmpdir(),'parent-worktree-cfg-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});git('init');git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');
 mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'AGENTS.md'),'Worktree parent rules');git('add','.');git('commit','-m','base');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};let seen='';
 const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:(_m:any,context:any)=>{seen=JSON.stringify(context);const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}};
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const files=loadProjectContextFiles({cwd:root,agentDir});const body=['Project-specific instructions and guidelines:',...files.map(f=>`<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`)].join('\n\n');
 events.get('session_start')({type:'session_start',reason:'startup'},ctx);events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,project_context:`<project_context>\n${body}\n</project_context>`}}]});
 try {const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'worktree'},undefined,undefined,ctx);assert.equal(result.isError,undefined,result.content[0].text);const payload=JSON.parse(result.content[0].text);assert.equal(payload.done[0].state,'completed',JSON.stringify(payload));assert.match(seen,/subagent-worktrees.*AGENTS.md/);assert.match(seen,/Worktree parent rules/);} finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('stopping a child reports an unconsumed SDK steering message', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');
 const {execFileSync}=await import('node:child_process'); const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'subagent-e2e-'));execFileSync('git',['init',root],{stdio:'ignore'});
 mkdirSync(join(root,'nested'),{recursive:true}); writeFileSync(join(root,'nested','AGENTS.md'),'Nested instructions sentinel');
 mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nAsk the parent.');
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 let calls=0; const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>{
  const stream=createAssistantMessageEventStream(), first=calls++===0;
  const msg:any={role:'assistant',content:first?[{type:'toolCall',id:'q1',name:'contact_parent',arguments:{message:'Need choice'}}]:[{type:'text',text:'Finished A'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'start',partial:msg});stream.push({type:'done',reason:msg.stopReason,message:msg});stream.end();});return stream;
 }};
 const agentDir=mkdtempSync(join(tmpdir(),'subagent-e2e-cfg-'));
 const previous=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=agentDir;
 const registered=new Map<string,any>(), events=new Map<string,any>();
 const api:any={registerTool(t:any){registered.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read','bash','edit','write']},getAllTools(){return []},sendMessage(){}};
 extension(api);
 const ctx:any={cwd:join(root,'nested'),isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const call=async (name:string,params:any)=>{const r=await registered.get(name).execute('x',params,undefined,undefined,ctx); const parsed=JSON.parse(r.content[0].text);if(r.isError)throw new Error(JSON.stringify(parsed));return parsed;};
 const contextSection=`<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${join(root,'nested','AGENTS.md')}">\nNested instructions sentinel\n</project_instructions>\n</project_context>`;
 events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,project_context:contextSection}}]});
 try {
  const started=await call('subagent_start',{agent:'worker',task:'Work',mode:'background',workspace:'shared'});
  const waiting=await call('subagent_wait',{ids:[started.id]});
  assert.equal(waiting.questions[0]?.message,'Need choice',JSON.stringify(waiting));
  const steered=await call('subagent_steer',{id:started.id,message:'Important extra instruction'});assert.equal(steered.delivery,'queued');
  await call('subagent_stop',{id:started.id});
  const finished=await call('subagent_wait',{ids:[started.id],cursor:waiting.cursor});
  const stopped=finished.events.find((e:any)=>e.id===started.id && e.type==='stopped');
  assert.deepEqual(stopped?.data?.unconsumedSteering,['Important extra instruction']);
 } finally {await events.get('session_shutdown')(); if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;}
});


test('stopping waits for in-flight steering to be accounted for', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');
 const {execFileSync}=await import('node:child_process'); const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'subagent-e2e-'));execFileSync('git',['init',root],{stdio:'ignore'});
 mkdirSync(join(root,'nested','.pi','extensions'),{recursive:true});writeFileSync(join(root,'nested','.pi','extensions','slow.js'),`export default function(pi){pi.on('input',async event=>{if(event.text==='Important extra instruction') await new Promise(r=>setTimeout(r,60));});}`); writeFileSync(join(root,'nested','AGENTS.md'),'Nested instructions sentinel');
 mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nAsk the parent.');
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 let calls=0; const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>{
  const stream=createAssistantMessageEventStream(), first=calls++===0;
  const msg:any={role:'assistant',content:first?[{type:'toolCall',id:'q1',name:'contact_parent',arguments:{message:'Need choice'}}]:[{type:'text',text:'Finished A'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'start',partial:msg});stream.push({type:'done',reason:msg.stopReason,message:msg});stream.end();});return stream;
 }};
 const agentDir=mkdtempSync(join(tmpdir(),'subagent-e2e-cfg-'));
 const previous=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=agentDir;
 const registered=new Map<string,any>(), events=new Map<string,any>();
 const api:any={registerTool(t:any){registered.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read','bash','edit','write']},getAllTools(){return []},sendMessage(){}};
 extension(api);
 const ctx:any={cwd:join(root,'nested'),isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const call=async (name:string,params:any)=>{const r=await registered.get(name).execute('x',params,undefined,undefined,ctx); const parsed=JSON.parse(r.content[0].text);if(r.isError)throw new Error(JSON.stringify(parsed));return parsed;};
 const contextSection=`<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${join(root,'nested','AGENTS.md')}">\nNested instructions sentinel\n</project_instructions>\n</project_context>`;
 events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,project_context:contextSection}}]});
 try {
  const started=await call('subagent_start',{agent:'worker',task:'Work',mode:'background',workspace:'shared'});
  const waiting=await call('subagent_wait',{ids:[started.id]});
  assert.equal(waiting.questions[0]?.message,'Need choice',JSON.stringify(waiting));
  const steering=call('subagent_steer',{id:started.id,message:'Important extra instruction'});
  await call('subagent_stop',{id:started.id});
  const steered=await steering;assert.equal(steered.delivery,'unconfirmed');
  const finished=await call('subagent_wait',{ids:[started.id],cursor:waiting.cursor});
  const stopped=finished.events.find((e:any)=>e.id===started.id && e.type==='stopped');
  assert.deepEqual(stopped?.data?.unconsumedSteering,['Important extra instruction']);
 } finally {await events.get('session_shutdown')(); if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('stopping reports steering still awaiting an input handler', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');
 const {execFileSync}=await import('node:child_process'); const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'subagent-e2e-'));execFileSync('git',['init',root],{stdio:'ignore'});
 mkdirSync(join(root,'nested','.pi','extensions'),{recursive:true});writeFileSync(join(root,'nested','.pi','extensions','slow.js'),`export default function(pi){pi.on('input',async event=>{if(event.text==='Important extra instruction') await new Promise(r=>setTimeout(r,1300));});}`); writeFileSync(join(root,'nested','AGENTS.md'),'Nested instructions sentinel');
 mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nAsk the parent.');
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 let calls=0; const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>{
  const stream=createAssistantMessageEventStream(), first=calls++===0;
  const msg:any={role:'assistant',content:first?[{type:'toolCall',id:'q1',name:'contact_parent',arguments:{message:'Need choice'}}]:[{type:'text',text:'Finished A'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'start',partial:msg});stream.push({type:'done',reason:msg.stopReason,message:msg});stream.end();});return stream;
 }};
 const agentDir=mkdtempSync(join(tmpdir(),'subagent-e2e-cfg-'));
 const previous=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=agentDir;
 const registered=new Map<string,any>(), events=new Map<string,any>();
 const api:any={registerTool(t:any){registered.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read','bash','edit','write']},getAllTools(){return []},sendMessage(){}};
 extension(api);
 const ctx:any={cwd:join(root,'nested'),isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const call=async (name:string,params:any)=>{const r=await registered.get(name).execute('x',params,undefined,undefined,ctx); const parsed=JSON.parse(r.content[0].text);if(r.isError)throw new Error(JSON.stringify(parsed));return parsed;};
 const contextSection=`<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${join(root,'nested','AGENTS.md')}">\nNested instructions sentinel\n</project_instructions>\n</project_context>`;
 events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,project_context:contextSection}}]});
 try {
  const started=await call('subagent_start',{agent:'worker',task:'Work',mode:'background',workspace:'shared'});
  const waiting=await call('subagent_wait',{ids:[started.id]});
  assert.equal(waiting.questions[0]?.message,'Need choice',JSON.stringify(waiting));
  const steering=call('subagent_steer',{id:started.id,message:'Important extra instruction'});
  await call('subagent_stop',{id:started.id});
  const finished=await call('subagent_wait',{ids:[started.id],cursor:waiting.cursor});
  const stopped=finished.events.find((e:any)=>e.id===started.id && e.type==='stopped');
  assert.deepEqual(stopped?.data?.unconfirmedSteering,['Important extra instruction']);
  const steered=await steering;assert.equal(steered.delivery,'unconfirmed');
 } finally {await events.get('session_shutdown')(); if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('rejects worktree when a settings-selected project skill differs from the parent', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'parent-custom-skill-')),agentDir=mkdtempSync(join(tmpdir(),'parent-custom-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init');git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');mkdirSync(join(root,'.pi','agents'),{recursive:true});mkdirSync(join(root,'custom-skill'));
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({skills:['../custom-skill']}));const skill=join(root,'custom-skill','SKILL.md');writeFileSync(skill,'---\nname: custom\ndescription: baseline\n---\nbody');git('add','.');git('commit','-m','base');writeFileSync(skill,'---\nname: custom\ndescription: changed\n---\nbody');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>{const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}};
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},getCommands(){return [{source:'skill',name:'skill:custom',description:'changed',sourceInfo:{path:skill}}]},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 try {const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'worktree'},undefined,undefined,ctx);assert.equal(result.isError,undefined,result.content[0].text);const payload=JSON.parse(result.content[0].text);assert.equal(payload.done[0].state,'failed',JSON.stringify(payload));assert.match(payload.done[0].error,/skill.*differs/i);} finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('rejects worktree when a package-selected project skill differs from the parent', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'parent-custom-skill-')),agentDir=mkdtempSync(join(tmpdir(),'parent-custom-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init');git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');mkdirSync(join(root,'.pi','agents'),{recursive:true});mkdirSync(join(root,'pack','skills','custom'),{recursive:true});writeFileSync(join(root,'pack','package.json'),JSON.stringify({name:'test-pack',version:'1.0.0',pi:{skills:['./skills']}}));
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({packages:['../pack']}));const skill=join(root,'pack','skills','custom','SKILL.md');writeFileSync(skill,'---\nname: custom\ndescription: baseline\n---\nbody');git('add','.');git('commit','-m','base');writeFileSync(skill,'---\nname: custom\ndescription: changed\n---\nbody');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>{const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;}};
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},getCommands(){return [{source:'skill',name:'skill:custom',description:'changed',sourceInfo:{path:skill}}]},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 try {const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'worktree'},undefined,undefined,ctx);assert.equal(result.isError,undefined,result.content[0].text);const payload=JSON.parse(result.content[0].text);assert.equal(payload.done[0].state,'failed',JSON.stringify(payload));assert.match(payload.done[0].error,/skill.*differs/i);} finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('does not launch a background child when start is cancelled during preflight', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {execFileSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'subagent-cancel-start-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-cancel-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{},thinkingLevel:'off'};const controller=new AbortController();
 try {
  const pending=tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},controller.signal,undefined,ctx);
  controller.abort();const result=await pending;
  assert.equal(result.isError,true,result.content[0].text);assert.match(result.content[0].text,/abort|cancel/i);
  const state=await tools.get('subagent_status').execute('id',{},undefined,undefined,ctx);assert.deepEqual(JSON.parse(state.content[0].text),[]);
 } finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});


test('rejects steering issued immediately after a stop request', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');
 const {execFileSync}=await import('node:child_process'); const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'subagent-e2e-'));execFileSync('git',['init',root],{stdio:'ignore'});
 mkdirSync(join(root,'nested'),{recursive:true}); writeFileSync(join(root,'nested','AGENTS.md'),'Nested instructions sentinel');
 mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nAsk the parent.');
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 let calls=0; const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>{
  const stream=createAssistantMessageEventStream(), first=calls++===0;
  const msg:any={role:'assistant',content:first?[{type:'toolCall',id:'q1',name:'contact_parent',arguments:{message:'Need choice'}}]:[{type:'text',text:'Finished A'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};
  queueMicrotask(()=>{stream.push({type:'start',partial:msg});stream.push({type:'done',reason:msg.stopReason,message:msg});stream.end();});return stream;
 }};
 const agentDir=mkdtempSync(join(tmpdir(),'subagent-e2e-cfg-'));
 const previous=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=agentDir;
 const registered=new Map<string,any>(), events=new Map<string,any>();
 const api:any={registerTool(t:any){registered.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read','bash','edit','write']},getAllTools(){return []},sendMessage(){}};
 extension(api);
 const ctx:any={cwd:join(root,'nested'),isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const call=async (name:string,params:any)=>{const r=await registered.get(name).execute('x',params,undefined,undefined,ctx); const parsed=JSON.parse(r.content[0].text);if(r.isError)throw new Error(JSON.stringify(parsed));return parsed;};
 const contextSection=`<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${join(root,'nested','AGENTS.md')}">\nNested instructions sentinel\n</project_instructions>\n</project_context>`;
 events.get('context_with_system')({messages:[{role:'system',content:'',sections:{preamble:PI_DEFAULT_PREAMBLE,project_context:contextSection}}]});
 try {
  const started=await call('subagent_start',{agent:'worker',task:'Work',mode:'background',workspace:'shared'});
  const waiting=await call('subagent_wait',{ids:[started.id]});
  assert.equal(waiting.questions[0]?.message,'Need choice',JSON.stringify(waiting));
  const stopping=call('subagent_stop',{id:started.id});
  const steering=call('subagent_steer',{id:started.id,message:'Too late'});
  await stopping;await assert.rejects(steering,/stopping|finished/i);
  const finished=await call('subagent_wait',{ids:[started.id],cursor:waiting.cursor});
  assert.equal(finished.done[0].state,'stopped');
 } finally {await events.get('session_shutdown')(); if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('parent CLI runtime key authenticates a child without appearing in tool results', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync,readdirSync,readFileSync}=await import('node:fs');
 const {execFileSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'subagent-key-e2e-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-key-cfg-'));
 execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nDo the task.');
 const model:any={id:'fake',name:'fake',provider:'fake-runtime-auth',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 let calls=0;const providerConfig:any={api:'openai-completions',baseUrl:model.baseUrl,models:[model],streamSimple:()=>{
  calls++;const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'text',text:'Finished'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});stream.end();});return stream;
 }};
 const previousArgv=process.argv,previousDir=process.env.PI_CODING_AGENT_DIR;process.argv=['node','pi','--api-key','placeholder-test-key'];process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};
 extension(api);const ctx:any={cwd:root,isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig,getApiKeyForProvider:async()=> 'placeholder-test-key'},thinkingLevel:'off'};
 try {
  const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'shared'},undefined,undefined,ctx);
  assert.equal(result.isError,undefined,JSON.stringify(result));assert.equal(JSON.parse(result.content[0].text).done[0].state,'completed');assert.equal(calls,1);
  const status=await tools.get('subagent_status').execute('id',{},undefined,undefined,ctx);assert.doesNotMatch(JSON.stringify([result,status]),/placeholder-test-key/);
  const files=(path:string):string[]=>readdirSync(path,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(path,entry.name)):entry.isFile()?[join(path,entry.name)]:[]);
  for(const path of files(agentDir)) assert.doesNotMatch(readFileSync(path,'utf8'),/placeholder-test-key/);
 } finally {await events.get('session_shutdown')();process.argv=previousArgv;if(previousDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousDir;}
});

test('rejects changed parent MCP configuration before launching a child', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-mcp-drift-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-mcp-drift-cfg-'));
 execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const config=join(agentDir,'mcp.json');writeFileSync(config,'{"mcpServers":{"test":{"command":"server-a"}}}');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read','mcp__test__hello']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};
 try {await events.get('session_start')({type:'session_start',reason:'startup'},ctx);writeFileSync(config,'{"mcpServers":{"test":{"command":"server-b"}}}');const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);assert.equal(result.isError,true);assert.match(result.content[0].text,/MCP.*changed/i);assert.doesNotMatch(result.content[0].text,/server-a|server-b/);writeFileSync(config,'{\"mcpServers\":{}}');await events.get('session_start')({type:'session_start',reason:'startup'},ctx);writeFileSync(join(root,'.pi','mcp.json'),'{\"mcpServers\":{}}');const projectResult=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);assert.equal(projectResult.isError,true);assert.match(projectResult.content[0].text,/MCP.*changed/i);await events.get('session_start')({type:'session_start',reason:'startup'},ctx);writeFileSync(join(agentDir,'settings.json'),JSON.stringify({extensions:['-builtin:mcp']}));const settingsResult=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);assert.equal(settingsResult.isError,true);assert.match(settingsResult.content[0].text,/MCP.*changed/i);}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('does not reject codemode-only children for unrelated MCP config changes', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-no-mcp-drift-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-no-mcp-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const previousDir=process.env.PI_CODING_AGENT_DIR,previousArgv=process.argv;process.env.PI_CODING_AGENT_DIR=agentDir;process.argv=['node','pi','--no-extensions','-e','builtin:codemode'];
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['codemode']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};
 try {await events.get('session_start')({type:'session_start',reason:'startup'},ctx);writeFileSync(join(agentDir,'mcp.json'),'{"mcpServers":{}}');const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);assert.notEqual(result.isError,true,result.content[0].text);}
 finally {await events.get('session_shutdown')();process.argv=previousArgv;if(previousDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousDir;}
});

test('does not reject a read-only agent when parent MCP configuration changes', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-readonly-drift-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-readonly-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\ntools: [read]\n---\nWork.');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read','mcp__test__hello']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};
 try {await events.get('session_start')({type:'session_start',reason:'startup'},ctx);writeFileSync(join(agentDir,'mcp.json'),'{"mcpServers":{}}');const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);assert.notEqual(result.isError,true,result.content[0].text);}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('does not check unrelated MCP config when settings disabled MCP', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-settings-no-mcp-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-settings-no-mcp-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(agentDir,'settings.json'),JSON.stringify({extensions:['-builtin:mcp']}));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;const tools=new Map<string,any>(),events=new Map<string,any>();
 const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['codemode']},getAllTools(){return []},getCommands(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};
 try {await events.get('session_start')({type:'session_start',reason:'startup'},ctx);writeFileSync(join(agentDir,'mcp.json'),'{"mcpServers":{}}');const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);assert.notEqual(result.isError,true,result.content[0].text);}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('retains queued steering when the initial child prompt fails', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-initial-steering-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-initial-steering-cfg-'));
 execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','extensions','slow.js'),`export default async ()=>{await new Promise(r=>setTimeout(r,150));};`);
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const model:any={id:'local',name:'local',provider:'unconfigured-for-test',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};const ctx:any={cwd:root,isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};
 const call=async(name:string,params:any)=>JSON.parse((await tools.get(name).execute('id',params,undefined,undefined,ctx)).content[0].text);
 try {const started=await call('subagent_start',{agent:'worker',task:'work',mode:'background',workspace:'shared'});const steering=await call('subagent_steer',{id:started.id,message:'Keep this instruction'});assert.equal(steering.delivery,'queued');const done=(await call('subagent_wait',{ids:[started.id]})).done[0];assert.equal(done.state,'failed');assert.ok(done.unconfirmedSteering.includes('Keep this instruction'));}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('stopping worktree child during preflight avoids creating a worktree', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-stop-worktree-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-stop-worktree-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};const call=async(name:string,params:any)=>JSON.parse((await tools.get(name).execute('id',params,undefined,undefined,ctx)).content[0].text);
 try {const started=await call('subagent_start',{agent:'worker',task:'work',mode:'background',workspace:'worktree'});assert.ok(started.id,JSON.stringify(started));await call('subagent_stop',{id:started.id});const done=(await call('subagent_wait',{ids:[started.id]})).done[0];assert.equal(done.state,'stopped');assert.equal(done.worktree,undefined);assert.equal(git('worktree','list','--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length,1);}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('returns the child id if a waiting start is cancelled after launch', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,existsSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-wait-abort-id-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-wait-abort-id-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});mkdirSync(join(root,'.pi','extensions'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const entered=join(root,'entered'),release=join(root,'release');writeFileSync(join(root,'.pi','extensions','slow.js'),`import {writeFileSync,existsSync} from 'node:fs';export default async()=>{writeFileSync(${JSON.stringify(entered)},'1');while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,5));};`);
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'},controller=new AbortController();
 try {const pending=tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'shared'},controller.signal,undefined,ctx);const deadline=Date.now()+5000;while(!existsSync(entered)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.ok(existsSync(entered));controller.abort();writeFileSync(release,'1');const result=await pending;assert.equal(result.isError,true);const payload=JSON.parse(result.content[0].text);assert.ok(payload.id);const status=JSON.parse((await tools.get('subagent_status').execute('id',{},undefined,undefined,ctx)).content[0].text);assert.ok(status.some((entry:any)=>entry.id===payload.id));}
 finally {writeFileSync(release,'1');await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('rejects unsupported explicit built-ins before creating a worktree', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-unsupported-builtin-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-unsupported-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();git('init','-q');mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 const previousDir=process.env.PI_CODING_AGENT_DIR,previousArgv=process.argv;process.env.PI_CODING_AGENT_DIR=agentDir;process.argv=['node','pi','-e','builtin:llama.cpp'];const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};
 try {const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'worktree'},undefined,undefined,ctx);assert.equal(result.isError,true);assert.match(result.content[0].text,/builtin:llama\.cpp/);assert.equal(git('worktree','list','--porcelain').split('\n').filter(line=>line.startsWith('worktree ')).length,1);}
 finally {await events.get('session_shutdown')();process.argv=previousArgv;if(previousDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousDir;}
});

test('preserves earlier child output when a later model response fails without text', async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-partial-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-partial-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const model:any={id:'fake',name:'fake',provider:'fake-partial',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};let calls=0;
 const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>{const first=calls++===0,stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:first?[{type:'text',text:'VALUABLE_PARTIAL'},{type:'toolCall',id:'q',name:'contact_parent',arguments:{message:'Need help'}}]:[],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'error',errorMessage:first?undefined:'provider failed',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});if(first)stream.push({type:'done',reason:'toolUse',message});else stream.push({type:'error',reason:'error',error:message});stream.end();});return stream;}};
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);const ctx:any={cwd:root,isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};const call=async(name:string,params:any)=>JSON.parse((await tools.get(name).execute('id',params,undefined,undefined,ctx)).content[0].text);
 try {const started=await call('subagent_start',{agent:'worker',task:'work',mode:'background',workspace:'shared'});const waiting=await call('subagent_wait',{ids:[started.id]});assert.equal(waiting.questions.length,1);await call('subagent_reply',{id:started.id,requestId:waiting.questions[0].requestId,answer:'continue'});const done=(await call('subagent_wait',{ids:[started.id],cursor:waiting.cursor})).done[0];assert.equal(done.state,'failed');assert.match(done.error,/provider failed/);assert.equal(done.result,'VALUABLE_PARTIAL');assert.equal((await call('subagent_result',{id:started.id})).text,'VALUABLE_PARTIAL');}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

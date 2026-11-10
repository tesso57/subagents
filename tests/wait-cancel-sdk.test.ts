import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {DefaultResourceLoader,createAgentSession,SessionManager} from '@earendil-works/pi-coding-agent';

test('Pi retains the child id when cancelling a waiting start', {timeout:10000}, async () => {
 const root=mkdtempSync(join(tmpdir(),'wait-abort-sdk-')),agentDir=mkdtempSync(join(tmpdir(),'wait-abort-sdk-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 let started!:()=>void;const childStarted=new Promise<void>(resolve=>{started=resolve});
 const loader=new DefaultResourceLoader({cwd:root,agentDir,additionalExtensionPaths:[new URL('../extensions/index.ts',import.meta.url).pathname]});await loader.reload();
 const {session}=await createAgentSession({cwd:root,agentDir,model,resourceLoader:loader,sessionManager:SessionManager.inMemory(root)});
 session.modelRuntime.registerProvider('fake',{api:'openai-completions',apiKey:'fake',models:[model],streamSimple:(_model,_context,options)=>{
  const stream=createAssistantMessageEventStream();started();const abort=()=>{const message:any={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'aborted',errorMessage:'Aborted',timestamp:Date.now()};stream.push({type:'error',reason:'aborted',error:message});stream.end();};if(options?.signal?.aborted)abort();else options?.signal?.addEventListener('abort',abort,{once:true});return stream;
 }});session.modelRuntime.hasConfiguredAuth=()=>true;
 let phase='start',parentCalls=0;session.agent.streamFunction=(()=>{const first=parentCalls++===0,stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:first?(phase==='start'?[{type:'toolCall',id:'start',name:'subagent_start',arguments:{agent:'worker',task:'work',mode:'wait',workspace:'shared'}}]:[{type:'toolCall',id:'status',name:'subagent_status',arguments:{}}]):[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;}) as any;
 try {
  await session.bindExtensions({mode:'print'});const run=session.prompt('Start a child');await Promise.race([childStarted,run.then(()=>{throw new Error(`Parent finished before child started: ${JSON.stringify(session.messages)}`);})]);await session.abort();await run;
  const result=session.messages.find(message=>message.role==='toolResult' && message.toolName==='subagent_start');assert.ok(result && result.role==='toolResult',JSON.stringify(session.messages));assert.equal(result.isError,true);const payload=JSON.parse((result.content[0] as any).text);assert.match(payload.error,/abort/i);assert.ok(payload.id);phase='status';parentCalls=0;await session.prompt('Check status');const status=[...session.messages].reverse().find(message=>message.role==='toolResult' && message.toolName==='subagent_status');assert.ok(status && status.role==='toolResult' && !status.isError);assert.ok(JSON.parse((status.content[0] as any).text).some((entry:any)=>entry.id===payload.id));
 } finally {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

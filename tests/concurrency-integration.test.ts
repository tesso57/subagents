import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import extension from '../extensions/index.ts';

test('configured concurrency queues a child until a stopped child releases its slot', {timeout:10000}, async () => {
 const parent=mkdtempSync(join(tmpdir(),'subagent-limit-')),root=join(parent,'repository with trailing space '),agentDir=mkdtempSync(join(tmpdir(),'subagent-limit-cfg-'));mkdirSync(root);execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});mkdirSync(join(root,'nested'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','subagents.json'),JSON.stringify({maxConcurrent:1}));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const model:any={id:'fake',name:'fake',provider:'fake-limit',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};let firstStarted!:()=>void;const firstReady=new Promise<void>(resolve=>{firstStarted=resolve});const starts:string[]=[];
 const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:(_model:any,context:any,options:any)=>{const first=JSON.stringify(context).includes('FIRST_TASK');starts.push(first?'first':'second');const stream=createAssistantMessageEventStream();const finish=(aborted:boolean)=>{const message:any={role:'assistant',content:aborted?[]:[{type:'text',text:'second completed'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:aborted?'aborted':'stop',timestamp:Date.now()};if(aborted)stream.push({type:'error',reason:'aborted',error:message});else {stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});}stream.end();};if(first){firstStarted();if(options.signal.aborted)finish(true);else options.signal.addEventListener('abort',()=>finish(true),{once:true});}else queueMicrotask(()=>finish(false));return stream;}};
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);const ctx:any={cwd:join(root,'nested'),isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const call=async(name:string,params:any)=>{const result=await tools.get(name).execute('id',params,undefined,undefined,ctx);assert.notEqual(result.isError,true,result.content[0].text);return JSON.parse(result.content[0].text);};
 try {
  const first=await call('subagent_start',{agent:'worker',task:'FIRST_TASK',mode:'background',workspace:'shared'});await firstReady;
  const second=await call('subagent_start',{agent:'worker',task:'SECOND_TASK',mode:'background',workspace:'shared'});const status=await call('subagent_status',{});assert.equal(status.find((entry:any)=>entry.id===second.id).state,'queued');assert.deepEqual(starts,['first']);
  await call('subagent_stop',{id:first.id});const done=(await call('subagent_wait',{ids:[second.id]})).done[0];assert.equal(done.state,'completed');assert.equal(done.result,'second completed');assert.deepEqual(starts,['first','second']);
 } finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('rejects invalid concurrency settings before starting a child', async () => {
 const root=mkdtempSync(join(tmpdir(),'subagent-invalid-limit-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-invalid-limit-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};
 try {for(const invalid of [JSON.stringify({maxConcurrent:0}),'{invalid json']) {writeFileSync(join(root,'.pi','subagents.json'),invalid);const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);assert.equal(result.isError,true,result.content[0].text);assert.equal(JSON.parse(result.content[0].text).id,undefined);}}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

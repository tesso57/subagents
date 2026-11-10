import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import extension from '../extensions/index.ts';

test('stopped child reports a shutdown timeout after cancelling its question', {timeout:10000}, async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-stop-timeout-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-stop-timeout-cfg-'));
 execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});mkdirSync(join(root,'.pi','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nAsk the parent.');writeFileSync(join(root,'.pi','extensions','hang.js'),"export default pi => pi.on('session_shutdown', () => new Promise(() => {}));");
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>{const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[{type:'toolCall',id:'q',name:'contact_parent',arguments:{message:'Need help'}}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'toolUse',message});stream.end();});return stream;}};
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 const call=async(name:string,params:any)=>JSON.parse((await tools.get(name).execute('id',params,undefined,undefined,ctx)).content[0].text);
 try {const started=await call('subagent_start',{agent:'worker',task:'work',mode:'background',workspace:'shared'});const waiting=await call('subagent_wait',{ids:[started.id]});assert.equal(waiting.questions.length,1);await call('subagent_stop',{id:started.id});const done=(await call('subagent_wait',{ids:[started.id],cursor:waiting.cursor})).done[0];assert.equal(done.state,'stopped');assert.match(done.error,/shutdown timed out/);}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

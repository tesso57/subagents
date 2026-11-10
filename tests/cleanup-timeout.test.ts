import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import extension from '../extensions/index.ts';

test('preserves the execution error when child shutdown also times out', {timeout:10000}, async () => {
 const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const root=mkdtempSync(join(tmpdir(),'subagent-two-errors-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-two-errors-cfg-'));
 execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});mkdirSync(join(root,'.pi','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nDo work.');
 writeFileSync(join(root,'.pi','extensions','hang.js'),"export default pi => pi.on('session_shutdown', () => new Promise(() => {}));");
 const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const providerConfig:any={api:'openai-completions',apiKey:'fake',models:[model],streamSimple:()=>{const stream=createAssistantMessageEventStream();const message:any={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'error',errorMessage:'Provider request failed',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'error',reason:'error',error:message});stream.end();});return stream;}};
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model,modelRegistry:{getRegisteredProviderConfig:()=>providerConfig},thinkingLevel:'off'};
 try {const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'shared'},undefined,undefined,ctx);const done=JSON.parse(result.content[0].text).done[0];assert.equal(done.state,'failed');assert.match(done.error,/Provider request failed/);assert.match(done.error,/shutdown timed out/);}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFakeModel} from './helpers/fake-model.ts';
import {DefaultResourceLoader,createAgentSession,SessionManager} from '@earendil-works/pi-coding-agent';

test('Pi parent rejects worktree child when a loaded guard dependency differs', async () => {
 const root=mkdtempSync(join(tmpdir(),'guard-sdk-parent-')),agentDir=mkdtempSync(join(tmpdir(),'guard-sdk-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init');git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');mkdirSync(join(root,'.pi','agents'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({extensions:['../guard.js']}));
 writeFileSync(join(root,'guard.js'),"import {enabled} from './policy.js';export default function(pi){if(enabled)pi.on('tool_call',event=>event.toolName==='bash'?{block:true,reason:'guard'}:undefined);}");
 const policy=join(root,'policy.js');writeFileSync(policy,'export const enabled=false;');git('add','.');git('commit','-m','base');writeFileSync(policy,'export const enabled=true;');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const parent=createFakeModel([{content:[{type:'toolCall',id:'start',name:'subagent_start',arguments:{agent:'worker',task:'work',mode:'wait',workspace:'worktree'}}]},{content:[{type:'text',text:'done'}]}]);const model=parent.model;
 const loader=new DefaultResourceLoader({cwd:root,agentDir,additionalExtensionPaths:[new URL('../extensions/index.ts',import.meta.url).pathname]});await loader.reload();
 const {session}=await createAgentSession({cwd:root,agentDir,model,resourceLoader:loader,sessionManager:SessionManager.inMemory(root)});session.modelRuntime.hasConfiguredAuth=()=>true;
 session.agent.streamFunction=parent.stream;
 try {
  await session.bindExtensions({mode:'print'});
  const guard=await session.extensionRunner.emitToolCall({type:'tool_call',toolCallId:'probe',toolName:'bash',input:{command:'true'}});assert.equal(guard?.block,true);
  await session.prompt('Start a child');const result=session.messages.find(message=>message.role==='toolResult');assert.ok(result && result.role==='toolResult' && !result.isError,JSON.stringify(result));
  const payload=JSON.parse((result.content[0] as any).text);assert.equal(payload.done[0].state,'failed',JSON.stringify(payload));assert.match(payload.done[0].error,/extension.*differs/i);
 } finally {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('worktree child uses the same configured project guard as the Pi parent', async () => {
 const root=mkdtempSync(join(tmpdir(),'guard-sdk-parent-')),agentDir=mkdtempSync(join(tmpdir(),'guard-sdk-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init');git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');mkdirSync(join(root,'.pi','agents'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({extensions:['../guard.js']}));
 writeFileSync(join(root,'guard.js'),"import {enabled} from './policy.js';export default function(pi){if(enabled)pi.on('tool_call',event=>event.toolName==='bash'?{block:true,reason:'guard'}:undefined);}");
 const policy=join(root,'policy.js');writeFileSync(policy,'export const enabled=true;');git('add','.');git('commit','-m','base');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const parent=createFakeModel([{content:[{type:'toolCall',id:'start',name:'subagent_start',arguments:{agent:'worker',task:'work',mode:'wait',workspace:'worktree'}}]},{content:[{type:'text',text:'done'}]}]);const model=parent.model;
 const loader=new DefaultResourceLoader({cwd:root,agentDir,additionalExtensionPaths:[new URL('../extensions/index.ts',import.meta.url).pathname]});await loader.reload();
 const {session}=await createAgentSession({cwd:root,agentDir,model,resourceLoader:loader,sessionManager:SessionManager.inMemory(root)});session.modelRuntime.hasConfiguredAuth=()=>true;
 const child=createFakeModel([{content:[{type:'toolCall',id:'bash',name:'bash',arguments:{command:'true'}}]},{content:[{type:'text',text:'done'}]}]);
 session.modelRuntime.registerProvider('fake',{api:'openai-completions',apiKey:'fake',models:[model],streamSimple:child.stream});
 session.agent.streamFunction=parent.stream;
 try {
  await session.bindExtensions({mode:'print'});
  const guard=await session.extensionRunner.emitToolCall({type:'tool_call',toolCallId:'probe',toolName:'bash',input:{command:'true'}});assert.equal(guard?.block,true);
  await session.prompt('Start a child');const result=session.messages.find(message=>message.role==='toolResult');assert.ok(result && result.role==='toolResult' && !result.isError,JSON.stringify(result));
  const payload=JSON.parse((result.content[0] as any).text);assert.equal(payload.done[0].state,'completed',JSON.stringify(payload));assert.equal(child.requests.length,2);assert.match(JSON.stringify(child.requests[1]),/guard/,'child did not observe the guard blocking bash');
 } finally {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

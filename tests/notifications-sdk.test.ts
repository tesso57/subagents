import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Type} from 'typebox';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {DefaultResourceLoader,createAgentSession,SessionManager} from '@earendil-works/pi-coding-agent';
import {Notifications} from '../extensions/src/notifications.ts';

test('Pi persists a wait result when cancellation happens during a tool-result hook', {timeout:5000}, async () => {
 const cwd=mkdtempSync(join(tmpdir(),'notification-sdk-')),agentDir=mkdtempSync(join(tmpdir(),'notification-sdk-cfg-'));
 const delivered:string[]=[];const notifications=new Notifications(event=>delivered.push(event.type));let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve}),gate=new Promise<void>(resolve=>{release=resolve});let toolSignal:AbortSignal | undefined;
 const event={seq:1,id:'child',type:'completed'},snapshot={events:[event],questions:[],done:[{id:'child',state:'completed'}]};
 const loader=new DefaultResourceLoader({cwd,agentDir,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,extensionFactories:[{name:'test-wait',factory:pi=>{
  pi.registerTool({name:'test_wait',label:'Test wait',description:'Return a child event',parameters:Type.Object({}),async execute(_id,_params,signal){toolSignal=signal;notifications.notify(event);const result=await notifications.wait(async()=>snapshot,signal);return {content:[{type:'text',text:JSON.stringify(result)}],details:{}};}});
  pi.on('tool_result',async result=>{if(result.toolName==='test_wait'){enter();await gate;}});
 }}]});
 await loader.reload();const model:any={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://example.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:1000};
 const {session}=await createAgentSession({cwd,agentDir,model,resourceLoader:loader,sessionManager:SessionManager.inMemory(cwd)});session.modelRuntime.hasConfiguredAuth=()=>true;
 let calls=0;
 session.agent.streamFunction=(()=>{const stream=createAssistantMessageEventStream(),first=calls++===0;const message:any={role:'assistant',content:first?[{type:'toolCall',id:'wait',name:'test_wait',arguments:{}}]:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;}) as any;
 try {
  await session.bindExtensions({mode:'print'});assert.ok(session.getActiveToolNames().includes('test_wait'));const run=session.prompt('Wait for child');
  let timer:ReturnType<typeof setTimeout> | undefined;
  try {await Promise.race([entered,run.then(()=>{throw new Error('Run ended before hook');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Hook did not start')),1000);})]);}
  finally {if(timer)clearTimeout(timer);}
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(delivered,[]);assert.equal(session.messages.some(message=>message.role==='toolResult'),false);
  const aborted=session.abort();assert.equal(toolSignal?.aborted,true);release();await Promise.allSettled([run,aborted]);
  const result=session.messages.find(message=>message.role==='toolResult');assert.ok(result && result.role==='toolResult' && !result.isError,JSON.stringify(result));
  assert.match(JSON.stringify(result.content),/completed/);assert.deepEqual(delivered,[]);
 } finally {release();notifications.close();session.dispose();}
});

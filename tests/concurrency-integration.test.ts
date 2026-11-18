import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantMessageEventStream, type AssistantMessage, type StreamFunction} from '@earendil-works/pi-ai';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import extension from '../extensions/index.ts';
import {createMockPi} from './helpers/mock-pi.ts';
import {createFakeModel} from './helpers/fake-model.ts';

for (const ignoreAbort of [false, true]) {
 test(`configured concurrency retains the slot while a child ${ignoreAbort ? 'ignores abort' : 'responds to abort'}`, {timeout: 10_000}, async t => {
  const parent = mkdtempSync(join(tmpdir(), 'subagent-limit-'));
  const root = join(parent, 'repository with trailing space ');
  const agentDir = mkdtempSync(join(tmpdir(), 'subagent-limit-cfg-'));
  mkdirSync(root);
  execFileSync('git', ['init', root], {stdio:'ignore'});
  mkdirSync(join(root, '.pi', 'agents'), {recursive:true});
  mkdirSync(join(root, 'nested'), {recursive:true});
  writeFileSync(join(root, '.pi', 'agents', 'worker.md'), '---\nname: worker\ndescription: worker\n---\nWork.');
  writeFileSync(join(root, '.pi', 'subagents.json'), JSON.stringify({maxConcurrent:1}));

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const {model, stream: complete} = createFakeModel([{content:[{type:'text',text:'second completed'}]}]);
  let finishFirst: (() => void) | undefined;
  let firstSignal: AbortSignal | undefined;
  let ready!: () => void;
  const firstReady = new Promise<void>(resolve => { ready = resolve; });
  const starts: string[] = [];
  const streamSimple: StreamFunction = (model, context, options) => {
   const first = JSON.stringify(context).includes('FIRST_TASK');
   starts.push(first ? 'first' : 'second');
   if (!first) return complete(model, context, options);
   const stream = createAssistantMessageEventStream();
   const message: AssistantMessage = {
    role:'assistant', content:[], api:model.api, provider:model.provider, model:model.id,
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
    stopReason:'aborted', timestamp:Date.now(),
   };
   const finish = () => {
    stream.push({type:'error',reason:'aborted',error:message});
    stream.end();
   };
   finishFirst = finish;
   firstSignal = options?.signal;
   if (!ignoreAbort) firstSignal?.addEventListener('abort', finish, {once:true});
   ready();
   return stream;
  };
  const providerConfig = {api:model.api,apiKey:'fake',models:[model],streamSimple};
  const mock = createMockPi();
  Object.assign(mock.pi, {getActiveTools:()=>['read'],getAllTools:()=>[],sendMessage:()=>{}});
  extension(mock.pi);
  const ctx = {
   cwd:join(root, 'nested'), isProjectTrusted:()=>true, model,
   modelRegistry:{getRegisteredProviderConfig:()=>providerConfig}, thinkingLevel:'off',
  } as unknown as ExtensionToolContext;
  const call = async (name:string, params:Record<string,unknown>) => {
   const result = await mock.tools.get(name)!.execute('id', params, undefined, undefined, ctx);
   const item = result.content[0];
   assert.equal(item.type, 'text');
   assert.notEqual(result.isError, true, item.text);
   return JSON.parse(item.text);
  };
  const start = (task: string) => call('subagent_start', {agent:'worker',task,mode:'background',workspace:'shared'});

  try {
   const first = await start('FIRST_TASK');
   await firstReady;
   const second = await start('SECOND_TASK');
   assert.equal(second.state, 'queued');
   assert.deepEqual(starts, ['first']);

   if (ignoreAbort) t.mock.timers.enable({apis:['setTimeout']});
   await call('subagent_stop', {id:first.id});
   assert.equal(firstSignal?.aborted, true);
   if (ignoreAbort) {
    const waiting = call('subagent_wait', {ids:[first.id]});
    t.mock.timers.tick(11_000);
    const delayed = await waiting;
    assert.equal(delayed.stopDelayed[0]?.id, first.id);
    assert.equal(delayed.done.length, 0);
    const [stopping, queued] = await call('subagent_status', {});
    assert.equal(stopping.state, 'stopping');
    assert.equal(stopping.stopDelayed, true);
    assert.equal(queued.state, 'queued');
    assert.deepEqual(starts, ['first']);

    const finished = call('subagent_wait', {ids:[first.id],cursor:delayed.cursor});
    finishFirst!();
    assert.equal((await finished).done[0].state, 'stopped');
   }
   const done = (await call('subagent_wait', {ids:[second.id]})).done[0];
   assert.equal(done.state, 'completed');
   assert.equal(done.result, 'second completed');
   assert.deepEqual(starts, ['first','second']);
  } finally {
   finishFirst?.();
   await mock.emit('session_shutdown', {type:'session_shutdown',reason:'quit'});
   if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
   else process.env.PI_CODING_AGENT_DIR = previous;
  }
 });
}

test('rejects invalid concurrency settings before starting a child', async () => {
 const root=mkdtempSync(join(tmpdir(),'subagent-invalid-limit-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-invalid-limit-cfg-'));execFileSync('git',['init',root],{stdio:'ignore'});mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const mock=createMockPi();Object.assign(mock.pi,{getActiveTools:()=>['read'],getAllTools:()=>[],sendMessage:()=>{}});extension(mock.pi);const tools:Map<string,any>=mock.tools;const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};
 try {for(const invalid of [JSON.stringify({maxConcurrent:0}),'{invalid json']) {writeFileSync(join(root,'.pi','subagents.json'),invalid);const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'background',workspace:'shared'},undefined,undefined,ctx);assert.equal(result.isError,true,result.content[0].text);assert.equal(JSON.parse(result.content[0].text).id,undefined);}}
 finally {await mock.emit('session_shutdown',{type:'session_shutdown',reason:'quit'});if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

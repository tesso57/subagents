import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Coordinator } from '../src/coordinator.ts';

test('queues children at concurrency limit and starts the next after completion', async () => {
  const release: (() => void)[] = [];
  const starts: string[] = [];
  const c = new Coordinator(1, async (job) => { starts.push(job.id); await new Promise<void>(r => release.push(r)); return 'done'; });
  const a = c.start({agent:'a',task:'one'}), b = c.start({agent:'b',task:'two'});
  await new Promise(r => setImmediate(r));
  assert.deepEqual(starts, [a]);
  assert.equal(c.status(b).state, 'queued');
  release.shift()!();
  await c.wait([a]);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(starts, [a,b]);
  release.shift()!();
  await c.wait([b]);
});

test('waiting for a child ignores ordinary events and returns an outstanding question', async () => {
  let release!: () => void;
  const c = new Coordinator(1, async (job, _signal, manager) => {
    await new Promise<void>(r => { release = r; });
    return await manager.ask(job.id, 'Which option?');
  });
  const id = c.start({agent:'worker',task:'decide'});
  let finished = false;
  const waiting = c.wait([id]).then(r => { finished = true; return r; });
  await new Promise(r => setImmediate(r));
  assert.equal(finished,false);
  release();
  const result = await waiting;
  assert.equal(result.questions[0].message,'Which option?');
  c.reply(id,result.questions[0].requestId,'A');
  await new Promise(r => setImmediate(r));
  assert.equal(c.status(id).result,'A');
});

test('notifies parent about questions and terminal results', async () => {
 const notified:string[]=[];
 const c=new Coordinator(1,async (job,_s,m)=>{await m.ask(job.id,'help'); return 'finished';},e=>notified.push(e.type));
 const id=c.start({agent:'worker',task:'ask'});
 await new Promise(r=>setImmediate(r));
 const question=(await c.wait([id])).questions[0];
 c.reply(id,question.requestId,'yes');
 await new Promise(r=>setImmediate(r));
 assert.ok(notified.includes('question'));
 assert.ok(notified.includes('completed'));
});

test('steering a queued child preserves the instruction until it starts', async () => {
 let release!:()=>void; const received:string[]=[];
 const c=new Coordinator(1,async (job,_signal,manager)=>{
   if(job.agent==='first') await new Promise<void>(r=>{release=r});
   else received.push(...manager.takeSteering(job.id));
   return 'ok';
 });
 const a=c.start({agent:'first',task:'one'}); const b=c.start({agent:'second',task:'two'});
 c.steer(b,'new context');
 release(); await c.wait([a]); await new Promise(r=>setImmediate(r));
 assert.deepEqual(received,['new context']);
});

test('long results are truncated in wait and remain available for paging', async () => {
 const result='x'.repeat(30000);
 const c=new Coordinator(1,async()=>result);
 const id=c.start({agent:'worker',task:'large'});
 await new Promise(r=>setImmediate(r));
 const waited=await c.wait([id]);
 assert.ok(waited.done[0].result!.length < result.length);
 assert.equal(c.result(id,20000,10000).text,'x'.repeat(10000));
});

test('shutdown waits for running child cleanup before resolving', async () => {
 let cleaned=false, started!:()=>void;
 const ready=new Promise<void>(r=>{started=r});
 const c=new Coordinator(1,async(_job,signal)=>{
  started(); await new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true}));
  await new Promise(r=>setTimeout(r,20)); cleaned=true; return '';
 });
 c.start({agent:'worker',task:'work'}); await ready;
 await c.shutdown(); assert.equal(cleaned,true);
});

test('failed children retain partial output', async () => {
 const c=new Coordinator(1,async()=>{const e=new Error('provider failed') as Error & {partial:string};e.partial='partial investigation';throw e;});
 const id=c.start({agent:'worker',task:'work'});
 const result=await c.wait([id]);
 assert.equal(result.done[0].state,'failed');
 assert.equal(result.done[0].result,'partial investigation');
});

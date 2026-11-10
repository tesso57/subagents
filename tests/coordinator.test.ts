import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Coordinator } from '../extensions/src/coordinator.ts';

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

test('wait rejects an empty child list instead of hanging', async () => {
 const c=new Coordinator(1,async()=> 'ok');
 const signal=AbortSignal.timeout(100);
 await assert.rejects(c.wait([],0,signal),/at least one child/i);
});

test('wait rejects invalid or future event cursors', async () => {
 const c=new Coordinator(1,async()=> 'ok');
 const id=c.start({agent:'worker',task:'test'});
 for (const cursor of [-1,0.5,Number.NaN,10000]) await assert.rejects(c.wait([id],cursor),/cursor/i);
});

test('reports unconsumed instructions when a queued child is stopped', async () => {
 let release!:()=>void;
 const c=new Coordinator(1,async()=>{await new Promise<void>(r=>{release=r});return 'done';});
 const first=c.start({agent:'first',task:'work'}),queued=c.start({agent:'second',task:'work'});
 c.steer(queued,'Important direction');c.stop(queued);
 const result=await c.wait([queued]);
 const stopped=result.events.find(event=>event.id===queued && event.type==='stopped');
 assert.deepEqual((stopped?.data as any)?.unconsumedSteering,['Important direction']);
 release();await c.wait([first]);
});

test('shows stopping while an aborted child is still cleaning up', async () => {
 let finish!:()=>void;let ready!:()=>void;const started=new Promise<void>(r=>{ready=r});
 const c=new Coordinator(1,async(_job,signal)=>{ready();await new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true}));await new Promise<void>(r=>{finish=r;});return '';});
 const id=c.start({agent:'worker',task:'work'});await started;c.stop(id);
 assert.equal(c.status(id).state,'stopping');await new Promise(r=>setImmediate(r));finish();await c.wait([id]);assert.equal(c.status(id).state,'stopped');
});

test('terminal result preserves undelivered instructions even when its event is on a later page', async () => {
 let release!:()=>void;
 const c=new Coordinator(1,async()=>{await new Promise<void>(r=>{release=r});return 'done';});
 const first=c.start({agent:'blocker',task:'hold'});
 for(let i=0;i<60;i++) c.start({agent:'queued',task:String(i)});
 const last=c.start({agent:'queued',task:'last'});c.steer(last,'Important direction');c.stop(last);
 const result=await c.wait([last]);
 assert.equal(result.hasMore,true);
 assert.deepEqual(result.done[0].unconsumedSteering,['Important direction']);
 const shutdown=c.shutdown();release();await shutdown;
});

test('pages long results without splitting Unicode surrogate pairs', async () => {
 const full='a'.repeat(9999)+'🦊'+'z';const c=new Coordinator(1,async()=>full);const id=c.start({agent:'worker',task:'unicode'});await new Promise(r=>setImmediate(r));
 const first=c.result(id,0,10000);assert.equal(first.text.length,9999);assert.ok(first.text.endsWith('a'));assert.equal(first.next,9999);
 const second=c.result(id,first.next!,1);assert.equal(second.text,'🦊');assert.equal(second.next,10001);
 const last=c.result(id,second.next!,1);assert.equal(first.text+second.text+last.text,full);
 assert.throws(()=>c.result(id,10000,1),/surrogate|unicode/i);
 const waited=await c.wait([id]);const preview=waited.done[0].result!.split('\n[truncated')[0];assert.equal(preview.charCodeAt(preview.length-1),97);
});

test('pre-aborted wait does not return a completed result', async () => {
 const c=new Coordinator(1,async()=> 'done');const id=c.start({agent:'worker',task:'work'});await new Promise(r=>setImmediate(r));
 const controller=new AbortController();controller.abort();await assert.rejects(c.wait([id],0,controller.signal),/abort/i);
});

test('clears transient runtime credentials when children finish or queued work is stopped', async () => {
 let release!:()=>void;
 const c=new Coordinator(1,async(job)=>{if(job.agent==='first') await new Promise<void>(resolve=>{release=resolve});return 'done';});
 const first=c.start({agent:'first',task:'work',runtimeApiKey:'placeholder-first'});
 const queued=c.start({agent:'queued',task:'work',runtimeApiKey:'placeholder-queued'});
 c.stop(queued);
 assert.equal(c.status(queued).job.runtimeApiKey,undefined);
 release();await c.wait([first]);
 assert.equal(c.status(first).job.runtimeApiKey,undefined);
 const failed=new Coordinator(1,async()=>{throw new Error('startup failure');});
 const id=failed.start({agent:'worker',task:'work',runtimeApiKey:'placeholder-failed'});
 await failed.wait([id]);assert.equal(failed.status(id).job.runtimeApiKey,undefined);
});

test('a completed child and another child question remain visible across separate waits', async () => {
 let finish!:()=>void;
 const c=new Coordinator(2,async(job,_signal,manager)=>{
  if(job.agent==='asking') return await manager.ask(job.id,'Need a decision');
  await new Promise<void>(resolve=>{finish=resolve});return 'Completed work';
 });
 const asking=c.start({agent:'asking',task:'ask'}),working=c.start({agent:'working',task:'work'});
 const first=await c.wait([working]);
 assert.equal(first.questions[0].id,asking);assert.equal(first.done.length,0);
 finish();
 await new Promise(resolve=>setImmediate(resolve));
 const second=await c.wait([working],first.cursor);
 assert.equal(second.done[0].result,'Completed work');assert.equal(second.questions[0].id,asking);
 c.reply(asking,second.questions[0].requestId,'Use option A');
 const third=await c.wait([asking],second.cursor);
 assert.equal(third.done[0].result,'Use option A');
});

test('keeps a child waiting until all parallel questions have been answered', async () => {
 const c=new Coordinator(1,async(job,_signal,manager)=>{
  const answers=await Promise.all([manager.ask(job.id,'First?'),manager.ask(job.id,'Second?')]);
  return answers.join(', ');
 });
 const id=c.start({agent:'worker',task:'ask in parallel'});
 const waiting=await c.wait([id]);
 assert.equal(waiting.questions.length,2);
 c.reply(id,waiting.questions[1].requestId,'B');
 assert.equal(c.status(id).state,'waiting_for_parent');
 c.reply(id,waiting.questions[0].requestId,'A');
 const result=await c.wait([id],waiting.cursor);
 assert.equal(result.done[0].result,'A, B');
});

test('stopping a child cancels every parallel question', async () => {
 const c=new Coordinator(1,async(job,_signal,manager)=>{
  await Promise.all([manager.ask(job.id,'First?'),manager.ask(job.id,'Second?')]);return 'unexpected';
 });
 const id=c.start({agent:'worker',task:'ask in parallel'});
 const waiting=await c.wait([id]);assert.equal(waiting.questions.length,2);
 c.stop(id);
 const stopped=await c.wait([id],waiting.cursor);
 assert.equal(stopped.done[0].state,'stopped');assert.equal(stopped.questions.length,0);
 assert.equal(stopped.events.filter(event=>event.type==='question_cancelled').length,2);
});

test('returns the retained worktree with a completed child result', async () => {
 const worktree={path:'/tmp/example-worktree',branch:'subagents/example',base:'example-base'};
 const c=new Coordinator(1,async(job)=>{job.worktree=worktree;return 'done';});
 const id=c.start({agent:'worker',task:'work'});const result=await c.wait([id]);
 assert.deepEqual(result.done[0].worktree,worktree);
});

test('returns retained worktrees for failed and stopped children', async () => {
 const worktree={path:'/tmp/example-worktree',branch:'subagents/example',base:'example-base'};
 const failed=new Coordinator(1,async(job)=>{job.worktree=worktree;throw new Error('failed after creation');});const failedId=failed.start({agent:'worker',task:'work'});const failedResult=await failed.wait([failedId]);assert.equal(failedResult.done[0].state,'failed');assert.deepEqual(failedResult.done[0].worktree,worktree);
 const stopped=new Coordinator(1,async(job,signal)=>{job.worktree=worktree;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return '';});const stoppedId=stopped.start({agent:'worker',task:'work'});stopped.stop(stoppedId);const stoppedResult=await stopped.wait([stoppedId]);assert.equal(stoppedResult.done[0].state,'stopped');assert.deepEqual(stoppedResult.done[0].worktree,worktree);
});

test('routes parallel questions to the correct child when another child stops', async () => {
 const c=new Coordinator(2,async(job,_signal,manager)=>{
  const answers=await Promise.all([manager.ask(job.id,`${job.agent} first`),manager.ask(job.id,`${job.agent} second`)]);return answers.join(', ');
 });
 const first=c.start({agent:'first',task:'work'}),second=c.start({agent:'second',task:'work'});
 const snapshot=await c.wait([first,second]);assert.equal(snapshot.questions.length,4);
 const firstQuestions=snapshot.questions.filter(q=>q.id===first),secondQuestions=snapshot.questions.filter(q=>q.id===second);
 assert.throws(()=>c.reply(second,firstQuestions[0].requestId,'wrong child'),/no longer pending/i);
 c.reply(first,firstQuestions[0].requestId,'A');assert.equal(c.status(first).state,'waiting_for_parent');
 c.stop(second);assert.throws(()=>c.reply(second,secondQuestions[0].requestId,'too late'),/no longer pending/i);
 c.reply(first,firstQuestions[1].requestId,'B');
 const firstDone=(await c.wait([first],snapshot.cursor)).done[0],secondDone=(await c.wait([second],snapshot.cursor)).done[0];
 assert.equal(firstDone.state,'completed');assert.equal(firstDone.result,'A, B');assert.equal(secondDone.state,'stopped');
});

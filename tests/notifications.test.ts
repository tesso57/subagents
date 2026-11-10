import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Notifications } from '../extensions/src/notifications.ts';

test('delivers events that occur after a wait snapshot was taken', async () => {
 const delivered:string[]=[];
 const n=new Notifications(event=>delivered.push(event.type));
 const snapshot={events:[],questions:[{id:'a',requestId:'q',message:'help'}],done:[],cursor:0,hasMore:false};
 const wait=n.wait(async()=>snapshot);
 n.notify({seq:1,id:'b',type:'stopped'});
 assert.equal((await wait).done.length,0);
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(delivered,['stopped']);
});

test('suppresses notifications only for events included in the wait result', async () => {
 const delivered:string[]=[];
 const n=new Notifications(event=>delivered.push(event.type));
 const wait=n.wait(async()=>({events:[],questions:[],done:[{id:'b',state:'completed'}],cursor:0,hasMore:false}));
 n.notify({seq:1,id:'b',type:'completed'});
 await wait; await new Promise(r=>setImmediate(r));
 assert.deepEqual(delivered,[]);
});

test('does not notify an obsolete question after the child terminates', async () => {
 const delivered:string[]=[]; const n=new Notifications(event=>delivered.push(event.type));
 n.notify({seq:1,id:'a',type:'question',data:{requestId:'q',message:'help'}});
 n.notify({seq:2,id:'a',type:'stopped'});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(delivered,['stopped']);
});

test('suppresses a terminal notification returned in another child wait event page', async () => {
 const delivered:string[]=[];const n=new Notifications(event=>delivered.push(event.type));
 const event={seq:1,id:'b',type:'completed'}; n.notify(event);
 await n.wait(async()=>({events:[event],questions:[],done:[{id:'a',state:'completed'}]}));
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(delivered,[]);
});

test('does not notify a question that has already been answered', async () => {
 const delivered:string[]=[];const n=new Notifications(event=>delivered.push(event.type));
 n.notify({seq:1,id:'a',type:'question',data:{requestId:'q',message:'help'}});
 n.notify({seq:2,id:'a',type:'answered',data:{requestId:'q'}});
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(delivered,[]);
});

test('does not deliver a cancelled question while child cleanup is running', async () => {
 const {Coordinator}=await import('../extensions/src/coordinator.ts');const delivered:string[]=[];
 const n=new Notifications(event=>delivered.push(event.type));let finish!:()=>void;
 const c=new Coordinator(1,async(job,_signal,manager)=>{try {await manager.ask(job.id,'Need decision');} catch {await new Promise<void>(r=>{finish=r;});}return '';},event=>n.notify(event));
 const id=c.start({agent:'worker',task:'work'});c.stop(id);
 await new Promise(r=>setImmediate(r));assert.ok(!delivered.includes('question'));
 finish();await c.wait([id]);n.close();
});

test('preserves a notification when the waiting call is cancelled before delivery', async () => {
 const delivered:string[]=[];const n=new Notifications(event=>delivered.push(event.type));const controller=new AbortController();
 const event={seq:1,id:'a',type:'completed'};n.notify(event);
 const waiting=n.wait(async()=>({events:[event],questions:[],done:[{id:'a',state:'completed'}]}),controller.signal);
 controller.abort();await assert.rejects(waiting,/abort/i);await new Promise(r=>setImmediate(r));
 assert.deepEqual(delivered,['completed']);
});

test('delivers a notification when cancellation follows the wait snapshot in a microtask', async () => {
 const delivered:string[]=[];const n=new Notifications(event=>delivered.push(event.type));const controller=new AbortController();
 const event={seq:1,id:'a',type:'completed'};n.notify(event);
 const waiting=n.wait(async()=>({events:[event],questions:[],done:[{id:'a',state:'completed'}]}),controller.signal);
 queueMicrotask(()=>controller.abort());await waiting;await new Promise(r=>setImmediate(r));
 assert.deepEqual(delivered,['completed']);
});

test('suppresses a notification when another waiter receives it without cancellation', async () => {
 const delivered:string[]=[];const n=new Notifications(event=>delivered.push(event.type));const controller=new AbortController();
 const event={seq:1,id:'a',type:'completed'};const snapshot={events:[event],questions:[],done:[{id:'a',state:'completed'}]};n.notify(event);
 const first=n.wait(async()=>snapshot,controller.signal),second=n.wait(async()=>snapshot);await Promise.all([first,second]);controller.abort();await new Promise(r=>setImmediate(r));
 assert.deepEqual(delivered,[]);
});

test('notifies unreported terminal events beyond a full page when another waiter is cancelled', async () => {
 const {Coordinator}=await import('../extensions/src/coordinator.ts');const delivered:string[]=[];const notifications=new Notifications(event=>delivered.push(event.id));let release!:()=>void;
 const c=new Coordinator(1,async()=>{await new Promise<void>(resolve=>{release=resolve;});return 'done';},event=>notifications.notify(event));
 c.start({agent:'blocker',task:'wait'});const ids:string[]=[];for(let i=0;i<60;i++){const id=c.start({agent:'worker',task:String(i)});ids.push(id);c.stop(id);}
 const last=ids.at(-1)!,controller=new AbortController();const cancelled=notifications.wait(()=>c.wait([last],0,controller.signal),controller.signal);controller.abort();await assert.rejects(cancelled,/abort/i);
 const snapshot=await notifications.wait(()=>c.wait([last]));assert.equal(snapshot.hasMore,true);
 const reported=new Set([...snapshot.events.filter(event=>event.type==='stopped').map(event=>event.id),...snapshot.done.map(done=>done.id)]);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(delivered.sort(),ids.filter(id=>!reported.has(id)).sort());
 const shutdown=c.shutdown();release();await shutdown;notifications.close();
});

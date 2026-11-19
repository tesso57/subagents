import type { Event } from './coordinator.ts';

type Snapshot = {
  events: Array<{seq:number}>;
  questions: Array<{id:string; requestId:string}>;
  done: Array<{id:string; state:string}>;
  stopDelayed?: Array<{id:string; seq:number}>;
};

export class Notifications {
  private pending = new Map<number, {event:Event; timer:ReturnType<typeof setImmediate>; acknowledgements:Array<AbortSignal | undefined>}>();
  private closed = false;
  private deliver: (event:Event)=>void;
  constructor(deliver:(event:Event)=>void) { this.deliver=deliver; }

  notify(event:Event) {
    if (this.closed) return;
    const terminal = ['completed','failed','stopped'].includes(event.type);
    if (terminal || ['answered','question_cancelled'].includes(event.type)) {
      for (const [seq, pending] of this.pending) {
        if (pending.event.id!==event.id) continue;
        if (terminal && pending.event.type==='stop_delayed') {
          clearImmediate(pending.timer); this.pending.delete(seq);
          continue;
        }
        if (pending.event.type!=='question') continue;
        const questionId=(pending.event.data as {requestId?:unknown} | undefined)?.requestId;
        const answerId=(event.data as {requestId?:unknown} | undefined)?.requestId;
        if (terminal || (questionId!==undefined && questionId===answerId)) { clearImmediate(pending.timer); this.pending.delete(seq); }
      }
    }
    if (!terminal && !['question','stop_delayed'].includes(event.type)) return;
    const acknowledgements:Array<AbortSignal | undefined>=[];
    const timer=setImmediate(()=>{
      this.pending.delete(event.seq);
      const received=acknowledgements.some(signal=>!signal || !signal.aborted);
      if (!this.closed && !received) { try { this.deliver(event); } catch {   } }
    });
    this.pending.set(event.seq,{event,timer,acknowledgements});
  }

  async wait<T extends Snapshot>(run:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
    const result=await run();
    if (signal?.aborted) throw new Error('Wait aborted');
    for (const [seq,{event,acknowledgements}] of this.pending) {
      const requestId=event.type==='question' && event.data && typeof event.data==='object' && 'requestId' in event.data ? event.data.requestId : undefined;
      const included=result.events.some(e=>e.seq===seq) || result.stopDelayed?.some(d=>d.seq===seq) || (event.type==='question'
        ? result.questions.some(q=>q.id===event.id && q.requestId===requestId)
        : result.done.some(d=>d.id===event.id && d.state===event.type));
      if (included) acknowledgements.push(signal);
    }
    return result;
  }

  close() {
    this.closed=true;
    for (const {timer} of this.pending.values()) clearImmediate(timer);
    this.pending.clear();
  }
}

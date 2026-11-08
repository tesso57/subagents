import { randomUUID } from 'node:crypto';

export type Job = { id: string; agent: string; task: string; [key: string]: unknown };
export type State = 'queued' | 'starting' | 'running' | 'waiting_for_parent' | 'completed' | 'failed' | 'stopped';
export type Entry = { job: Job; state: State; result?: string; error?: string; controller: AbortController };
export type Event = { seq: number; id: string; type: string; data?: unknown };
export type Runner = (job: Job, signal: AbortSignal, coordinator: Coordinator) => Promise<string>;

export class Coordinator {
  private jobs = new Map<string, Entry>();
  private queue: string[] = [];
  private listeners = new Set<() => void>();
  private events: Event[] = [];
  private pending = new Map<string, { id: string; message: string; resolve: (value: string) => void; reject: (error: Error) => void }>();
  private steering = new Map<string, string[]>();
  private active = 0;
  private closed = false;
  private limit: number;
  private runner: Runner;
  private notify?: (event: Event) => void;
  constructor(limit: number, runner: Runner, notify?: (event: Event) => void) {
    this.limit = limit; this.runner = runner; this.notify = notify;
    if (!Number.isInteger(limit) || limit < 1) throw new Error('maxConcurrent must be a positive integer');
  }
  start(input: { agent: string; task: string; [key: string]: unknown }): string {
    if (this.closed) throw new Error('coordinator is closed');
    const id = randomUUID(), job = { ...input, id } as Job;
    this.jobs.set(id, { job, state: 'queued', controller: new AbortController() });
    this.queue.push(id); this.emit(id, 'queued'); this.pump(); return id;
  }
  status(id: string): Entry {
    const e = this.jobs.get(id); if (!e) throw new Error(`Unknown child: ${id}`); return e;
  }
  list() { return [...this.jobs.values()].map(({ job, state, result, error }) => ({ id:job.id, agent:job.agent, state, resultAvailable: result !== undefined, error, worktree:job.worktree })); }
  result(id: string, offset = 0, limit = 10000) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid result range');
    const result = this.status(id).result; if (result === undefined) throw new Error('Result not available');
    return { text:result.slice(offset,offset+limit), offset, total:result.length, next:offset+limit<result.length?offset+limit:null };
  }
  private emit(id: string, type: string, data?: unknown) {
    const event = { seq: this.events.length + 1, id, type, data };
    this.events.push(event);
    for (const f of [...this.listeners]) f();
    try { if (!this.closed) this.notify?.(event); } catch { /* notification is a hint; events remain available */ }
  }
  private pump() {
    while (!this.closed && this.active < this.limit && this.queue.length) {
      const id = this.queue.shift()!, e = this.status(id); if (e.state !== 'queued') continue;
      this.active++; e.state = 'starting'; this.emit(id, 'starting');
      void (async () => {
        try {
          e.state = 'running'; this.emit(id, 'running');
          e.result = await this.runner(e.job, e.controller.signal, this);
          e.state = e.controller.signal.aborted ? 'stopped' : 'completed';
        } catch (err) {
          e.state = e.controller.signal.aborted ? 'stopped' : 'failed';
          e.error = err instanceof Error ? err.message : String(err);
          if (err && typeof err === 'object' && 'partial' in err && typeof err.partial === 'string') e.result=err.partial;
        } finally {
          for (const [key, p] of this.pending) if (p.id === id) { this.pending.delete(key); p.reject(new Error('Child stopped before reply')); }
          this.active--; this.emit(id, e.state, { resultAvailable: e.result !== undefined, error: e.error, unconsumedSteering: this.takeSteering(id) }); this.pump();
        }
      })();
    }
  }
  ask(id: string, message: string): Promise<string> {
    const e = this.status(id); if (e.state !== 'running') throw new Error('Child is not running');
    const requestId = randomUUID(); e.state = 'waiting_for_parent';
    return new Promise((resolve, reject) => { this.pending.set(requestId, { id, message, resolve, reject }); this.emit(id, 'question', { requestId, message }); });
  }
  reply(id: string, requestId: string, answer: string) {
    const p = this.pending.get(requestId); if (!p || p.id !== id) throw new Error('Question is no longer pending');
    this.pending.delete(requestId); this.status(id).state = 'running'; p.resolve(answer); this.emit(id, 'answered', { requestId });
  }
  steer(id: string, message: string) {
    const e = this.status(id);
    if (!["queued", "starting", "running", "waiting_for_parent"].includes(e.state)) throw new Error("Child has already finished");
    const pending = this.steering.get(id) ?? []; pending.push(message); this.steering.set(id,pending);
    return { delivery: "queued" };
  }
  takeSteering(id: string) { const pending = this.steering.get(id) ?? []; this.steering.delete(id); return pending; }
  stop(id: string) {
    const e = this.status(id);
    if (['completed','failed','stopped'].includes(e.state)) return;
    e.controller.abort();
    if (e.state === 'queued') { e.state = 'stopped'; this.emit(id, 'stopped'); }
    for (const [key, p] of this.pending) if (p.id === id) { this.pending.delete(key); p.reject(new Error('Child stopped')); }
  }
  async wait(ids: string[], cursor = 0, signal?: AbortSignal) {
    ids.forEach(id => this.status(id));
    for (;;) {
      const questions = [...this.pending].map(([requestId, p]) => ({ requestId, id:p.id, message:p.message }));
      const events = this.events.filter(e => e.seq > cursor).slice(0, 50);
      const done = ids.map(id => this.status(id)).filter(e => ['completed','failed','stopped'].includes(e.state)).map(e => ({ id:e.job.id, state:e.state, result:e.result?.length && e.result.length > 10000 ? `${e.result.slice(0,10000)}\n[truncated; use subagent_result]` : e.result, error:e.error }));
      if (questions.length || done.length) return { events, questions, done, cursor: events.at(-1)?.seq ?? cursor, hasMore: (events.at(-1)?.seq ?? cursor) < this.events.length };
      if (signal?.aborted) throw new Error('Wait aborted');
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { this.listeners.delete(wake); signal?.removeEventListener('abort', abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(new Error('Wait aborted')); };
        this.listeners.add(wake); signal?.addEventListener('abort', abort, { once:true });
        if (signal?.aborted) abort();
      });
    }
  }
  async shutdown() {
    this.closed = true; for (const id of this.jobs.keys()) this.stop(id);
    while (this.active > 0) await new Promise<void>(resolve => { const wake=()=>{this.listeners.delete(wake); resolve();}; this.listeners.add(wake); });
  }
}

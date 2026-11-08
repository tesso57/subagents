import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { loadAgent } from './src/agents.ts';
import { Coordinator } from './src/coordinator.ts';
import { createChildSession } from './src/child.ts';
import { git, prepareWorktree, repositoryRoot, checkProjectResources } from './src/worktree.ts';
import { explicitExtensions, explicitSkills, cliDisabled, mapWorktreeExtensions, mapWorktreeSkills } from './src/inheritance.ts';

const text = (data:unknown) => ({content:[{type:'text' as const,text:JSON.stringify(data)}],details:{}});
export default function extension(pi:ExtensionAPI) {
  let coordinator:Coordinator | undefined;
  const sessions = new Map<string, Awaited<ReturnType<typeof createChildSession>>>();
  const manager = (ctx:ExtensionContext) => {
    if (coordinator) return coordinator;
    let limit=4;
    let configRoot=ctx.cwd;
    try { configRoot=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:ctx.cwd,encoding:'utf8'}).trim(); } catch {}
    try { const cfg=JSON.parse(readFileSync(join(configRoot,'.pi','subagents.json'),'utf8')); if (cfg.maxConcurrent !== undefined) limit=cfg.maxConcurrent; }
    catch (e:any) { if (e.code !== 'ENOENT') throw e; }
    coordinator = new Coordinator(limit, async (job,signal,c) => {
      const agent=job.definition as ReturnType<typeof loadAgent>;
      const root=job.root as string;
      let cwd=job.cwd as string;
      let extraExtensions=job.extraExtensions as string[];
      let extraSkills=job.extraSkills as string[];
      if (job.workspace === 'worktree') {
        await checkProjectResources(root,job.base as string);
        const result=await prepareWorktree(root,job.id,job.base as string); cwd=join(result.path,relative(root,cwd));
        job.worktree=result;
        extraExtensions=mapWorktreeExtensions(root,result.path,extraExtensions);
        extraSkills=mapWorktreeSkills(root,result.path,extraSkills);
        const worktreeDefinition=loadAgent(result.path, agent.name);
        if (worktreeDefinition.contents !== agent.contents) throw new Error(`Worktree agent definition differs from requested definition; retained ${cwd}`);
      }
      const model = job.model as any;
      if (signal.aborted) throw new Error('Aborted before starting');
      const child=await createChildSession({cwd,prompt:agent.prompt,model,thinkingLevel:job.thinkingLevel,tools:agent.tools,requiredTools:job.parentTools as string[],extraExtensions,providerConfig:job.providerConfig,signal,noExtensions:job.noExtensions as boolean,noSkills:job.noSkills as boolean,extraSkills,ask:message=>c.ask(job.id,message)});
      sessions.set(job.id,child);
      const abort=()=>{void child.session.abort();}; signal.addEventListener('abort',abort,{once:true});
      try {
        if (signal.aborted) throw new Error('Aborted before prompt');
        const pending = c.takeSteering(job.id);
        await child.session.prompt([job.task,...pending.map(m=>`Additional instruction: ${m}`)].join("\n\n"));
        const last=[...child.session.messages].reverse().find(m=>m.role==='assistant');
        if (last?.role==='assistant' && (last.stopReason==='error' || last.stopReason==='aborted')) throw new Error(last.errorMessage || last.stopReason);
        return child.session.getLastAssistantText() ?? '';
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        Object.assign(failure,{partial:child.session.getLastAssistantText() ?? ''});
        throw failure;
      } finally { signal.removeEventListener('abort',abort); sessions.delete(job.id); await child.dispose(); }
    }, event => {
      if (["question", "completed", "failed", "stopped"].includes(event.type)) {
        pi.sendMessage({customType:"subagents-event",content:`Subagent ${event.id} ${event.type}. Call subagent_status or subagent_wait for details.`,display:false}, {triggerTurn:true,deliverAs:"followUp"});
      }
    });
    return coordinator;
  };
  const safe = async (fn:()=>Promise<unknown>|unknown) => { try {return text(await fn());} catch(e) {return {...text({error:e instanceof Error?e.message:String(e)}),isError:true};} };
  pi.registerTool({name:'subagent_start',label:'Start subagent',description:'Start a project agent. Choose background or wait and shared or worktree explicitly.',parameters:Type.Object({agent:Type.String(),task:Type.String(),mode:Type.Union([Type.Literal('background'),Type.Literal('wait')]),workspace:Type.Union([Type.Literal('shared'),Type.Literal('worktree')])}),
    async execute(_id,p,signal,_update,ctx) { return safe(async()=>{
      const root=await repositoryRoot(ctx.cwd), definition=loadAgent(root,p.agent);
      let model=ctx.model;
      if (definition.model) {
        const matches=ctx.modelRegistry.getAll().filter(m=>`${m.provider}/${m.id}`===definition.model || m.id===definition.model);
        if(matches.length!==1) throw new Error(`Model ${definition.model} not found or ambiguous`);
        model=matches[0];
      }
      const base=p.workspace==='worktree' ? await git(root,'rev-parse','HEAD') : undefined;
      const dirty=base ? await git(root,'status','--short','--untracked-files=all') : '';
      const warning=dirty ? `Uncommitted changes are not included in the worktree base:\n${dirty.slice(0,4000)}` : undefined;
      if (base) { await checkProjectResources(root); const fromBase=await git(root,'show',`${base}:${relative(root,definition.path)}`); if (fromBase.trimEnd()!==definition.contents.trimEnd()) throw new Error('Agent definition differs from committed base'); }
      const parentTools=pi.getActiveTools().filter(name=>!name.startsWith('subagent_'));
      const extraExtensions=[...new Set([...explicitExtensions(process.argv,process.cwd()),...pi.getAllTools().filter(tool=>parentTools.includes(tool.name) && tool.sourceInfo?.scope==='temporary').map(tool=>tool.sourceInfo.path).filter(path=>path && !path.startsWith('builtin:') && !path.startsWith('<'))])];
      const c=manager(ctx), id=c.start({agent:p.agent,task:p.task,root,cwd:ctx.cwd,definition,base,workspace:p.workspace,model,providerConfig:model ? ctx.modelRegistry.getRegisteredProviderConfig(model.provider) : undefined,thinkingLevel:ctx.thinkingLevel,parentTools,extraExtensions,extraSkills:explicitSkills(process.argv,process.cwd()),noExtensions:cliDisabled(process.argv,'--no-extensions','-ne'),noSkills:cliDisabled(process.argv,'--no-skills','-ns')});
      if (p.mode==='background') return {id,state:c.status(id).state,warning};
      try {return {id,warning,...await c.wait([id],0,signal)};} catch(e) {c.stop(id); throw e;}
    }); }});
  pi.registerTool({name:'subagent_wait',label:'Wait for subagents',description:'Wait for completion or a question from any child; preserve the returned cursor.',parameters:Type.Object({ids:Type.Array(Type.String()),cursor:Type.Optional(Type.Number())}),async execute(_id,p,signal,_u,ctx){return safe(()=>manager(ctx).wait(p.ids,p.cursor??0,signal));}});
  pi.registerTool({name:'subagent_result',label:'Read subagent result',description:'Read a page of a completed child result.',parameters:Type.Object({id:Type.String(),offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:10000}))}),async execute(_id,p,_s,_u,ctx){return safe(()=>manager(ctx).result(p.id,p.offset,p.limit));}});
  pi.registerTool({name:'subagent_status',label:'Subagent status',description:'Inspect child states and retained worktrees.',parameters:Type.Object({}),async execute(_id,_p,_s,_u,ctx){return safe(()=>manager(ctx).list());}});
  pi.registerTool({name:'subagent_steer',label:'Steer subagent',description:'Queue an instruction for a running child; queued is not proof the model consumed it.',parameters:Type.Object({id:Type.String(),message:Type.String()}),async execute(_id,p,_signal,_u,ctx){return safe(async()=>{const s=sessions.get(p.id);if(!s) return manager(ctx).steer(p.id,p.message);return {delivery:await s.session.steer(p.message)};});}});
  pi.registerTool({name:'subagent_reply',label:'Reply to subagent',description:'Reply to a child question using its request id.',parameters:Type.Object({id:Type.String(),requestId:Type.String(),answer:Type.String()}),async execute(_id,p,_s,_u,ctx){return safe(()=>{manager(ctx).reply(p.id,p.requestId,p.answer);return {ok:true};});}});
  pi.registerTool({name:'subagent_stop',label:'Stop subagent',description:'Request a child stop; check status for completion.',parameters:Type.Object({id:Type.String()}),async execute(_id,p,_s,_u,ctx){return safe(()=>{manager(ctx).stop(p.id);return {requested:true};});}});
  pi.on('session_shutdown',async()=>{
    const cleanup=coordinator?.shutdown() ?? Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([cleanup,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out waiting for child aborts')),5000);})]); }
    finally { if(timer) clearTimeout(timer); }
  });
}

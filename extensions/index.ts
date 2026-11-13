import { Type } from 'typebox';
import { getAgentDir, loadProjectContextFiles, type ExtensionAPI, type ExtensionContext, type Skill } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { loadAgent } from './src/agents.ts';
import { Coordinator } from './src/coordinator.ts';
import { Notifications } from './src/notifications.ts';
import { captureRuntimeSkills, mapRuntimeSkills, mapParentSkills, inferBaselineSkillVisibility, inferParentSkillVisibility, type ParentSkill } from './src/skills.ts';
import { configuredProjectExtensions, snapshotProjectExtensions, assertSameProjectExtensions } from './src/resources.ts';
import { validateExtensionGraph, type ExtensionGraph } from './src/extension-graph.ts';
import { assertEffectiveParentPrompt, assertParentPrompts, captureCustomPromptSections, hasOpaqueSystemContent, replayPromptSections, mapContextFiles, type ContextFile } from './src/parent-prompts.ts';
import { createChildSession, isMcpTool, lastAvailableAssistantText } from './src/child.ts';
import { git, prepareWorktree, repositoryRoot, checkProjectResources, validateWorktreeSkillLinks, worktreeCwd, WorktreeCreationError, stripGitTerminator } from './src/worktree.ts';
import { explicitExtensions, explicitSkills, snapshotSystemPrompts, snapshotDiscoveredSystemPrompts, cliDisabled, mapWorktreeExtensions, mapWorktreeSkills, runtimeApiKeyForChild } from './src/inheritance.ts';

const text = (data:unknown) => ({content:[{type:'text' as const,text:JSON.stringify(data)}],details:{}});
class StartedSubagentError extends Error {
  readonly id:string;
  constructor(message:string,id:string) {super(message);this.id=id;}
}
function mcpFingerprint(cwd:string,agentDir:string):string {
  const digest=createHash('sha256');
  for (const path of [join(agentDir,'mcp.json'),join(cwd,'.pi','mcp.json')]) {
    try {const data=readFileSync(path);digest.update('present:').update(String(data.length)).update(':').update(data);}
    catch(error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') digest.update('missing');else throw new Error('Cannot read MCP configuration');}
    digest.update('\0');
  }
  for (const path of [join(agentDir,'settings.json'),join(cwd,'.pi','settings.json')]) {
    try {
      const settings=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
      digest.update(JSON.stringify(settings?.extensions ?? []));
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') digest.update('[]');
      else throw new Error('Cannot read MCP-related settings');
    }
    digest.update('\0');
  }
  return digest.digest('hex');
}
export default function extension(pi:ExtensionAPI) {
  const cliParentPrompts=snapshotSystemPrompts(process.argv);
  let parentPrompts:(ReturnType<typeof snapshotDiscoveredSystemPrompts> & {contextFiles:ContextFile[]}) | undefined;
  let parentPromptSections:Record<string,string> | undefined;
  let parentOpaqueSystemContent=false;
  let parentObservedSystemMessages:Parameters<typeof replayPromptSections>[0] | undefined;
  let parentRunPromptOptions:{sections:Record<string,string>;customPrompt?:string;appendSystemPrompt:string;contextFiles:ContextFile[];skills:Skill[]} | undefined;
  let parentBaselineSkills:ParentSkill[] | undefined;
  let parentExtensionSnapshot:Promise<{value?:Awaited<ReturnType<typeof snapshotProjectExtensions>>;error?:unknown}> | undefined;
  let parentMcpSnapshot:{cwd:string;value?:string} | undefined;
  const captureExtensions=async (cwd:string,trusted:boolean):Promise<{value?:Awaited<ReturnType<typeof snapshotProjectExtensions>>;error?:unknown}> => {
    const agentDir=getAgentDir(),explicit=explicitExtensions(process.argv,process.cwd()),includeConfigured=!cliDisabled(process.argv,'--no-extensions');
    try {const root=await repositoryRoot(cwd);return {value:await snapshotProjectExtensions(cwd,agentDir,trusted,root,explicit,includeConfigured)};}
    catch(error) {return {error};}
  };
  const captureParentPrompts=(ctx:ExtensionContext)=>({
    ...snapshotDiscoveredSystemPrompts(ctx.cwd,getAgentDir(),ctx.isProjectTrusted(),cliParentPrompts),
    contextFiles:cliDisabled(process.argv,'--no-context-files') ? [] : loadProjectContextFiles({cwd:ctx.cwd,agentDir:getAgentDir()}),
  });
  pi.on('session_start',async (_event,ctx)=>{
    try {parentMcpSnapshot={cwd:ctx.cwd,value:mcpFingerprint(ctx.cwd,getAgentDir())};} catch {parentMcpSnapshot={cwd:ctx.cwd};}
    parentPrompts=captureParentPrompts(ctx);parentPromptSections=undefined;parentOpaqueSystemContent=false;parentObservedSystemMessages=undefined;parentRunPromptOptions=undefined;
    parentBaselineSkills=undefined;
    try {
      if (typeof pi.getCommands==='function' && typeof ctx.getSystemPrompt==='function') {
        const skills=pi.getCommands().filter(command=>command.source==='skill').map(command=>({name:command.name.slice('skill:'.length),description:command.description ?? '',path:command.sourceInfo.path}));
        parentBaselineSkills=inferBaselineSkillVisibility(skills,ctx.getSystemPrompt(),pi.getActiveTools(),ctx.cwd,parentPrompts.systemPrompt);
      }
    } catch { /* The static visibility baseline is unavailable. */ }
    parentExtensionSnapshot=ctx.isProjectTrusted() ? captureExtensions(ctx.cwd,true) : undefined;
    if (parentExtensionSnapshot) await parentExtensionSnapshot;
  });
  pi.on('context_with_system',event=>{ parentObservedSystemMessages=event.messages.filter(message=>message.role==='system');parentPromptSections=replayPromptSections(parentObservedSystemMessages);parentOpaqueSystemContent=hasOpaqueSystemContent(parentObservedSystemMessages); });
  pi.on('before_agent_start',event=>{
    parentRunPromptOptions=event.systemPromptOptions;
  });
  let coordinator:Coordinator | undefined;
  const sessions = new Map<string, {child:Awaited<ReturnType<typeof createChildSession>>; steering:Map<Promise<string>,string>; closing:boolean}>();
  const notifications = new Notifications(event => {
    pi.sendMessage({customType:"subagents-event",content:`Subagent ${event.id} ${event.type}. Call subagent_status or subagent_wait for details.`,display:false}, {triggerTurn:true,deliverAs:"followUp"});
  });
  async function waitFor(c:Coordinator, ids:string[], cursor:number, signal?:AbortSignal) {
    return notifications.wait(()=>c.wait(ids,cursor,signal),signal);
  }
  const manager = (ctx:ExtensionContext) => {
    if (coordinator) return coordinator;
    let limit=4;
    let configRoot=ctx.cwd;
    try { configRoot=stripGitTerminator(execFileSync('git',['rev-parse','--show-toplevel'],{cwd:ctx.cwd,encoding:'utf8'})); } catch {}
    try { const cfg=JSON.parse(readFileSync(join(configRoot,'.pi','subagents.json'),'utf8')); if (cfg.maxConcurrent !== undefined) limit=cfg.maxConcurrent; }
    catch (e:any) { if (e.code !== 'ENOENT') throw e; }
    coordinator = new Coordinator(limit, async (job,signal,c) => {
      const agent=job.definition as ReturnType<typeof loadAgent>;
      const root=job.root as string;
      let cwd=job.cwd as string;
      let extraExtensions=job.extraExtensions as string[];
      let extraSkills=job.extraSkills as string[];
      let contextFiles=job.contextFiles as ContextFile[];
      let expectedSkills=job.parentSkills as ParentSkill[] | undefined;
      let runtimeSkills=job.runtimeSkills as Skill[] | undefined;
      if (job.workspace === 'worktree') {
        await checkProjectResources(root,job.base as string);
        if (signal.aborted) throw new Error('Aborted before creating worktree');
        let result:Awaited<ReturnType<typeof prepareWorktree>>;
        try {result=await prepareWorktree(root,job.id,job.base as string,signal);}
        catch(error) {if(error instanceof WorktreeCreationError && error.worktree) job.worktree=error.worktree;throw error;}
        job.worktree=result;
        if (signal.aborted) throw new Error('Aborted after creating worktree');
        await validateWorktreeSkillLinks(root,result.path);
        cwd=worktreeCwd(root,cwd,result.path);
        extraExtensions=mapWorktreeExtensions(root,result.path,extraExtensions);
        const configured=mapWorktreeExtensions(root,result.path,job.configuredExtensions as string[]);
        if (!job.noExtensions) assertSameProjectExtensions(configured,await configuredProjectExtensions(cwd,getAgentDir(),job.projectTrusted as boolean));
        validateExtensionGraph(job.extensionGraph as ExtensionGraph,root,result.path);
        extraSkills=mapWorktreeSkills(root,result.path,extraSkills);
        contextFiles=mapContextFiles(root,result.path,contextFiles,job.cwd as string);
        if (expectedSkills) expectedSkills=mapParentSkills(root,result.path,expectedSkills);
        if (runtimeSkills) runtimeSkills=mapRuntimeSkills(root,result.path,runtimeSkills,job.cwd as string);
        const worktreeDefinition=loadAgent(result.path, agent.relativePath);
        if (worktreeDefinition.contents !== agent.contents || relative(result.path,worktreeDefinition.path)!==relative(root,agent.path)) throw new Error(`Worktree agent definition differs from requested definition; retained ${cwd}`);
      }
      const model = job.model as any;
      if (signal.aborted) throw new Error('Aborted before starting');
      if (job.mcpSnapshot && mcpFingerprint(job.cwd as string,getAgentDir())!==job.mcpSnapshot) throw new Error('Parent MCP configuration changed; reload before starting a child');
      const childPromise=createChildSession({cwd,prompt:agent.prompt,model,thinkingLevel:job.thinkingLevel,tools:agent.tools,requiredTools:job.parentTools as string[],extraExtensions,providerConfig:job.providerConfig,nativeProvider:job.nativeProvider, runtimeApiKey:job.runtimeApiKey as string | undefined,signal,noExtensions:job.noExtensions as boolean,noSkills:job.noSkills as boolean,noMcp:job.noMcp as boolean,noContextFiles:job.noContextFiles as boolean,extraSkills,parentSystemPrompt:job.systemPrompt as string | undefined,parentPreamble:job.parentPreamble as string | undefined,parentAppendSystemPrompts:job.appendSystemPrompts as string[] | undefined,parentCustomSections:job.customSections as Record<string,string> | undefined,parentRuntimeSkills:runtimeSkills,freezeParentSystemPrompt:true,parentContextFiles:contextFiles,expectedSkills,projectTrusted:job.projectTrusted as boolean,ask:message=>c.ask(job.id,message)});
      delete job.runtimeApiKey;
      const child=await childPromise;
      const active={child,steering:new Map<Promise<string>,string>(),closing:false};
      sessions.set(job.id,active);
      let steeringAtAbort:string[]=[];
      let initialSteering:string[]=[];
      let executionFailure:Error | undefined;
      const abort=()=>{steeringAtAbort=[...child.session.getSteeringMessages()];void child.session.abort();}; signal.addEventListener('abort',abort,{once:true});
      try {
        if (signal.aborted) throw new Error('Aborted before prompt');
        initialSteering=c.takeSteering(job.id);
        await child.session.prompt([job.task,...initialSteering.map(m=>`Additional instruction: ${m}`)].join("\n\n"));
        const last=[...child.session.messages].reverse().find(m=>m.role==='assistant');
        if (last?.role==='assistant' && (last.stopReason==='error' || last.stopReason==='aborted')) throw new Error(last.errorMessage || last.stopReason);
        return child.session.getLastAssistantText() ?? '';
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        Object.assign(failure,{partial:lastAvailableAssistantText(child.session)});
        executionFailure=failure;
        throw failure;
      } finally {
        signal.removeEventListener('abort',abort); active.closing=true; sessions.delete(job.id);
        let timer:ReturnType<typeof setTimeout> | undefined;
        try {
          if (active.steering.size) await Promise.race([
            Promise.allSettled([...active.steering.keys()]),
            new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);}),
          ]);
          job.unconfirmedSteering=[...(executionFailure ? initialSteering : []),...active.steering.values()];
          const remaining=[...child.session.getSteeringMessages()];
          const counts=new Map<string,number>();for(const message of remaining) counts.set(message,(counts.get(message) ?? 0)+1);
          for(const message of steeringAtAbort) {const count=counts.get(message) ?? 0;if(count>0) counts.set(message,count-1);else remaining.push(message);}
          job.unconsumedSteering=remaining;
        } finally {
          if(timer) clearTimeout(timer);
          try { await child.dispose(); }
          catch (error) {
            if (!executionFailure) throw error;
            const cleanupMessage=error instanceof Error ? error.message : String(error);
            executionFailure.message+=`\nChild cleanup failed: ${cleanupMessage}`;
            throw executionFailure;
          }
        }
      }
    }, event => notifications.notify(event));
    return coordinator;
  };
  const safe = async (fn:()=>Promise<unknown>|unknown) => { try {return text(await fn());} catch(e) {return {...text({error:e instanceof Error?e.message:String(e),...(e instanceof StartedSubagentError ? {id:e.id} : {})}),isError:true};} };
  pi.registerTool({name:'subagent_start',label:'Start subagent',description:'Start a repository agent by name or repository-local Markdown path. Choose background or wait and shared or worktree explicitly.',parameters:Type.Object({agent:Type.String(),task:Type.String(),mode:Type.Union([Type.Literal('background'),Type.Literal('wait')]),workspace:Type.Union([Type.Literal('shared'),Type.Literal('worktree')])}),
    async execute(_id,p,signal,_update,ctx) { return safe(async()=>{
      if (signal?.aborted) throw new Error('Subagent start aborted');
      if (!ctx.isProjectTrusted()) throw new Error('Project is not trusted; project agent definitions cannot be run');
      const capturedPrompts=parentPrompts ?? captureParentPrompts(ctx);
      if (parentRunPromptOptions && (typeof parentRunPromptOptions.appendSystemPrompt!=='string' || (parentRunPromptOptions.customPrompt!==undefined && typeof parentRunPromptOptions.customPrompt!=='string') || !Array.isArray(parentRunPromptOptions.contextFiles) || !parentRunPromptOptions.contextFiles.every(file=>file && typeof file.path==='string' && typeof file.content==='string'))) throw new Error('Parent system prompt cannot be safely inherited; structured prompt options are invalid');
      const prompts=parentRunPromptOptions ? {...capturedPrompts,systemPrompt:parentRunPromptOptions.customPrompt || undefined,appendSystemPrompts:parentRunPromptOptions.appendSystemPrompt ? [parentRunPromptOptions.appendSystemPrompt] : [],contextFiles:parentRunPromptOptions.contextFiles.map(file=>({path:file.path,content:file.content}))} : capturedPrompts;
      if (parentObservedSystemMessages) {parentPromptSections=replayPromptSections(parentObservedSystemMessages);parentOpaqueSystemContent=hasOpaqueSystemContent(parentObservedSystemMessages);}
      if (parentOpaqueSystemContent) throw new Error('Parent system prompt cannot be safely inherited; an extension changed system message content');
      if (parentPromptSections) {
        assertParentPrompts(prompts,parentPromptSections);
        if (typeof ctx.getSystemPrompt==='function') assertEffectiveParentPrompt(parentPromptSections,ctx.getSystemPrompt());
      }
      else if (prompts.systemPrompt || prompts.appendSystemPrompts.some(Boolean) || prompts.contextFiles.length) throw new Error('Parent system prompt cannot be verified before starting a child');
      const customSections=parentPromptSections ? captureCustomPromptSections(parentRunPromptOptions?.sections,parentPromptSections) : {};
      const root=await repositoryRoot(ctx.cwd), definition=loadAgent(root,p.agent);
      let model=ctx.model;
      if (definition.model) {
        const matches=ctx.modelRegistry.getAll().filter(m=>`${m.provider}/${m.id}`===definition.model || m.id===definition.model);
        if(matches.length!==1) throw new Error(`Model ${definition.model} not found or ambiguous`);
        model=matches[0];
      }
      const runtimeApiKey=await runtimeApiKeyForChild(process.argv,model?.provider,provider=>ctx.modelRegistry.getApiKeyForProvider(provider));
      const base=p.workspace==='worktree' ? await git(root,'rev-parse','HEAD') : undefined;
      const dirty=base ? await git(root,'status','--short','--untracked-files=all') : '';
      const warning=dirty ? `Uncommitted changes are not included in the worktree base:\n${dirty.slice(0,4000)}` : undefined;
      if (base) { await checkProjectResources(root); const fromBase=await git(root,'show',`${base}:${relative(root,definition.path)}`); if (fromBase.trimEnd()!==definition.contents.trimEnd()) throw new Error('Agent definition differs from committed base'); }
      const noExtensions=cliDisabled(process.argv,'--no-extensions');
      let configuredExtensions:string[]=[],extensionGraph:ExtensionGraph={files:[],edges:[]};
      if (base) {
        const snapshot=await (parentExtensionSnapshot ?? captureExtensions(ctx.cwd,ctx.isProjectTrusted()));
        if (snapshot.error || !snapshot.value) throw new Error(`Cannot verify parent extensions: ${String(snapshot.error)}`);
        configuredExtensions=noExtensions ? [] : await configuredProjectExtensions(ctx.cwd,getAgentDir(),ctx.isProjectTrusted());
        const before=[...snapshot.value.paths].sort(),now=[...configuredExtensions].sort();
        if (JSON.stringify(before)!==JSON.stringify(now)) throw new Error('Configured project extensions changed since parent startup; reload before starting a worktree child');
        extensionGraph=snapshot.value.graph;
      }
      const parentTools=pi.getActiveTools().filter(name=>!name.startsWith('subagent_'));
      const extraExtensions=[...new Set([...explicitExtensions(process.argv,process.cwd()),...pi.getAllTools().filter(tool=>parentTools.includes(tool.name) && tool.sourceInfo?.scope==='temporary').map(tool=>tool.sourceInfo.path).filter(path=>path && !path.startsWith('builtin:') && !path.startsWith('<'))])];
      const supportedBuiltins=new Set(['builtin:codemode','builtin:tool-search','builtin:mcp']);
      const unsupportedBuiltins=extraExtensions.filter(path=>path.startsWith('builtin:') && !supportedBuiltins.has(path));
      if (unsupportedBuiltins.length) throw new Error(`Cannot inherit explicit built-in extensions: ${unsupportedBuiltins.join(', ')}`);
      const commands=typeof pi.getCommands==='function' ? pi.getCommands() : undefined;
      const parentHasMcp=commands ? commands.some(command=>command.source==='extension' && command.name==='mcp') : !noExtensions;
      const noMcp=cliDisabled(process.argv,'--no-mcp') || (!parentHasMcp && !parentTools.some(isMcpTool) && !extraExtensions.includes('builtin:mcp'));
      const usesMcp=!noMcp && (extraExtensions.includes('builtin:mcp') || (definition.tools ?? parentTools).some(name=>isMcpTool(name) || (parentHasMcp && (name==='codemode' || name==='tool_search'))));
      if (usesMcp && (!parentMcpSnapshot?.value || parentMcpSnapshot.cwd!==ctx.cwd || mcpFingerprint(ctx.cwd,getAgentDir())!==parentMcpSnapshot.value)) throw new Error('Parent MCP configuration changed or cannot be verified; reload before starting a child');
      const commandSkills=commands?.filter(command=>command.source==='skill').map(command=>({name:command.name.slice('skill:'.length),description:command.description ?? '',path:command.sourceInfo.path}));
      const runtimeSkills=parentRunPromptOptions ? captureRuntimeSkills(parentRunPromptOptions.skills,parentPromptSections?.skills,parentTools) : undefined;
      const parentSkills=commandSkills ? runtimeSkills ? commandSkills.map(skill=>{const initial=parentBaselineSkills?.find(item=>item.name===skill.name && item.path===skill.path);return initial ? {...skill,visible:initial.visible} : skill;}) : inferParentSkillVisibility(commandSkills,parentPromptSections?.skills,parentTools) : undefined;
      if (signal?.aborted) throw new Error('Subagent start aborted');
      const c=manager(ctx), id=c.start({agent:p.agent,task:p.task,root,cwd:ctx.cwd,definition,base,workspace:p.workspace,model,runtimeApiKey,mcpSnapshot:usesMcp ? parentMcpSnapshot?.value : undefined,customSections,parentPreamble:parentPromptSections?.preamble,nativeProvider:model ? ctx.modelRegistry.getRegisteredNativeProvider?.(model.provider) : undefined,providerConfig:model ? ctx.modelRegistry.getRegisteredProviderConfig(model.provider) : undefined,thinkingLevel:ctx.thinkingLevel,parentTools,parentSkills,runtimeSkills,extraExtensions,configuredExtensions,extensionGraph,projectTrusted:ctx.isProjectTrusted(),extraSkills:explicitSkills(process.argv,process.cwd()),noExtensions,noSkills:cliDisabled(process.argv,'--no-skills'),noMcp,noContextFiles:cliDisabled(process.argv,'--no-context-files'),...prompts});
      if (signal?.aborted) {c.stop(id);throw new StartedSubagentError('Subagent start aborted',id);}
      if (p.mode==='background') return {id,state:c.status(id).state,warning};
      try {const result=await waitFor(c,[id],0,signal);if(signal?.aborted) throw new Error('Subagent start aborted');return {id,warning,...result};} catch(e) {c.stop(id);throw new StartedSubagentError(e instanceof Error ? e.message : String(e),id);}
    }); }});
  pi.registerTool({name:'subagent_wait',label:'Wait for subagents',description:'Wait for completion or a question from any child; preserve the returned cursor.',parameters:Type.Object({ids:Type.Array(Type.String(),{minItems:1}),cursor:Type.Optional(Type.Integer({minimum:0}))}),async execute(_id,p,signal,_u,ctx){return safe(()=>waitFor(manager(ctx),p.ids,p.cursor??0,signal));}});
  pi.registerTool({name:'subagent_result',label:'Read subagent result',description:'Read a page of a completed child result.',parameters:Type.Object({id:Type.String(),offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:10000}))}),async execute(_id,p,_s,_u,ctx){return safe(()=>manager(ctx).result(p.id,p.offset,p.limit));}});
  pi.registerTool({name:'subagent_status',label:'Subagent status',description:'Inspect child states and retained worktrees.',parameters:Type.Object({}),async execute(_id,_p,_s,_u,ctx){return safe(()=>manager(ctx).list());}});
  pi.registerTool({name:'subagent_steer',label:'Steer subagent',description:'Queue an instruction for a running child; queued is not proof the model consumed it.',parameters:Type.Object({id:Type.String(),message:Type.String()}),async execute(_id,p,_signal,_u,ctx){return safe(async()=>{
    const c=manager(ctx), state=c.status(p.id).state;
    if (state==='stopping' || state==='stopped' || state==='failed' || state==='completed') throw new Error('Child is stopping or has already finished');
    const active=sessions.get(p.id);if(!active) return c.steer(p.id,p.message);
    const operation=active.child.session.steer(p.message);active.steering.set(operation,p.message);
    try {const delivery=await operation;return {delivery:active.closing ? 'unconfirmed' : delivery};}
    finally {active.steering.delete(operation);}
  });}});
  pi.registerTool({name:'subagent_reply',label:'Reply to subagent',description:'Reply to a child question using its request id.',parameters:Type.Object({id:Type.String(),requestId:Type.String(),answer:Type.String()}),async execute(_id,p,_s,_u,ctx){return safe(()=>{manager(ctx).reply(p.id,p.requestId,p.answer);return {ok:true};});}});
  pi.registerTool({name:'subagent_stop',label:'Stop subagent',description:'Request a child stop; check status for completion.',parameters:Type.Object({id:Type.String()}),async execute(_id,p,_s,_u,ctx){return safe(()=>{manager(ctx).stop(p.id);return {requested:true};});}});
  pi.on('session_shutdown',async()=>{
    parentObservedSystemMessages=undefined;parentRunPromptOptions=undefined;parentBaselineSkills=undefined;
    notifications.close();
    const cleanup=coordinator?.shutdown() ?? Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Allow time for in-flight steering (1s), child shutdown (5s), and MCP cleanup (3s).
    try { await Promise.race([cleanup,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out waiting for child aborts')),11000);})]); }
    finally { if(timer) clearTimeout(timer); }
  });
}

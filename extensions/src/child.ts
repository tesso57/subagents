import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getAgentDir, createCodemodeExtension, createToolSearchExtension, createMcpExtension, type AgentSession, type ExtensionAPI, type ExtensionContext, type Skill } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { assertChildSkills, assertRuntimeSkillVisibility, type ParentSkill } from './skills.ts';
import { assertParentPrompts, hasOpaqueSystemContent, replayPromptSections } from './parent-prompts.ts';

const mcpResourceTools=new Set(['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource']);
export const isMcpTool=(name:string)=>name.startsWith('mcp__') || mcpResourceTools.has(name);

/** Preserve the most recent non-empty assistant text if a later response failed without text. */
export function lastAvailableAssistantText(session:Pick<AgentSession,'messages' | 'getLastAssistantText'>):string {
  const last=session.getLastAssistantText();
  if (last) return last;
  for (const message of [...session.messages].reverse()) {
    if (message.role!=='assistant') continue;
    const text=message.content.filter(part=>part.type==='text').map(part=>part.text).join('').trim();
    if (text) return text;
  }
  return '';
}

export async function createChildSession(options: {cwd:string; agentDir?:string; prompt:string; model?:any; thinkingLevel?:any; tools?:string[]; ask:(message:string)=>Promise<string>; shutdownTimeoutMs?:number; requiredTools?:string[]; extraExtensions?:string[]; providerConfig?:any; nativeProvider?:any; runtimeApiKey?:string; signal?:AbortSignal; noExtensions?:boolean; noSkills?:boolean; noMcp?:boolean; noContextFiles?:boolean; extraSkills?:string[]; parentSystemPrompt?:string; parentPreamble?:string; parentAppendSystemPrompts?:string[]; parentCustomSections?:Record<string,string>; parentRuntimeSkills?:Skill[]; freezeParentSystemPrompt?:boolean; parentContextFiles?:Array<{path:string;content:string}>; expectedSkills?:ParentSkill[]; projectTrusted?:boolean}) {
  const checkAborted=()=>{if(options.signal?.aborted) throw new Error('Child startup aborted');};
  checkAborted();
  const agentDir = options.agentDir ?? getAgentDir();
  if (options.tools && options.requiredTools) {
    const allowed = new Set(options.requiredTools);
    const extra = options.tools.filter(name=>!allowed.has(name));
    if (extra.length) throw new Error(`Agent tools outside parent tool ceiling: ${extra.join(', ')}`);
  }
  const desiredTools = options.tools ?? options.requiredTools ?? [];
  const explicitBuiltins=new Set(options.extraExtensions ?? []);
  const mcpShutdowns:Array<(ctx:ExtensionContext)=>Promise<unknown>>=[];
  const managedMcpFactory=(api:ExtensionAPI)=>{
    const originalOn=api.on.bind(api) as (...args:any[])=>unknown;
    const wrapped=new Proxy(api,{get(target,key,receiver) {
      if (key!=='on') return Reflect.get(target,key,receiver);
      return (event:string,handler:(...args:any[])=>unknown)=>{
        if (event!=='session_shutdown') return originalOn(event,handler);
        let once:Promise<unknown> | undefined;
        const run=(...args:any[])=>once ??= Promise.resolve().then(()=>handler(...args));
        mcpShutdowns.push(ctx=>run({type:'session_shutdown',reason:'quit'},ctx));
        return originalOn(event,run);
      };
    }});
    return createMcpExtension()(wrapped);
  };
  const settingsManager=SettingsManager.create(options.cwd,agentDir,{projectTrusted:options.projectTrusted});
  const ownEntry = resolve(fileURLToPath(new URL('../index.ts', import.meta.url)));
  const loader = new DefaultResourceLoader({ cwd:options.cwd, agentDir, settingsManager,
    noExtensions:options.noExtensions, noSkills:options.noSkills, noContextFiles:options.noContextFiles,
    systemPromptOverride:options.freezeParentSystemPrompt || options.parentSystemPrompt!==undefined ? () => options.parentSystemPrompt : undefined,
    disabledBuiltinExtensions:options.noMcp ? ['mcp'] : undefined,
    agentsFilesOverride:options.parentContextFiles ? () => ({agentsFiles:options.parentContextFiles!}) : undefined,
    additionalSkillPaths:options.extraSkills ?? [],
    additionalExtensionPaths: options.extraExtensions ?? [],
    appendSystemPromptOverride: base => [...(options.parentAppendSystemPrompts ?? base), options.prompt, 'You are a child agent. Do not delegate. Use contact_parent when a decision is needed; wait for its answer.'],
    extensionFactories: [
      ...(explicitBuiltins.has('builtin:codemode') ? [{name:'codemode',factory:createCodemodeExtension({mode:'on'}),builtin:true as const,replaceable:true}] : desiredTools.includes('codemode') ? [{name:'codemode',factory:createCodemodeExtension({mode:'on'}),replaceable:true}] : []),
      ...(explicitBuiltins.has('builtin:tool-search') ? [{name:'tool-search',factory:createToolSearchExtension(),builtin:true as const,replaceable:true}] : desiredTools.includes('tool_search') ? [{name:'tool-search',factory:createToolSearchExtension(),replaceable:true}] : []),
      ...(explicitBuiltins.has('builtin:mcp') || (!options.noMcp && desiredTools.some(name=>isMcpTool(name) || (!options.noExtensions && (name==='codemode' || name==='tool_search')))) ? [{name:'mcp',factory:managedMcpFactory,builtin:true as const,replaceable:true}] : []),
      {name:'subagents:contact-parent', factory: api => {
      api.registerTool({name:'contact_parent',label:'Contact parent',description:'Ask the parent agent for a decision and wait for its reply.',parameters:Type.Object({message:Type.String()}),
        async execute(_id, {message}) { return {content:[{type:'text',text:await options.ask(message)}],details:{}}; }});
      const ensureContact=()=>{const active=api.getActiveTools();if(!active.includes('contact_parent')) api.setActiveTools([...active,'contact_parent']);};
      api.on('before_agent_start',event=>{ensureContact();Object.assign(event.systemPromptOptions.sections,options.parentCustomSections ?? {});if(options.parentRuntimeSkills)event.systemPromptOptions.skills=options.parentRuntimeSkills.map(skill=>({...skill,sourceInfo:{...skill.sourceInfo}}));});
      api.on('turn_start',ensureContact);
    }}],
    extensionsOverride: base => ({...base,extensions:base.extensions.filter(x=>resolve(x.resolvedPath)!==ownEntry)})
  });
  await loader.reload();
  checkAborted();
  const errors = loader.getExtensions().errors;
  if (errors.length) throw new Error(`Child extension loading failed: ${errors.map(e=>`${e.path}: ${e.error}`).join('; ')}`);
  const {session} = await createAgentSession({cwd:options.cwd,agentDir,settingsManager,resourceLoader:loader,sessionManager:SessionManager.inMemory(options.cwd),model:options.model,thinkingLevel:options.thinkingLevel,tools:options.tools || options.requiredTools ? [...desiredTools,'contact_parent'] : undefined,excludeTools:['subagent*']});
  const startupErrors:string[]=[],shutdownErrors:string[]=[];
  let bound=false;
  async function dispose() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut=false;
    try {
      if (session.extensionRunner.hasHandlers('session_shutdown')) {
        const timeout=options.shutdownTimeoutMs ?? 5000;
        await Promise.race([
          session.extensionRunner.emit({type:'session_shutdown',reason:'quit'}),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error('Child shutdown timed out'));},timeout);}),
        ]);
        if (shutdownErrors.length) throw new Error(`Child extension shutdown failed: ${shutdownErrors.join('; ')}`);
      }
    } catch (error) {
      if (timedOut && bound && mcpShutdowns.length && loader.getExtensions().extensions.some(item=>item.resolvedPath==='builtin:mcp')) {
        let cleanupTimer:ReturnType<typeof setTimeout> | undefined;
        try {
          const ctx=session.extensionRunner.createContext();
          await Promise.race([
            Promise.allSettled(mcpShutdowns.map(shutdown=>shutdown(ctx))),
            new Promise<void>(resolve=>{cleanupTimer=setTimeout(resolve,3000);}),
          ]);
        } catch { /* The original timeout remains the reported failure. */ }
        finally {if(cleanupTimer) clearTimeout(cleanupTimer);}
      }
      const failure=error instanceof Error ? error : new Error(String(error));
      Object.assign(failure,{partial:lastAvailableAssistantText(session)});
      throw failure;
    } finally { if (timer) clearTimeout(timer);session.dispose(); }
  }
  try {
    checkAborted();
    if (options.nativeProvider && options.model && !session.modelRuntime.getRegisteredNativeProvider(options.model.provider)) session.modelRuntime.registerNativeProvider(options.nativeProvider);
    if (options.providerConfig && options.model && !session.modelRuntime.getRegisteredProviderConfig(options.model.provider)) session.modelRuntime.registerProvider(options.model.provider, options.providerConfig);
    if (options.runtimeApiKey && options.model) {
      try { await session.modelRuntime.setRuntimeApiKey(options.model.provider,options.runtimeApiKey,{signal:options.signal}); }
      catch { throw new Error('Could not inherit parent runtime API key'); }
      finally { delete options.runtimeApiKey; }
    }
    checkAborted();
    await session.bindExtensions({mode:'print',onError:error=>(error.event==='session_shutdown' ? shutdownErrors : startupErrors).push(`${error.extensionPath}: ${error.error}`)});
    bound=true;
    if (startupErrors.length) throw new Error(`Child extension startup failed: ${startupErrors.join('; ')}`);
    if (options.nativeProvider && options.model && session.modelRuntime.getRegisteredNativeProvider(options.model.provider)!==options.nativeProvider) session.modelRuntime.registerNativeProvider(options.nativeProvider);
    if (options.providerConfig && options.model) {
      session.modelRuntime.unregisterProvider(options.model.provider);
      session.modelRuntime.registerProvider(options.model.provider,options.providerConfig);
    }
    if (options.freezeParentSystemPrompt) {
      const previousTransform=session.agent.transformContext;
      session.agent.transformContext=async(messages,signal)=>{
        const transformed=previousTransform ? await previousTransform(messages,signal) : messages;
        if (hasOpaqueSystemContent(transformed)) throw new Error('Child system prompt cannot be verified after an extension changed it');
        const sections=replayPromptSections(transformed);
        try {assertParentPrompts({systemPrompt:options.parentPreamble ?? options.parentSystemPrompt,appendSystemPrompts:session.resourceLoader.getAppendSystemPrompt(),contextFiles:options.parentContextFiles},sections);}
        catch(error) {throw new Error(`Child system prompt differs from inherited instructions: ${error instanceof Error ? error.message : String(error)}`);}
        for (const [name,value] of Object.entries(options.parentCustomSections ?? {})) if (sections[name]!==`<${name}>\n${value}\n</${name}>`) throw new Error(`Child system prompt differs from inherited section ${name}`);
        if (options.parentRuntimeSkills) assertRuntimeSkillVisibility(options.parentRuntimeSkills,sections.skills,session.getActiveToolNames());
        return transformed;
      };
    }
    if (options.expectedSkills) assertChildSkills(options.expectedSkills,session.resourceLoader.getSkills().skills);
    const mcpNeeded=desiredTools.filter(isMcpTool);
    const deadline=Date.now()+10000;
    while (mcpNeeded.some(name=>!session.getActiveToolNames().includes(name)) && Date.now()<deadline) {
      if (options.signal?.aborted) throw new Error('Child startup aborted');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if (options.signal?.aborted) throw new Error('Child startup aborted');
    const active=new Set(session.getActiveToolNames());
    if (!active.has('contact_parent')) throw new Error('Child could not activate required contact_parent tool');
    const missing=desiredTools.filter(name=>!name.startsWith('subagent_') && !active.has(name));
    if (missing.length) throw new Error(`Child could not inherit active parent tools: ${missing.join(', ')}`);
  } catch (error) {
    const failure=error instanceof Error ? error : new Error(String(error));
    try {await dispose();}
    catch (cleanupError) {failure.message+=`\nChild cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;}
    throw failure;
  }
  return {session,dispose};
}

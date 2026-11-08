import { createAgentSession, DefaultResourceLoader, SessionManager, getAgentDir, createCodemodeExtension, createToolSearchExtension, createMcpExtension } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function createChildSession(options: {cwd:string; agentDir?:string; prompt:string; model?:any; thinkingLevel?:any; tools?:string[]; ask:(message:string)=>Promise<string>; shutdownTimeoutMs?:number; requiredTools?:string[]; extraExtensions?:string[]; providerConfig?:any; signal?:AbortSignal; noExtensions?:boolean; noSkills?:boolean; extraSkills?:string[]}) {
  const agentDir = options.agentDir ?? getAgentDir();
  if (options.tools && options.requiredTools) {
    const allowed = new Set(options.requiredTools);
    const extra = options.tools.filter(name=>!allowed.has(name));
    if (extra.length) throw new Error(`Agent tools outside parent tool ceiling: ${extra.join(', ')}`);
  }
  const desiredTools = options.tools ?? options.requiredTools ?? [];
  const ownEntry = resolve(fileURLToPath(new URL('../index.ts', import.meta.url)));
  const loader = new DefaultResourceLoader({ cwd:options.cwd, agentDir,
    noExtensions:options.noExtensions, noSkills:options.noSkills,
    skillsOverride:options.noSkills ? base => ({...base,skills:[]}) : undefined,
    additionalSkillPaths:options.extraSkills ?? [],
    additionalExtensionPaths: options.extraExtensions ?? [],
    appendSystemPrompt: [options.prompt, 'You are a child agent. Do not delegate. Use contact_parent when a decision is needed; wait for its answer.'],
    extensionFactories: [
      ...(desiredTools.includes('codemode') ? [createCodemodeExtension({mode:'on'})] : []),
      ...(desiredTools.includes('tool_search') ? [createToolSearchExtension()] : []),
      ...(!options.extraExtensions?.includes('builtin:mcp') && desiredTools.some(name=>name.startsWith('mcp__') || (!options.noExtensions && (name==='codemode' || name==='tool_search'))) ? [createMcpExtension()] : []),
      {name:'subagents:contact-parent', factory: api => {
      api.registerTool({name:'contact_parent',label:'Contact parent',description:'Ask the parent agent for a decision and wait for its reply.',parameters:Type.Object({message:Type.String()}),
        async execute(_id, {message}) { return {content:[{type:'text',text:await options.ask(message)}],details:{}}; }});
    }}],
    extensionsOverride: base => ({...base,extensions:base.extensions.filter(x=>resolve(x.resolvedPath)!==ownEntry)})
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length) throw new Error(`Child extension loading failed: ${errors.map(e=>`${e.path}: ${e.error}`).join('; ')}`);
  const {session} = await createAgentSession({cwd:options.cwd,agentDir,resourceLoader:loader,sessionManager:SessionManager.inMemory(options.cwd),model:options.model,thinkingLevel:options.thinkingLevel,tools:options.tools || options.requiredTools ? [...desiredTools,'contact_parent'] : undefined,excludeTools:['subagent*']});
  async function dispose() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (session.extensionRunner.hasHandlers('session_shutdown')) {
        await Promise.race([
          session.extensionRunner.emit({type:'session_shutdown',reason:'quit'}),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Child shutdown timed out')),options.shutdownTimeoutMs ?? 5000);}),
        ]);
      }
    } finally { if (timer) clearTimeout(timer); session.dispose(); }
  }
  const startupErrors:string[]=[];
  try {
    if (options.providerConfig && options.model && !session.modelRuntime.getRegisteredProviderConfig(options.model.provider)) session.modelRuntime.registerProvider(options.model.provider, options.providerConfig);
    await session.bindExtensions({mode:'print',onError:error=>startupErrors.push(`${error.extensionPath}: ${error.error}`)});
    if (startupErrors.length) throw new Error(`Child extension startup failed: ${startupErrors.join('; ')}`);
    const mcpNeeded=desiredTools.filter(name=>name.startsWith('mcp__'));
    const deadline=Date.now()+10000;
    while (mcpNeeded.some(name=>!session.getActiveToolNames().includes(name)) && Date.now()<deadline) {
      if (options.signal?.aborted) throw new Error('Child startup aborted');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    if (options.signal?.aborted) throw new Error('Child startup aborted');
    const active=new Set(session.getActiveToolNames());
    const missing=desiredTools.filter(name=>!name.startsWith('subagent_') && !active.has(name));
    if (missing.length) throw new Error(`Child could not inherit active parent tools: ${missing.join(', ')}`);
  } catch (error) { try { await dispose(); } catch {} throw error; }
  return {session,dispose};
}

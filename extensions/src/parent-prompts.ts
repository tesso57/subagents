import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, sep, dirname, basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { leavesRepository } from './inheritance.ts';
type Message = { role:string; content?:unknown; sections?:Record<string,string|null> };
export type ContextFile = {path:string;content:string};
type PromptSnapshot = { systemPrompt?:string; appendSystemPrompts:string[]; contextFiles?:ContextFile[] };
const builtInSections=new Set(['preamble','tools','rules','docs','addendum','project_context','skills','cwd']);

/** Replay Pi system-message section updates from the context sent to the model. */
export function replayPromptSections(messages:Message[]):Record<string,string> {
  const sections:Record<string,string>={};
  for (const message of messages) {
    if (message.role!=='system' || !message.sections) continue;
    for (const [name,value] of Object.entries(message.sections)) {
      if (value===null) delete sections[name]; else sections[name]=value;
    }
  }
  return sections;
}

export function hasOpaqueSystemContent(messages:Message[]):boolean {
  return messages.some(message=>{
    if (message.role!=='system') return false;
    if (message.content===undefined || message.content===null) return true;
    if (typeof message.content==='string') return message.content.length>0;
    if (!Array.isArray(message.content)) return true;
    if (!message.content.every(part=>part && typeof part==='object' && part.type==='text' && typeof part.text==='string')) return true;
    return message.content.map(part=>part.text).join('\n').length>0;
  });
}

export function assertParentPrompts(snapshot:PromptSnapshot, sections:Record<string,string>) {
  const expectedAppend=snapshot.appendSystemPrompts.join('\n\n');
  const expectedAddendum=expectedAppend ? `<addendum>\n${expectedAppend}\n</addendum>` : undefined;
  if (snapshot.contextFiles) {
    const body=['Project-specific instructions and guidelines:',...snapshot.contextFiles.map(file=>`<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`)].join('\n\n');
    const expectedContext=snapshot.contextFiles.length ? `<project_context>\n${body}\n</project_context>` : undefined;
    if (sections.project_context!==expectedContext) throw new Error('Parent context files differ from captured instructions; reload the session before starting a child');
  }
  if ((snapshot.systemPrompt && sections.preamble!==snapshot.systemPrompt) || sections.addendum!==expectedAddendum) {
    throw new Error('Parent system prompt differs from captured instructions; reload the session before starting a child');
  }
}

/** Reject opaque runtime overrides, which cannot be safely split into child prompt sections. */
export function assertEffectiveParentPrompt(sections:Record<string,string>, effective:string) {
  const rendered=Object.values(sections).filter(Boolean).join('\n\n');
  if (rendered!==effective) throw new Error('Parent system prompt cannot be safely inherited; an extension changed the effective prompt');
}

/** Capture structured custom sections without copying parent-specific built-in sections. */
export function captureCustomPromptSections(raw:Record<string,string> | undefined, observed:Record<string,string>):Record<string,string> {
  const result:Record<string,string>=Object.create(null);
  for (const [name,value] of Object.entries(raw ?? {})) {
    if (!value) continue;
    if (builtInSections.has(name)) throw new Error(`Parent system prompt cannot be safely inherited; built-in section ${name} was overridden`);
    if (observed[name]!==`<${name}>\n${value}\n</${name}>`) throw new Error(`Parent system prompt cannot be safely inherited; section ${name} differs from the observed prompt`);
    result[name]=value;
  }
  for (const name of Object.keys(observed)) if (!builtInSections.has(name) && !Object.hasOwn(result,name)) throw new Error(`Parent system prompt cannot be safely inherited; section ${name} is not available in structured options`);
  return result;
}

export function mapContextFiles(root:string,worktree:string,files:ContextFile[],parentCwd=root):ContextFile[] {
  const sourceRoot=realpathSync(root),targetRoot=realpathSync(worktree);
  return files.map(file=>{
    const scheme=/^([a-z][a-z0-9+.-]*):\/\//i.exec(file.path)?.[1];
    if (scheme && scheme.toLowerCase()!=='file' && !isAbsolute(file.path)) return file;
    const fileUrl=scheme?.toLowerCase()==='file' && !isAbsolute(file.path);
    const sourcePath=fileUrl ? fileURLToPath(file.path) : resolve(parentCwd,file.path);
    if (leavesRepository(sourcePath,sourceRoot)) throw new Error(`Context file resolves outside repository: ${file.path}`);
    const logicalSource=join(realpathSync(dirname(sourcePath)),basename(sourcePath));
    const rel=relative(sourceRoot,logicalSource);
    if (rel==='..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return isAbsolute(file.path) || fileUrl ? file : {...file,path:logicalSource};
    const source=realpathSync(sourcePath),sourceRel=relative(sourceRoot,source);
    if (sourceRel==='..' || sourceRel.startsWith(`..${sep}`) || isAbsolute(sourceRel)) throw new Error(`Context file resolves outside repository: ${file.path}`);
    const targetPath=join(targetRoot,rel),target=realpathSync(targetPath),targetRel=relative(targetRoot,target);
    if (targetRel==='..' || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) throw new Error(`Context file resolves outside worktree: ${file.path}`);
    if (readFileSync(target,'utf8').replace(/^\uFEFF/,'')!==file.content) throw new Error(`Context file differs from parent snapshot: ${file.path}`);
    return {path:fileUrl ? pathToFileURL(targetPath).href : targetPath,content:file.content};
  });
}

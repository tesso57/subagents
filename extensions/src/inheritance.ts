import { resolve, relative, isAbsolute, join, sep, dirname, basename } from 'node:path';
import { readFileSync, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '@earendil-works/pi-coding-agent';

export async function runtimeApiKeyForChild(argv:string[], provider:string | undefined, resolveKey:(provider:string)=>Promise<string | undefined>):Promise<string | undefined> {
  const candidate=parseArgs(argv.slice(2)).apiKey;
  if (!provider || !candidate) return undefined;
  try { return await resolveKey(provider)===candidate ? candidate : undefined; } catch { return undefined; }
}

function resolveLocal(value:string,cwd:string):string {
  if (value==='~') return homedir();
  if (value.startsWith('~/') || (process.platform==='win32' && value.startsWith('~\\'))) return join(homedir(),value.slice(2));
  if (value.startsWith('file://')) return fileURLToPath(value);
  return resolve(cwd,value);
}

/** Use Pi's parser so option values cannot be mistaken for flags. */
export function explicitExtensions(argv:string[], cwd:string):string[] {
  const values=parseArgs(argv.slice(2)).extensions ?? [];
  const normalize=(value:string)=>/^(npm:|git:|builtin:|https?:\/\/|ssh:\/\/)/i.test(value) ? value : resolveLocal(value,cwd);
  return [...new Set(values.map(normalize))];
}

export function explicitSystemPrompts(argv:string[]): {systemPrompt?:string; appendSystemPrompts?:string[]} {
  const parsed=parseArgs(argv.slice(2));
  return {
    ...(parsed.systemPrompt===undefined ? {} : {systemPrompt:parsed.systemPrompt}),
    ...(parsed.appendSystemPrompt===undefined ? {} : {appendSystemPrompts:parsed.appendSystemPrompt}),
  };
}

/** Capture prompt file contents while Pi loads the extension, before child launches. */
export function snapshotSystemPrompts(argv:string[]): {systemPrompt?:string; appendSystemPrompts?:string[]} {
  const values=explicitSystemPrompts(argv);
  const snapshot=(value:string)=>{
    try { return existsSync(value) ? readFileSync(value,'utf8').replace(/^\uFEFF/,'') : value; }
    catch { return value; }
  };
  return {
    ...(values.systemPrompt===undefined ? {} : {systemPrompt:snapshot(values.systemPrompt)}),
    ...(values.appendSystemPrompts===undefined ? {} : {appendSystemPrompts:values.appendSystemPrompts.map(snapshot)}),
  };
}

export function snapshotDiscoveredSystemPrompts(cwd:string,agentDir:string,trusted:boolean,cli:{systemPrompt?:string;appendSystemPrompts?:string[]}) {
  const read=(name:string):string | undefined => {
    const project=join(cwd,'.pi',name),global=join(agentDir,name);
    const path=trusted && existsSync(project) ? project : existsSync(global) ? global : undefined;
    if (!path) return undefined;
    try { return readFileSync(path,'utf8').replace(/^\uFEFF/,''); } catch { return path; }
  };
  const systemPrompt=cli.systemPrompt ?? read('SYSTEM.md');
  const append=cli.appendSystemPrompts ?? (()=>{const value=read('APPEND_SYSTEM.md');return value===undefined ? [] : [value];})();
  return {systemPrompt,appendSystemPrompts:append};
}

export function explicitSkills(argv:string[], cwd:string):string[] {
  return [...new Set((parseArgs(argv.slice(2)).skills ?? []).map(value=>resolveLocal(value,cwd)))];
}
export function cliDisabled(argv:string[], long:'--no-extensions' | '--no-skills' | '--no-context-files' | '--no-mcp') {
  const parsed=parseArgs(argv.slice(2));
  if (long==='--no-extensions') return parsed.noExtensions === true;
  if (long==='--no-skills') return parsed.noSkills === true;
  if (long==='--no-context-files') return parsed.noContextFiles === true;
  if (long==='--no-mcp') return parsed.noMcp === true;
  throw new Error(`Unsupported Pi flag: ${long}`);
}

function equalResources(a:string,b:string,sourceRoot:string,targetRoot:string,ignoreGenerated:boolean,seen=new Set<string>()):boolean {
 const left=lstatSync(a),right=lstatSync(b);
 if (left.isSymbolicLink()!==right.isSymbolicLink()) return false;
 const source=realpathSync(a),target=realpathSync(b);
 const sourceRel=relative(sourceRoot,source),targetRel=relative(targetRoot,target);
 const outside=(path:string)=>path==='..' || path.startsWith(`..${sep}`) || isAbsolute(path);
 if (outside(sourceRel) || outside(targetRel) || sourceRel!==targetRel) return false;
 if (left.isSymbolicLink()) return equalResources(source,target,sourceRoot,targetRoot,ignoreGenerated,seen);
 const key=JSON.stringify([source,target]);if(seen.has(key)) return true;seen.add(key);
 if (left.isFile() && right.isFile()) return (left.mode & 0o111)===(right.mode & 0o111) && readFileSync(source).equals(readFileSync(target));
 if (!left.isDirectory() || !right.isDirectory()) return false;
 let l=readdirSync(source).sort(),r=readdirSync(target).sort();
 if (ignoreGenerated) {
  const bothModules=l.includes('node_modules') && r.includes('node_modules');
  l=l.filter(name=>name!=='.git' && (name!=='node_modules' || bothModules));
  r=r.filter(name=>name!=='.git' && (name!=='node_modules' || bothModules));
 }
 return l.length===r.length && l.every((name,i)=>name===r[i] && equalResources(join(source,name),join(target,name),sourceRoot,targetRoot,ignoreGenerated,seen));
}
export function leavesRepository(path:string, root:string):boolean {
 const chain:string[]=[];let current=resolve(path);
 while (true) { chain.push(current);const parent=dirname(current);if(parent===current) break;current=parent; }
 let inside=false;
 for (const entry of chain.reverse()) {
  let real:string;try {real=realpathSync(entry);} catch {break;}
  const rel=relative(root,real),nowInside=rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (inside && !nowInside) return true;
  if (nowInside) inside=true;
 }
 return false;
}
function mapWorktreeResources(root:string, worktree:string, paths:string[],label:string):string[] {
 const sourceRoot=realpathSync(root),targetRoot=realpathSync(worktree);
 const outside=(value:string)=>value==='..' || value.startsWith(`..${sep}`) || isAbsolute(value);
 return paths.map(path=>{
  if (/^(npm:|git:|builtin:|https?:\/\/|ssh:\/\/)/i.test(path)) return path;
  if (leavesRepository(path,sourceRoot)) throw new Error(`Explicit ${label} resolves outside repository: ${path}`);
  let source:string;
  try { source=realpathSync(path); } catch {
    let logical=resolve(path);
    try { logical=join(realpathSync(dirname(path)),basename(path)); } catch {}
    if (!outside(relative(sourceRoot,logical))) throw new Error(`Explicit ${label} differs from worktree base or is missing: ${path}`);
    return path;
  }
  let logical=resolve(path);
  try { logical=join(realpathSync(dirname(path)),basename(path)); } catch {}
  const rel=relative(sourceRoot,source);
  if (outside(rel)) {
    if (!outside(relative(sourceRoot,logical))) throw new Error(`Explicit ${label} resolves outside repository: ${path}`);
    return path;
  }
  const target=join(worktree,rel); let matches=false;
  try {
    const targetReal=realpathSync(target);
    if (outside(relative(targetRoot,targetReal))) throw new Error(`Explicit ${label} resolves outside worktree: ${path}`);
    matches=equalResources(source,target,sourceRoot,targetRoot,label==='extension');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`Explicit ${label} resolves outside worktree:`)) throw error;
  }
  if (!matches) throw new Error(`Explicit ${label} differs from worktree base or is missing: ${path}`);
  return target;
 });
}
export function mapWorktreeExtensions(root:string,worktree:string,paths:string[]):string[] {
 return mapWorktreeResources(root,worktree,paths,'extension');
}
export function mapWorktreeSkills(root:string,worktree:string,paths:string[]):string[] {
 return mapWorktreeResources(root,worktree,paths,'skill');
}

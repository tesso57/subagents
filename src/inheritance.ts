import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { readFileSync, lstatSync, readdirSync } from 'node:fs';

/** Explicit Pi CLI extension paths can contain hooks without registering tools. */
export function explicitExtensions(argv:string[], cwd:string):string[] {
  const paths:string[]=[];
  const normalize=(value:string)=>/^(npm:|git:|builtin:)/.test(value) ? value : resolve(cwd,value);
  for(let i=2;i<argv.length;i++) {
    const arg=argv[i]; if(arg==='--') break;
    if(arg==='-e' || arg==='--extension') { const value=argv[++i]; if(value) paths.push(normalize(value)); }
    else if(arg.startsWith('--extension=')) paths.push(normalize(arg.slice('--extension='.length)));
  }
  return [...new Set(paths)];
}

export function explicitSkills(argv:string[], cwd:string):string[] {
  const paths:string[]=[];
  for(let i=2;i<argv.length;i++) {
    const arg=argv[i]; if(arg==='--') break;
    if(arg==='--skill') { const value=argv[++i]; if(value) paths.push(resolve(cwd,value)); }
    else if(arg.startsWith('--skill=')) paths.push(resolve(cwd,arg.slice('--skill='.length)));
  }
  return [...new Set(paths)];
}
export function cliDisabled(argv:string[], long:string, short:string) { const args=argv.slice(2); const end=args.indexOf('--'); return (end<0?args:args.slice(0,end)).some(arg=>arg===long||arg===short); }

function equalResources(a:string,b:string):boolean {
 const left=lstatSync(a),right=lstatSync(b);
 if (left.isSymbolicLink() || right.isSymbolicLink()) return false;
 if (left.isFile() && right.isFile()) return readFileSync(a).equals(readFileSync(b));
 if (!left.isDirectory() || !right.isDirectory()) return false;
 const l=readdirSync(a).sort(),r=readdirSync(b).sort();
 return l.length===r.length && l.every((name,i)=>name===r[i] && equalResources(join(a,name),join(b,name)));
}
function mapWorktreeResources(root:string, worktree:string, paths:string[],label:string):string[] {
 return paths.map(path=>{
  if (/^(npm:|git:|builtin:)/.test(path)) return path;
  const rel=relative(root,path);
  if (rel==='..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  const target=join(worktree,rel); let matches=false;
  try { matches=equalResources(path,target); } catch {}
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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative, isAbsolute, sep, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { mapWorktreeSkills } from './inheritance.ts';
const exec = promisify(execFile);
export function stripGitTerminator(output:string) { return output.endsWith('\n') ? output.slice(0,-1) : output; }
export async function git(root: string, ...args: string[]) { return stripGitTerminator((await exec('git', args, {cwd:root, maxBuffer: 4*1024*1024})).stdout); }
export async function repositoryRoot(cwd: string) { return git(cwd,'rev-parse','--show-toplevel'); }
export class WorktreeCreationError extends Error {
  readonly worktree?:{path:string;branch:string;base:string;creation:'unverified'};
  constructor(message:string,worktree?:{path:string;branch:string;base:string;creation:'unverified'}) { super(message);this.worktree=worktree; }
}
export async function prepareWorktree(root: string, id: string, commit?: string, signal?:AbortSignal) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid worktree id');
  const base = commit ?? await git(root, 'rev-parse', 'HEAD');
  const dir = join(await git(root,'rev-parse','--path-format=absolute','--git-common-dir'),'subagent-worktrees');
  await mkdir(dir,{recursive:true});
  const path = join(dir,id), branch = `subagents/${id}`;
  if (signal?.aborted) throw new Error('Aborted before creating worktree');
  const claimPath=`${path}.claim`;
  let claim:Awaited<ReturnType<typeof open>>;
  try {claim=await open(claimPath,'wx',0o600);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code==='EEXIST') throw new WorktreeCreationError(`Worktree creation is already claimed; inspect ${path} and branch ${branch}`);
    throw error;
  }
  try {
    const entries=async()=> (await git(root,'worktree','list','--porcelain','-z')).split('\0\0').map(entry=>entry.split('\0'));
    const samePath=(left:string,right:string)=>{try{return realpathSync(left)===realpathSync(right);}catch{return resolve(left)===resolve(right);}};
    let before:string[][] | undefined;
    try {before=await entries();} catch { /* Without a baseline, do not attribute a failed creation. */ }
    if (signal?.aborted) throw new Error('Aborted before creating worktree');
    try { await git(root,'worktree','add','-b',branch,path,base); }
    catch (e) {
      let registered=false;
      try {
        const preexisting=before?.some(fields=>{
          const worktree=fields.find(field=>field.startsWith('worktree '))?.slice(9);
          return fields.includes(`branch refs/heads/${branch}`) || (worktree!==undefined && samePath(worktree,path));
        });
        const expected=await git(root,'rev-parse','--verify',`${base}^{commit}`);
        registered=before!==undefined && !preexisting && (await entries()).some(fields=>{
          const worktree=fields.find(field=>field.startsWith('worktree '))?.slice(9);
          return worktree!==undefined && fields.includes(`branch refs/heads/${branch}`) && fields.includes(`HEAD ${expected}`) && samePath(worktree,path);
        });
      } catch { /* The error still identifies the attempted path and branch. */ }
      throw new WorktreeCreationError(`Could not create worktree; inspect ${path} and branch ${branch}: ${String(e)}`,registered ? {path,branch,base,creation:'unverified'} : undefined);
    }
    return {path,branch,base};
  } finally {
    try {await claim.close();} catch {}
    try {await unlink(claimPath);} catch {}
  }
}

async function projectSkillSymlinks(root:string):Promise<string[]> {
  const paths=[':(glob)**/.agents',':(glob)**/.pi',':(glob)**/.agents/skills',':(glob)**/.agents/skills/**',':(glob)**/.pi/skills',':(glob)**/.pi/skills/**'];
  const entries=await git(root,'ls-files','--stage','-z','--',...paths);
  return entries.split('\0').filter(Boolean).flatMap(entry=>{
    const tab=entry.indexOf('\t');
    if (tab<0 || !entry.startsWith('120000 ')) return [];
    return [entry.slice(tab+1)];
  });
}
function outside(root:string,path:string) {
  const rel=relative(root,path);
  return rel==='..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
async function assertProjectSkillLinksInside(root:string) {
  const canonical=realpathSync(root);
  for (const rel of await projectSkillSymlinks(root)) {
    const path=join(root,rel);let target:string;
    try {target=realpathSync(path);} catch {throw new Error(`Skill symlink cannot be resolved: ${rel}`);}
    if (outside(canonical,target)) throw new Error(`Skill symlink resolves outside repository: ${rel}`);
  }
}

export async function checkProjectResources(root: string, base?: string) {
  const resources=['.pi','.agents',':(glob)**/.pi',':(glob)**/.pi/**',':(glob)**/.agents',':(glob)**/.agents/skills/**',':(glob)**/AGENTS.md',':(glob)**/AGENTS.MD',':(glob)**/AGENTS.override.md',':(glob)**/CLAUDE.md',':(glob)**/CLAUDE.MD'];
  const output = await git(root,'status','--porcelain=v1','--untracked-files=all','--ignored','--',...resources);
  if (base) {
    const changed = await git(root,'diff','--name-only',base,'HEAD','--',...resources);
    if (changed) throw new Error(`Project resources changed after captured base:\n${changed}`);
  }
  if (output) throw new Error(`Uncommitted project agent resources are not present in worktree base:\n${output}`);
  await assertProjectSkillLinksInside(root);
}

/** Ensure auto-discovered tracked skill links resolve to the corresponding worktree files. */
export async function validateWorktreeSkillLinks(root:string,worktree:string) {
  const sourceRoot=realpathSync(root),targetRoot=realpathSync(worktree);
  for (const rel of await projectSkillSymlinks(root)) {
    const link=join(root,rel),source=realpathSync(link);
    if (outside(sourceRoot,source)) throw new Error(`Skill symlink resolves outside repository: ${rel}`);
    let target:string,expected:string;
    try {
      target=realpathSync(join(targetRoot,rel));
      expected=realpathSync(join(targetRoot,relative(sourceRoot,source)));
    } catch { throw new Error(`Skill symlink cannot be resolved in worktree: ${rel}`); }
    if (outside(targetRoot,target) || outside(targetRoot,expected) || target!==expected) {
      throw new Error(`Skill symlink does not resolve to the corresponding worktree resource: ${rel}`);
    }
    mapWorktreeSkills(root,worktree,[source]);
  }
}

export function worktreeCwd(root:string, cwd:string, worktree:string) {
  const rel=relative(realpathSync(root),realpathSync(cwd));
  if(rel==='..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Working directory is outside the repository');
  const worktreeRoot=realpathSync(worktree);
  const target=realpathSync(join(worktreeRoot,rel));
  const targetRel=relative(worktreeRoot,target);
  if(targetRel==='..' || targetRel.startsWith(`..${sep}`) || isAbsolute(targetRel)) throw new Error('Working directory resolves outside the worktree');
  return target;
}

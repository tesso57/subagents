import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
const exec = promisify(execFile);
export async function git(root: string, ...args: string[]) { return (await exec('git', args, {cwd:root, maxBuffer: 4*1024*1024})).stdout.trim(); }
export async function repositoryRoot(cwd: string) { return git(cwd,'rev-parse','--show-toplevel'); }
export async function prepareWorktree(root: string, id: string, commit?: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid worktree id');
  const base = commit ?? await git(root, 'rev-parse', 'HEAD');
  const dir = join(await git(root,'rev-parse','--path-format=absolute','--git-common-dir'),'subagent-worktrees');
  await mkdir(dir,{recursive:true});
  const path = join(dir,id), branch = `subagents/${id}`;
  try { await git(root,'worktree','add','-b',branch,path,base); }
  catch (e) { throw new Error(`Could not create worktree; inspect ${path} and branch ${branch}: ${String(e)}`); }
  return {path,branch,base};
}

export async function checkProjectResources(root: string, base?: string) {
  const output = await git(root,'status','--porcelain=v1','--untracked-files=all','--ignored','--','.pi','AGENTS.md',':(glob)**/AGENTS.md',':(glob)**/.pi/**');
  if (base) {
    const changed = await git(root,'diff','--name-only',base,'HEAD','--','.pi','AGENTS.md',':(glob)**/AGENTS.md',':(glob)**/.pi/**');
    if (changed) throw new Error(`Project resources changed after captured base:\n${changed}`);
  }
  if (output) throw new Error(`Uncommitted project agent resources are not present in worktree base:\n${output}`);
}

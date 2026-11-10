import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareWorktree} from '../extensions/src/worktree.ts';

test('creates an isolated worktree and retains its edits', async () => {
 const root=mkdtempSync(join(tmpdir(),'subagent-git-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init'); git('config','commit.gpgsign','false'); git('config','user.email','test@example.test'); git('config','user.name','Test');
 writeFileSync(join(root,'tracked'),'base'); git('add','.'); git('commit','-m','base');
 const w=await prepareWorktree(root,'test-agent');
 writeFileSync(join(w.path,'tracked'),'changed');
 assert.equal(readFileSync(join(root,'tracked'),'utf8'),'base');
 assert.equal(readFileSync(join(w.path,'tracked'),'utf8'),'changed');
});

test('refuses worktree launch when project instructions have uncommitted edits', async () => {
 const {checkProjectResources}=await import('../extensions/src/worktree.ts');
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'subagent-resources-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init'); git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');
 mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','x.md'),'base');writeFileSync(join(root,'AGENTS.md'),'base');
 git('add','.');git('commit','-m','base');
 writeFileSync(join(root,'AGENTS.md'),'changed');
 await assert.rejects(checkProjectResources(root),/AGENTS.md/);
});

test('detects instructions committed after the captured base', async () => {
 const {checkProjectResources,git: runGit}=await import('../extensions/src/worktree.ts');
 const root=mkdtempSync(join(tmpdir(),'subagent-base-'));
 const g=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 g('init');g('config','commit.gpgsign','false');g('config','user.email','test@example.test');g('config','user.name','Test');
 writeFileSync(join(root,'AGENTS.md'),'old');g('add','.');g('commit','-m','base');
 const base=await runGit(root,'rev-parse','HEAD');
 writeFileSync(join(root,'AGENTS.md'),'new');g('add','.');g('commit','-m','new');
 await assert.rejects(checkProjectResources(root,base),/AGENTS.md/);
});

test('maps symlinked parent cwd inside the worktree without escaping it', async () => {
 const {mkdirSync,symlinkSync,realpathSync}=await import('node:fs');
 const {worktreeCwd}=await import('../extensions/src/worktree.ts');
 const temp=mkdtempSync(join(tmpdir(),'subagent-symlink-'));
 const root=join(temp,'repo'),worktree=join(temp,'worktree'),link=join(temp,'repo-link');
 mkdirSync(join(root,'nested'),{recursive:true});mkdirSync(join(worktree,'nested'),{recursive:true});symlinkSync(root,link,'dir');
 assert.equal(worktreeCwd(root,join(link,'nested'),worktree),join(realpathSync(worktree),'nested'));
 assert.throws(()=>worktreeCwd(root,temp,worktree),/outside/i);
});

test('detects changes to all Pi project context files and agent skills', async () => {
 const {checkProjectResources}=await import('../extensions/src/worktree.ts');const {mkdirSync}=await import('node:fs');const {dirname}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'subagent-contexts-'));
 const g=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 g('init');g('config','commit.gpgsign','false');g('config','user.email','test@example.test');g('config','user.name','Test');
 const paths=['AGENTS.override.md','AGENTS.MD','CLAUDE.md','CLAUDE.MD','.agents/skills/test/SKILL.md','nested/.agents/skills/test/SKILL.md'];
 for(const path of paths){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),'base');}
 g('add','.');g('commit','-m','base');
 for(const path of paths){writeFileSync(join(root,path),'changed');await assert.rejects(checkProjectResources(root),/Uncommitted/,path);writeFileSync(join(root,path),'base');}
});

test('detects skill changes committed after the captured worktree base', async () => {
 const {checkProjectResources,git:runGit}=await import('../extensions/src/worktree.ts');const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'subagent-skill-base-'));const g=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 g('init');g('config','commit.gpgsign','false');g('config','user.email','test@example.test');g('config','user.name','Test');
 mkdirSync(join(root,'.agents','skills','test'),{recursive:true});const path=join(root,'.agents','skills','test','SKILL.md');
 writeFileSync(path,'old');g('add','.');g('commit','-m','base');const base=await runGit(root,'rev-parse','HEAD');
 writeFileSync(path,'new');g('add','.');g('commit','-m','new');
 await assert.rejects(checkProjectResources(root,base),/SKILL.md/);
});

test('rejects a worktree cwd that resolves outside the worktree', async () => {
 const {mkdirSync,symlinkSync}=await import('node:fs');const {worktreeCwd}=await import('../extensions/src/worktree.ts');
 const temp=mkdtempSync(join(tmpdir(),'subagent-target-')),root=join(temp,'repo'),worktree=join(temp,'worktree'),outside=join(temp,'outside');
 mkdirSync(join(root,'nested'),{recursive:true});mkdirSync(worktree);mkdirSync(outside);symlinkSync(outside,join(worktree,'nested'),'dir');
 assert.throws(()=>worktreeCwd(root,join(root,'nested'),worktree),/outside/i);
});

test('rejects project skills linked outside the repository before creating a worktree', async () => {
 const {checkProjectResources}=await import('../extensions/src/worktree.ts');const {mkdirSync,symlinkSync}=await import('node:fs');
 const base=mkdtempSync(join(tmpdir(),'subagent-external-skill-')),root=join(base,'repo'),outside=join(base,'outside');mkdirSync(root);mkdirSync(outside);mkdirSync(join(root,'.agents','skills'),{recursive:true});
 const g=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});g('init');g('config','commit.gpgsign','false');g('config','user.email','test@example.test');g('config','user.name','Test');
 writeFileSync(join(outside,'SKILL.md'),'---\nname: external\ndescription: external skill\n---\nbody');symlinkSync(outside,join(root,'.agents','skills','external'),'dir');g('add','.');g('commit','-m','base');
 await assert.rejects(checkProjectResources(root),/skill.*outside repository/i);
});

test('rejects tracked skill links that make the worktree read parent files', async () => {
 const {checkProjectResources,validateWorktreeSkillLinks}=await import('../extensions/src/worktree.ts');const {mkdirSync,symlinkSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'subagent-absolute-skill-'));mkdirSync(join(root,'.agents','skills'),{recursive:true});mkdirSync(join(root,'real-skill'));
 const g=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});g('init');g('config','commit.gpgsign','false');g('config','user.email','test@example.test');g('config','user.name','Test');
 writeFileSync(join(root,'real-skill','SKILL.md'),'---\nname: test\ndescription: test skill\n---\nbody');symlinkSync(join(root,'real-skill'),join(root,'.agents','skills','test'),'dir');g('add','.');g('commit','-m','base');
 await checkProjectResources(root);const worktree=await prepareWorktree(root,'test-agent');
 await assert.rejects(validateWorktreeSkillLinks(root,worktree.path),/worktree/i);
});

test('accepts internal relative skill links only when worktree contents match', async () => {
 const {checkProjectResources,validateWorktreeSkillLinks}=await import('../extensions/src/worktree.ts');const {mkdirSync,symlinkSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'subagent-relative-skill-'));mkdirSync(join(root,'.agents','skills'),{recursive:true});mkdirSync(join(root,'real-skill'));
 const g=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});g('init');g('config','commit.gpgsign','false');g('config','user.email','test@example.test');g('config','user.name','Test');
 const skill=join(root,'real-skill','SKILL.md');writeFileSync(skill,'---\nname: test\ndescription: test skill\n---\nbody');symlinkSync('../../real-skill',join(root,'.agents','skills','test'),'dir');g('add','.');g('commit','-m','base');
 await checkProjectResources(root);const worktree=await prepareWorktree(root,'test-agent');await validateWorktreeSkillLinks(root,worktree.path);
 writeFileSync(skill,'changed');await assert.rejects(validateWorktreeSkillLinks(root,worktree.path),/differs/i);
});

test('rejects external symlinks at auto-discovery root directories', async () => {
 const {checkProjectResources}=await import('../extensions/src/worktree.ts');const {mkdirSync,symlinkSync}=await import('node:fs');
 for(const name of ['.agents','.pi']) {
  const base=mkdtempSync(join(tmpdir(),'subagent-resource-root-')),root=join(base,'repo'),outside=join(base,'outside');mkdirSync(root);mkdirSync(outside);
  const g=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});g('init');g('config','commit.gpgsign','false');g('config','user.email','test@example.test');g('config','user.name','Test');
  symlinkSync(outside,join(root,name),'dir');g('add','.');g('commit','-m','base');
  await assert.rejects(checkProjectResources(root),/symlink resolves outside repository/i,name);
 }
});

test('rejects untracked symlinks at auto-discovery root directories', async () => {
 const {checkProjectResources}=await import('../extensions/src/worktree.ts');const {mkdirSync,symlinkSync}=await import('node:fs');
 for(const name of ['.agents','.pi']) {
  const base=mkdtempSync(join(tmpdir(),'subagent-untracked-root-')),root=join(base,'repo'),outside=join(base,'outside');mkdirSync(root);mkdirSync(outside);
  const g=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});g('init');g('config','commit.gpgsign','false');g('config','user.email','test@example.test');g('config','user.name','Test');
  writeFileSync(join(root,'tracked'),'base');g('add','.');g('commit','-m','base');symlinkSync(outside,join(root,name),'dir');
  await assert.rejects(checkProjectResources(root),/uncommitted|symlink resolves outside repository/i,name);
 }
});

test('preserves whitespace in the repository path and Git status output', async () => {
 const {mkdirSync,realpathSync}=await import('node:fs');const {repositoryRoot,git:runGit}=await import('../extensions/src/worktree.ts');
 const parent=mkdtempSync(join(tmpdir(),'subagent-whitespace-')),root=join(parent,'repository with trailing space ');mkdirSync(root);execFileSync('git',['init','-q'],{cwd:root});
 writeFileSync(join(root,'file.txt'),'first');execFileSync('git',['add','file.txt'],{cwd:root});execFileSync('git',['-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture'],{cwd:root});writeFileSync(join(root,'file.txt'),'second');
 assert.equal(await repositoryRoot(root),realpathSync(root));assert.match(await runGit(root,'status','--short'),/^ M file\.txt$/);
});

test('does not attribute a pre-existing worktree to a failed creation attempt', async () => {
 const {prepareWorktree,WorktreeCreationError}=await import('../extensions/src/worktree.ts');const root=mkdtempSync(join(tmpdir(),'subagent-existing-worktree-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');writeFileSync(join(root,'file'),'first');git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','first');const first=git('rev-parse','HEAD');
 await prepareWorktree(root,'existing',first);await assert.rejects(prepareWorktree(root,'existing',first),(error:unknown)=>{assert.ok(error instanceof WorktreeCreationError);assert.equal(error.worktree,undefined);return true;});writeFileSync(join(root,'file'),'second');git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','second');const second=git('rev-parse','HEAD');
 await assert.rejects(prepareWorktree(root,'existing',second),(error:unknown)=>{assert.ok(error instanceof WorktreeCreationError);assert.equal(error.worktree,undefined);return true;});
});

test('does not attribute another concurrent creation to the failed attempt', async () => {
 const {prepareWorktree,WorktreeCreationError}=await import('../extensions/src/worktree.ts');const root=mkdtempSync(join(tmpdir(),'subagent-concurrent-collision-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');writeFileSync(join(root,'file'),'work');git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');const base=git('rev-parse','HEAD');
 const results=await Promise.allSettled([prepareWorktree(root,'same-id',base),prepareWorktree(root,'same-id',base)]);const succeeded=results.filter(result=>result.status==='fulfilled'),failed=results.filter(result=>result.status==='rejected');assert.equal(succeeded.length,1);assert.equal(failed.length,1);const error=(failed[0] as PromiseRejectedResult).reason;assert.ok(error instanceof WorktreeCreationError);assert.equal(error.worktree,undefined);
});

import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareWorktree} from '../src/worktree.ts';

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
 const {checkProjectResources}=await import('../src/worktree.ts');
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
 const {checkProjectResources,git: runGit}=await import('../src/worktree.ts');
 const root=mkdtempSync(join(tmpdir(),'subagent-base-'));
 const g=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 g('init');g('config','commit.gpgsign','false');g('config','user.email','test@example.test');g('config','user.name','Test');
 writeFileSync(join(root,'AGENTS.md'),'old');g('add','.');g('commit','-m','base');
 const base=await runGit(root,'rev-parse','HEAD');
 writeFileSync(join(root,'AGENTS.md'),'new');g('add','.');g('commit','-m','new');
 await assert.rejects(checkProjectResources(root,base),/AGENTS.md/);
});

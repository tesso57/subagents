import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareWorktree,WorktreeCreationError} from '../extensions/src/worktree.ts';

test('marks a same-ID raw Git race as unverified', {timeout:10000,skip:process.platform==='win32'}, async () => {
 const root=mkdtempSync(join(tmpdir(),'subagent-raw-race-')),bin=mkdtempSync(join(tmpdir(),'subagent-raw-git-'));const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();const git=(...args:string[])=>execFileSync(realGit,args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');writeFileSync(join(root,'file'),'work');git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');const base=git('rev-parse','HEAD');
 const wrapper=join(bin,'git');writeFileSync(wrapper,`#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then "$SUBAGENT_RAW_TEST_GIT" "$@" || exit $?; fi\nexec "$SUBAGENT_RAW_TEST_GIT" "$@"\n`);chmodSync(wrapper,0o755);
 const oldPath=process.env.PATH,oldGit=process.env.SUBAGENT_RAW_TEST_GIT;process.env.PATH=bin+delimiter+(oldPath ?? '');process.env.SUBAGENT_RAW_TEST_GIT=realGit;
 try {await assert.rejects(prepareWorktree(root,'same-id',base),(error:unknown)=>{assert.ok(error instanceof WorktreeCreationError);assert.equal(error.worktree?.creation,'unverified');assert.equal(error.worktree?.branch,'subagents/same-id');return true;});}
 finally {if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;if(oldGit===undefined)delete process.env.SUBAGENT_RAW_TEST_GIT;else process.env.SUBAGENT_RAW_TEST_GIT=oldGit;}
});

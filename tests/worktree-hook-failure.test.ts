import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import extension from '../extensions/index.ts';

test('reports a registered worktree when post-checkout fails', {timeout:10000,skip:process.platform==='win32'}, async () => {
 const root=mkdtempSync(join(tmpdir(),'subagent-hook-failure-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-hook-failure-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 const hook=join(root,'.git','hooks','post-checkout');writeFileSync(hook,'#!/bin/sh\necho hook-failed >&2\nexit 1\n');chmodSync(hook,0o755);
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};const call=async(name:string,params:any)=>JSON.parse((await tools.get(name).execute('id',params,undefined,undefined,ctx)).content[0].text);
 try {const outcome=await call('subagent_start',{agent:'worker',task:'work',mode:'wait',workspace:'worktree'});const done=outcome.done[0];assert.equal(done.state,'failed');assert.match(done.error,/hook-failed/);assert.ok(done.worktree?.path);assert.equal(done.worktree.creation,'unverified');assert.equal(existsSync(done.worktree.path),true);assert.match(git('worktree','list','--porcelain'),new RegExp(done.worktree.branch));const status=await call('subagent_status',{});assert.deepEqual(status.find((entry:any)=>entry.id===outcome.id).worktree,done.worktree);}
 finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

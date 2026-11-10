import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {execFileSync} from 'node:child_process';
import extension from '../extensions/index.ts';

test('stopping during git worktree creation reports the retained worktree', {timeout:15000,skip:process.platform==='win32'}, async () => {
 const root=mkdtempSync(join(tmpdir(),'subagent-worktree-boundary-')),agentDir=mkdtempSync(join(tmpdir(),'subagent-worktree-boundary-cfg-')),bin=mkdtempSync(join(tmpdir(),'subagent-git-wrapper-'));
 const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();const git=(...args:string[])=>execFileSync(realGit,args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');mkdirSync(join(root,'.pi','agents'),{recursive:true});writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 const entered=join(bin,'entered'),release=join(bin,'release'),wrapper=join(bin,'git');
 writeFileSync(wrapper,`#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then\n  : > "$SUBAGENT_TEST_ENTERED"\n  while [ ! -f "$SUBAGENT_TEST_RELEASE" ]; do sleep 0.02; done\nfi\nexec "$SUBAGENT_TEST_REAL_GIT" "$@"\n`);chmodSync(wrapper,0o755);
 const old={path:process.env.PATH,agent:process.env.PI_CODING_AGENT_DIR,entered:process.env.SUBAGENT_TEST_ENTERED,release:process.env.SUBAGENT_TEST_RELEASE,real:process.env.SUBAGENT_TEST_REAL_GIT};
 process.env.PATH=bin+delimiter+(old.path ?? '');process.env.PI_CODING_AGENT_DIR=agentDir;process.env.SUBAGENT_TEST_ENTERED=entered;process.env.SUBAGENT_TEST_RELEASE=release;process.env.SUBAGENT_TEST_REAL_GIT=realGit;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};const call=async(name:string,params:any)=>JSON.parse((await tools.get(name).execute('id',params,undefined,undefined,ctx)).content[0].text);
 try {
  const started=await call('subagent_start',{agent:'worker',task:'work',mode:'background',workspace:'worktree'});assert.ok(started.id,JSON.stringify(started));
  const deadline=Date.now()+5000;while(!existsSync(entered) && Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(entered),'git worktree add was not reached');
  await call('subagent_stop',{id:started.id});writeFileSync(release,'release');const done=(await call('subagent_wait',{ids:[started.id]})).done[0];
  assert.equal(done.state,'stopped');assert.ok(done.worktree?.path);assert.equal(done.worktree.branch,`subagents/${started.id}`);assert.match(git('worktree','list','--porcelain'),new RegExp(done.worktree.branch));assert.equal(existsSync(done.worktree.path),true);
 } finally {
  writeFileSync(release,'release');await events.get('session_shutdown')();
  for(const [name,value] of Object.entries({PATH:old.path,PI_CODING_AGENT_DIR:old.agent,SUBAGENT_TEST_ENTERED:old.entered,SUBAGENT_TEST_RELEASE:old.release,SUBAGENT_TEST_REAL_GIT:old.real})) {if(value===undefined)delete process.env[name];else process.env[name]=value;}
 }
});

import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import extension from '../extensions/index.ts';
import {createMockPi} from './helpers/mock-pi.ts';
import {createFakeModel} from './helpers/fake-model.ts';

for(const workspace of ['shared','worktree'] as const) test(`starts an explicitly selected skill agent in ${workspace}`,{timeout:15000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'skill-agent-e2e-')),agentDir=mkdtempSync(join(tmpdir(),'skill-agent-cfg-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 git('init','-q');mkdirSync(join(root,'skills','factory','agents'),{recursive:true});mkdirSync(join(root,'nested'));writeFileSync(join(root,'nested','.keep'),'');
 const relativePath='skills/factory/agents/review.md',path=join(root,relativePath);
 writeFileSync(join(root,'skills','factory','SKILL.md'),'---\nname: factory\ndescription: factory skill\n---\nUse agents/review.md.');
 writeFileSync(path,'---\nname: review\ndescription: skill reviewer\n---\nSKILL_AGENT_SENTINEL');
 git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const fake=createFakeModel([{content:[{type:'text',text:'child completed'}]}]);const mock=createMockPi();
 Object.assign(mock.pi,{getActiveTools:()=>['read'],getAllTools:()=>[],sendMessage:()=>{}});extension(mock.pi);
 const ctx:any={cwd:join(root,'nested'),isProjectTrusted:()=>true,model:fake.model,modelRegistry:{getRegisteredProviderConfig:()=>({api:'openai-completions',apiKey:'fake',models:[fake.model],streamSimple:fake.stream}),getRegisteredNativeProvider:()=>undefined,getApiKeyForProvider:async()=>undefined},thinkingLevel:'off'};
 try {
  const tool:any=mock.tools.get('subagent_start');const result=await tool.execute('id',{agent:workspace==='shared'?path:relativePath,task:'work',mode:'wait',workspace},undefined,undefined,ctx);
  assert.equal(result.isError,undefined,JSON.stringify(result));const payload=JSON.parse(result.content[0].text);assert.equal(payload.done[0].state,'completed',JSON.stringify(payload));assert.match(JSON.stringify(fake.requests),/SKILL_AGENT_SENTINEL/);
  if(workspace==='worktree') {assert.ok(payload.done[0].worktree?.path);git('worktree','remove','--force',payload.done[0].worktree.path);}
  if(workspace==='worktree') {writeFileSync(path,'---\nname: review\ndescription: changed\n---\nDIRTY');const dirty=await tool.execute('id',{agent:relativePath,task:'work',mode:'wait',workspace},undefined,undefined,ctx);assert.equal(dirty.isError,true,JSON.stringify(dirty));assert.match(JSON.stringify(dirty.content),/differs from committed base/);}
 } finally {await mock.emit('session_shutdown',{type:'session_shutdown',reason:'quit'});if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;rmSync(root,{recursive:true,force:true});rmSync(agentDir,{recursive:true,force:true});}
});

test('worktree rejects a changed skill agent symlink even if the target content matches', {timeout:15000,skip:process.platform==='win32'}, async()=>{
 const {symlinkSync,unlinkSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'skill-agent-link-')),agentDir=mkdtempSync(join(tmpdir(),'skill-agent-link-cfg-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();git('init','-q');mkdirSync(join(root,'skills','factory','agents'),{recursive:true});
 const agents=join(root,'skills','factory','agents'),contents='---\nname: review\ndescription: reviewer\n---\nReview.';
 writeFileSync(join(agents,'first.md'),contents);writeFileSync(join(agents,'second.md'),contents);symlinkSync('first.md',join(agents,'review.md'));git('add','.');git('-c','commit.gpgsign=false','-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 unlinkSync(join(agents,'review.md'));symlinkSync('second.md',join(agents,'review.md'));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;const mock=createMockPi();Object.assign(mock.pi,{getActiveTools:()=>['read'],getAllTools:()=>[],sendMessage:()=>{}});extension(mock.pi);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{getRegisteredProviderConfig:()=>undefined},thinkingLevel:'off'};
 try {const tool:any=mock.tools.get('subagent_start');const result=await tool.execute('id',{agent:'skills/factory/agents/review.md',task:'work',mode:'wait',workspace:'worktree'},undefined,undefined,ctx);assert.equal(result.isError,undefined,JSON.stringify(result));const payload=JSON.parse(result.content[0].text);assert.equal(payload.done[0].state,'failed');assert.match(payload.done[0].error,/agent definition differs/i);if(payload.done[0].worktree?.path)git('worktree','remove','--force',payload.done[0].worktree.path);}
 finally {await mock.emit('session_shutdown',{type:'session_shutdown',reason:'quit'});if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;rmSync(root,{recursive:true,force:true});rmSync(agentDir,{recursive:true,force:true});}
});

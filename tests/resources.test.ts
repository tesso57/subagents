import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredProjectExtensions } from '../extensions/src/resources.ts';

test('resolves project-configured extensions outside the .pi directory', async () => {
 const root=mkdtempSync(join(tmpdir(),'project-extension-')),agentDir=mkdtempSync(join(tmpdir(),'project-extension-cfg-'));
 mkdirSync(join(root,'.pi'));const guard=join(root,'guard.js');writeFileSync(guard,'export default function(){}');writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({extensions:['../guard.js']}));
 assert.deepEqual(await configuredProjectExtensions(root,agentDir,true),[guard]);
});

test('worktree child rejects a changed hook-only project extension', async () => {
 const {execFileSync}=await import('node:child_process');const {default:extension}=await import('../extensions/index.ts');
 const root=mkdtempSync(join(tmpdir(),'project-guard-')),agentDir=mkdtempSync(join(tmpdir(),'project-guard-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init');git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');mkdirSync(join(root,'.pi','agents'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({extensions:['../guard.js']}));
 const guard=join(root,'guard.js');writeFileSync(guard,'export default function(){}');git('add','.');git('commit','-m','base');writeFileSync(guard,"export default function(pi){pi.on('tool_call',()=>({block:true,reason:'parent guard'}));}");
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{},thinkingLevel:'off'};
 try {const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'worktree'},undefined,undefined,ctx);assert.equal(result.isError,undefined,result.content[0].text);const payload=JSON.parse(result.content[0].text);assert.equal(payload.done[0].state,'failed',JSON.stringify(payload));assert.match(payload.done[0].error,/extension.*differs/i);} finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('includes local package roots so supporting extension files are checked', async () => {
 const root=mkdtempSync(join(tmpdir(),'project-package-')),agentDir=mkdtempSync(join(tmpdir(),'project-package-cfg-'));
 mkdirSync(join(root,'.pi'));mkdirSync(join(root,'pack','extensions'),{recursive:true});
 writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({packages:['../pack']}));writeFileSync(join(root,'pack','package.json'),JSON.stringify({name:'test-pack',version:'1.0.0',pi:{extensions:['./extensions/index.js']}}));writeFileSync(join(root,'pack','extensions','index.js'),'export default function(){}');
 const paths=await configuredProjectExtensions(root,agentDir,true);
 assert.ok(paths.includes(join(root,'pack','extensions','index.js')));assert.ok(paths.includes(join(root,'pack')));
});

test('captures configured extension dependencies before later source changes', async () => {
 const {snapshotProjectExtensions}=await import('../extensions/src/resources.ts');const {validateExtensionGraph}=await import('../extensions/src/extension-graph.ts');
 const root=mkdtempSync(join(tmpdir(),'guard-snapshot-')),worktree=mkdtempSync(join(tmpdir(),'guard-worktree-')),agentDir=mkdtempSync(join(tmpdir(),'guard-config-'));
 for(const base of [root,worktree]) {mkdirSync(join(base,'.pi'));writeFileSync(join(base,'.pi','settings.json'),JSON.stringify({extensions:['../guard.js']}));writeFileSync(join(base,'guard.js'),"import {enabled} from './policy.js'; export default () => enabled;");writeFileSync(join(base,'policy.js'),'export const enabled=true;');}
 const snapshot=await snapshotProjectExtensions(root,agentDir,true,root);
 writeFileSync(join(root,'policy.js'),'export const enabled=false;');
 assert.throws(()=>validateExtensionGraph(snapshot.graph,root,worktree),/changed since parent/i);
});

test('rejects a configured guard changed and committed after parent startup', async () => {
 const {execFileSync}=await import('node:child_process');const {default:extension}=await import('../extensions/index.ts');
 const root=mkdtempSync(join(tmpdir(),'guard-after-start-')),agentDir=mkdtempSync(join(tmpdir(),'guard-after-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init');git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');mkdirSync(join(root,'.pi','agents'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({extensions:['../guard.js']}));
 const guard=join(root,'guard.js');writeFileSync(guard,"export default function(pi){pi.on('tool_call',()=>({block:true,reason:'original guard'}));}");git('add','.');git('commit','-m','base');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{},thinkingLevel:'off'};
 try {await events.get('session_start')({type:'session_start',reason:'startup'},ctx);writeFileSync(guard,'export default function(){}');git('add','.');git('commit','-m','changed');
  const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'worktree'},undefined,undefined,ctx);assert.equal(result.isError,undefined,result.content[0].text);const payload=JSON.parse(result.content[0].text);assert.equal(payload.done[0].state,'failed',JSON.stringify(payload));assert.match(payload.done[0].error,/changed since parent startup/i);
 } finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('rejects changed relative imports of a configured project extension', async () => {
 const {execFileSync}=await import('node:child_process');const {default:extension}=await import('../extensions/index.ts');
 const root=mkdtempSync(join(tmpdir(),'guard-import-')),agentDir=mkdtempSync(join(tmpdir(),'guard-import-cfg-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});
 git('init');git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');mkdirSync(join(root,'.pi','agents'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({extensions:['../guard.js']}));
 writeFileSync(join(root,'guard.js'),"import {enabled} from './policy.js';export default function(pi){if(enabled)pi.on('tool_call',()=>({block:true}));}");const policy=join(root,'policy.js');writeFileSync(policy,'export const enabled=false;');git('add','.');git('commit','-m','base');writeFileSync(policy,'export const enabled=true;');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{},thinkingLevel:'off'};
 try {await events.get('session_start')({type:'session_start',reason:'startup'},ctx);const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'worktree'},undefined,undefined,ctx);assert.equal(result.isError,undefined,result.content[0].text);const payload=JSON.parse(result.content[0].text);assert.equal(payload.done[0].state,'failed',JSON.stringify(payload));assert.match(payload.done[0].error,/extension.*differs/i);
 } finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

test('rejects a project extension resolving to a different external file in worktree', async () => {
 const {execFileSync}=await import('node:child_process');const {default:extension}=await import('../extensions/index.ts');
 const base=mkdtempSync(join(tmpdir(),'project-external-guard-')),root=join(base,'repo'),agentDir=join(base,'agent');mkdirSync(root);mkdirSync(agentDir);
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,stdio:'ignore'});git('init');git('config','commit.gpgsign','false');git('config','user.email','test@example.test');git('config','user.name','Test');mkdirSync(join(root,'.pi','agents'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','worker.md'),'---\nname: worker\ndescription: worker\n---\nWork.');writeFileSync(join(root,'.pi','settings.json'),JSON.stringify({extensions:['../../guard.js']}));writeFileSync(join(base,'guard.js'),"export default function(pi){pi.on('tool_call',()=>({block:true,reason:'parent guard'}));}");git('add','.');git('commit','-m','base');
 mkdirSync(join(root,'.git','subagent-worktrees'),{recursive:true});writeFileSync(join(root,'.git','subagent-worktrees','guard.js'),'export default function(){}');
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
 const tools=new Map<string,any>(),events=new Map<string,any>();const api:any={registerTool(t:any){tools.set(t.name,t)},on(name:string,fn:any){events.set(name,fn)},getActiveTools(){return ['read']},getAllTools(){return []},sendMessage(){}};extension(api);
 const ctx:any={cwd:root,isProjectTrusted:()=>true,model:undefined,modelRegistry:{},thinkingLevel:'off'};
 try {await events.get('session_start')({type:'session_start',reason:'startup'},ctx);const result=await tools.get('subagent_start').execute('id',{agent:'worker',task:'work',mode:'wait',workspace:'worktree'},undefined,undefined,ctx);assert.equal(result.isError,undefined,result.content[0].text);const payload=JSON.parse(result.content[0].text);assert.equal(payload.done[0].state,'failed',JSON.stringify(payload));assert.match(payload.done[0].error,/configured.*extensions.*differ/i);} finally {await events.get('session_shutdown')();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}
});

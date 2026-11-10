import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { assertParentPrompts, hasOpaqueSystemContent, replayPromptSections } from '../extensions/src/parent-prompts.ts';

test('does not accept a prompt that merely contains the captured instruction', () => {
 assert.throws(()=>assertParentPrompts({systemPrompt:'ALLOW',appendSystemPrompts:[]},{preamble:'DISALLOW'}),/differs/);
 assert.throws(()=>assertParentPrompts({appendSystemPrompts:['ALLOW']},{addendum:'<addendum>\nDISALLOW\n</addendum>'}),/differs/);
});

test('replays system section patches and compares exact prompt sections', () => {
 const sections=replayPromptSections([
  {role:'system',content:'',sections:{preamble:'BASE',addendum:'<addendum>\nOLD\n</addendum>'}},
  {role:'system',content:'',sections:{addendum:'<addendum>\nNEW\n\nSECOND\n</addendum>'}},
 ] as any);
 assert.doesNotThrow(()=>assertParentPrompts({systemPrompt:'BASE',appendSystemPrompts:['NEW','SECOND']},sections));
});

test('verifies project context exactly rather than accepting changed instructions', () => {
 const snapshot={appendSystemPrompts:[],contextFiles:[{path:'/repo/AGENTS.md',content:'original'}]};
 const sections={project_context:'<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\nchanged\n</project_instructions>\n</project_context>'};
 assert.throws(()=>assertParentPrompts(snapshot,sections),/context/i);
});

test('maps parent project context paths to matching worktree files', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,realpathSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {mapContextFiles}=await import('../extensions/src/parent-prompts.ts');const tmp=mkdtempSync(join(tmpdir(),'context-map-'));const root=join(tmp,'root'),worktree=join(tmp,'worktree');mkdirSync(root);mkdirSync(worktree);
 const source=join(root,'AGENTS.md'),target=join(worktree,'AGENTS.md');writeFileSync(source,'rules');writeFileSync(target,'rules');
 assert.deepEqual(mapContextFiles(root,worktree,[{path:source,content:'rules'}]),[{path:realpathSync(target),content:'rules'}]);
 writeFileSync(target,'changed');assert.throws(()=>mapContextFiles(root,worktree,[{path:source,content:'rules'}]),/differs/);
});

test('preserves logical context paths and rejects project links outside the repository', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,realpathSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {mapContextFiles}=await import('../extensions/src/parent-prompts.ts');const tmp=mkdtempSync(join(tmpdir(),'context-link-')),root=join(tmp,'root'),worktree=join(tmp,'wt');
 mkdirSync(join(root,'rules'),{recursive:true});mkdirSync(join(worktree,'rules'),{recursive:true});
 writeFileSync(join(root,'rules','shared.md'),'rules');writeFileSync(join(worktree,'rules','shared.md'),'rules');
 symlinkSync('rules/shared.md',join(root,'AGENTS.md'));symlinkSync('rules/shared.md',join(worktree,'AGENTS.md'));
 assert.deepEqual(mapContextFiles(root,worktree,[{path:join(root,'AGENTS.md'),content:'rules'}]),[{path:join(realpathSync(worktree),'AGENTS.md'),content:'rules'}]);
 const outside=join(tmp,'outside.md');writeFileSync(outside,'outside');symlinkSync(outside,join(root,'CLAUDE.md'));
 assert.throws(()=>mapContextFiles(root,worktree,[{path:join(root,'CLAUDE.md'),content:'outside'}]),/outside/i);
});


test('detects observed nonempty system message content', () => {
 assert.equal(hasOpaqueSystemContent([{role:'system',content:''}]),false);
 assert.equal(hasOpaqueSystemContent([{role:'system',content:'additional instruction'}]),true);
 assert.equal(hasOpaqueSystemContent([{role:'user',content:'ordinary message'}]),false);
});

test('captures custom prompt sections and rejects built-in overrides or unobserved changes', async () => {
 const {captureCustomPromptSections}=await import('../extensions/src/parent-prompts.ts');
 const captured=captureCustomPromptSections({project_policy:'Follow the policy'},{preamble:'base',project_policy:'<project_policy>\nFollow the policy\n</project_policy>'});
 assert.equal(captured.project_policy,'Follow the policy');
 assert.throws(()=>captureCustomPromptSections({cwd:'/parent'},{cwd:'<cwd>\n/parent\n</cwd>'}),/built-in section cwd/);
 assert.throws(()=>captureCustomPromptSections({project_policy:'original'},{project_policy:'<project_policy>\nchanged\n</project_policy>'}),/differs/);
 assert.throws(()=>captureCustomPromptSections(undefined,{unknown:'<unknown>\nvalue\n</unknown>'}),/not available/);
});

test('treats an empty system text array as empty content', () => {
 assert.equal(hasOpaqueSystemContent([{role:'system',content:[]}]),false);
 assert.equal(hasOpaqueSystemContent([{role:'system',content:null}]),true);
 assert.equal(hasOpaqueSystemContent([{role:'system'}]),true);
 assert.equal(hasOpaqueSystemContent([{role:'system',content:[{type:'text',text:''}]}]),false);
 assert.equal(hasOpaqueSystemContent([{role:'system',content:[{type:'text',text:''},{type:'text',text:''}]}]),true);
 assert.equal(hasOpaqueSystemContent([{role:'system',content:[{type:'text',text:'policy'}]}]),true);
 assert.equal(hasOpaqueSystemContent([{role:'system',content:[{type:'image',data:'x'}]}]),true);
});

test('preserves a virtual context URI when mapping worktree instructions', async () => {
 const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {mapContextFiles}=await import('../extensions/src/parent-prompts.ts');
 const root=mkdtempSync(join(tmpdir(),'parent-context-root-')),worktree=mkdtempSync(join(tmpdir(),'parent-context-worktree-'));const file={path:'synthetic://policy',content:'virtual instructions'};
 assert.deepEqual(mapContextFiles(root,worktree,[file]),[file]);
});

test('maps relative context paths from the parent working directory', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,realpathSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {mapContextFiles}=await import('../extensions/src/parent-prompts.ts');
 const root=mkdtempSync(join(tmpdir(),'relative-context-root-')),worktree=mkdtempSync(join(tmpdir(),'relative-context-worktree-'));mkdirSync(join(root,'nested'));mkdirSync(join(worktree,'nested'));writeFileSync(join(root,'nested','policy.md'),'parent policy');writeFileSync(join(worktree,'nested','policy.md'),'different policy');
 const files=[{path:'policy.md',content:'parent policy'}];assert.throws(()=>mapContextFiles(root,worktree,files,join(root,'nested')),/differs/);writeFileSync(join(worktree,'nested','policy.md'),'parent policy');const mapped=mapContextFiles(root,worktree,files,join(root,'nested'));assert.equal(mapped[0].path,join(realpathSync(worktree),'nested','policy.md'));assert.equal(mapped[0].content,'parent policy');
});

test('maps file URL context paths to the matching worktree file URL', async () => {
 const {mkdtempSync,writeFileSync,realpathSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {pathToFileURL}=await import('node:url');const {mapContextFiles}=await import('../extensions/src/parent-prompts.ts');
 const root=mkdtempSync(join(tmpdir(),'url-context-root-')),worktree=mkdtempSync(join(tmpdir(),'url-context-worktree-'));writeFileSync(join(root,'policy.md'),'parent policy');writeFileSync(join(worktree,'policy.md'),'parent policy');const files=[{path:pathToFileURL(join(root,'policy.md')).href,content:'parent policy'}];
 assert.equal(mapContextFiles(root,worktree,files)[0].path,pathToFileURL(join(realpathSync(worktree),'policy.md')).href);
});

test('keeps a relative context outside the repository pointed at the same file', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,realpathSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {mapContextFiles}=await import('../extensions/src/parent-prompts.ts');
 const parent=mkdtempSync(join(tmpdir(),'outside-context-')),root=join(parent,'repo'),worktree=join(parent,'worktree');mkdirSync(root);mkdirSync(worktree);writeFileSync(join(parent,'global-policy.md'),'outside policy');
 const mapped=mapContextFiles(root,worktree,[{path:'../global-policy.md',content:'outside policy'}],root);assert.equal(mapped[0].path,join(realpathSync(parent),'global-policy.md'));
});

test('rejects a context path that leaves the repository through a directory symlink', {skip:process.platform==='win32'}, async () => {
 const {mkdtempSync,writeFileSync,symlinkSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {mapContextFiles}=await import('../extensions/src/parent-prompts.ts');
 const root=mkdtempSync(join(tmpdir(),'linked-context-root-')),worktree=mkdtempSync(join(tmpdir(),'linked-context-worktree-')),outside=mkdtempSync(join(tmpdir(),'linked-context-outside-'));writeFileSync(join(outside,'policy.md'),'outside');symlinkSync(outside,join(root,'link'),'dir');
 assert.throws(()=>mapContextFiles(root,worktree,[{path:join(root,'link','policy.md'),content:'outside'}]),/outside repository/i);
});

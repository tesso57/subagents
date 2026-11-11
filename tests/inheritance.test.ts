import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { explicitExtensions } from '../extensions/src/inheritance.ts';

test('captures CLI extensions including hook-only extensions', () => {
 assert.deepEqual(explicitExtensions(['node','pi','-e','./guard.ts','--extension','/tmp/hook.ts'],'/repo'),['/repo/guard.ts','/tmp/hook.ts']);
});

test('keeps package and built-in extension specifications intact', () => {
 assert.deepEqual(explicitExtensions(['node','pi','-e','npm:example','--extension','git:owner/repo','-e','builtin:mcp'],'/repo'),['npm:example','git:owner/repo','builtin:mcp']);
});

test('worktree maps repository-local explicit extensions and rejects changed definitions', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {mapWorktreeExtensions}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'inherit-root-')),worktree=mkdtempSync(join(tmpdir(),'inherit-wt-'));
 mkdirSync(join(root,'scripts'));mkdirSync(join(worktree,'scripts'));
 const source=join(root,'scripts','guard.js'),target=join(worktree,'scripts','guard.js');
 writeFileSync(source,'same');writeFileSync(target,'same');
 assert.deepEqual(mapWorktreeExtensions(root,worktree,[source,'npm:foo']),[target,'npm:foo']);
 writeFileSync(target,'old');assert.throws(()=>mapWorktreeExtensions(root,worktree,[source]),/differs/);
});

test('worktree maps project skill directories without reading parent copies', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs'); const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {mapWorktreeSkills}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'skill-root-')),worktree=mkdtempSync(join(tmpdir(),'skill-wt-'));
 const from=join(root,'skill'),to=join(worktree,'skill');mkdirSync(from);mkdirSync(to);writeFileSync(join(from,'SKILL.md'),'same');writeFileSync(join(to,'SKILL.md'),'same');
 assert.deepEqual(mapWorktreeSkills(root,worktree,[from]),[to]);
 writeFileSync(join(from,'SKILL.md'),'new');assert.throws(()=>mapWorktreeSkills(root,worktree,[from]),/differs/);
});

test('worktree supports directory-based extensions', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeExtensions}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'ext-root-')),worktree=mkdtempSync(join(tmpdir(),'ext-wt-'));
 mkdirSync(join(root,'extension'));mkdirSync(join(worktree,'extension'));writeFileSync(join(root,'extension','index.ts'),'same');writeFileSync(join(worktree,'extension','index.ts'),'same');
 assert.deepEqual(mapWorktreeExtensions(root,worktree,[join(root,'extension')]),[join(worktree,'extension')]);
});

test('preserves remote Git URLs when inheriting explicit extensions', () => {
 const sources=['https://github.com/example/ext','ssh://git@example.org/org/ext'];
 assert.deepEqual(explicitExtensions(['node','pi','-e',sources[0],'-e',sources[1]],'/repo'),sources);
});

test('captures parent CLI system prompts in their original order', async () => {
 const {explicitSystemPrompts}=await import('../extensions/src/inheritance.ts');
 const argv=['node','pi','--system-prompt','BASE','--append-system-prompt','FIRST','--append-system-prompt','SECOND','--','--system-prompt','IGNORE'];
 assert.deepEqual(explicitSystemPrompts(argv),{systemPrompt:'BASE',appendSystemPrompts:['FIRST','SECOND']});
 assert.deepEqual(explicitSystemPrompts(['node','pi']),{});
});

test('snapshots CLI prompt file contents before they are modified', async () => {
 const {mkdtempSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {snapshotSystemPrompts}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'prompt-snapshot-')),file=join(root,'instructions.md');
 writeFileSync(file,'Original instruction');
 const snapshot=snapshotSystemPrompts(['node','pi','--append-system-prompt',file]);
 writeFileSync(file,'Changed instruction');
 assert.deepEqual(snapshot,{appendSystemPrompts:['Original instruction']});
});

test('snapshots discovered prompts with project precedence and CLI overrides', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {snapshotDiscoveredSystemPrompts}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'project-prompt-')),agentDir=mkdtempSync(join(tmpdir(),'global-prompt-'));
 mkdirSync(join(root,'.pi'));writeFileSync(join(agentDir,'SYSTEM.md'),'Global system');writeFileSync(join(agentDir,'APPEND_SYSTEM.md'),'Global append');writeFileSync(join(root,'.pi','SYSTEM.md'),'Project system');
 assert.deepEqual(snapshotDiscoveredSystemPrompts(root,agentDir,true,{}),{systemPrompt:'Project system',appendSystemPrompts:['Global append']});
 assert.deepEqual(snapshotDiscoveredSystemPrompts(root,agentDir,false,{}),{systemPrompt:'Global system',appendSystemPrompts:['Global append']});
 assert.deepEqual(snapshotDiscoveredSystemPrompts(root,agentDir,true,{systemPrompt:'CLI',appendSystemPrompts:['CLI append']}),{systemPrompt:'CLI',appendSystemPrompts:['CLI append']});
});

test('does not mistake CLI option values for other Pi flags', async () => {
 const {cliDisabled,explicitSkills,explicitSystemPrompts}=await import('../extensions/src/inheritance.ts');
 const argv=['node','pi','--append-system-prompt','--no-skills','--system-prompt','-e','--','--skill','ignored'];
 assert.equal(cliDisabled(argv,'--no-skills'),false);
 assert.deepEqual(explicitExtensions(argv,'/repo'),[]);
 assert.deepEqual(explicitSkills(argv,'/repo'),[]);
 assert.deepEqual(explicitSystemPrompts(argv),{systemPrompt:'-e',appendSystemPrompts:['--no-skills']});
});

test('resolves home-relative CLI resource paths like Pi', async () => {
 const {homedir}=await import('node:os');const {join}=await import('node:path');const {explicitSkills}=await import('../extensions/src/inheritance.ts');
 assert.deepEqual(explicitExtensions(['node','pi','-e','~/guard.ts'],'/repo'),[join(homedir(),'guard.ts')]);
 assert.deepEqual(explicitSkills(['node','pi','--skill','~/skills/check'],'/repo'),[join(homedir(),'skills/check')]);
});


test('does not inherit unsupported equals-form extension flags', () => {
 assert.deepEqual(explicitExtensions(['node','pi','--extension=not-loaded'],'/repo'),[]);
});

test('inherits Pi no-mcp while retaining explicit skill arguments', async () => {
 const {cliDisabled,explicitSkills}=await import('../extensions/src/inheritance.ts');
 const argv=['node','pi','--no-mcp','--no-skills','--skill','./skill'];
 assert.equal(cliDisabled(argv,'--no-mcp'),true);
 assert.equal(cliDisabled(argv,'--no-skills'),true);
 assert.deepEqual(explicitSkills(argv,'/repo'),['/repo/skill']);
});

test('maps explicitly selected resources through a repository symlink into the worktree', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,realpathSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {mapWorktreeExtensions,mapWorktreeSkills}=await import('../extensions/src/inheritance.ts');
 const base=mkdtempSync(join(tmpdir(),'resource-alias-')),root=join(base,'repo'),worktree=join(base,'wt'),alias=join(base,'alias');mkdirSync(root);mkdirSync(worktree);symlinkSync(root,alias,'dir');
 writeFileSync(join(root,'guard.js'),'same');writeFileSync(join(worktree,'guard.js'),'same');mkdirSync(join(root,'skill'));mkdirSync(join(worktree,'skill'));writeFileSync(join(root,'skill','SKILL.md'),'same');writeFileSync(join(worktree,'skill','SKILL.md'),'same');
 assert.deepEqual(mapWorktreeExtensions(realpathSync(root),realpathSync(worktree),[join(alias,'guard.js')]),[join(realpathSync(worktree),'guard.js')]);
 assert.deepEqual(mapWorktreeSkills(realpathSync(root),realpathSync(worktree),[join(alias,'skill')]),[join(realpathSync(worktree),'skill')]);
});

test('rejects a repository-local resource symlink that resolves outside the repository', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeExtensions}=await import('../extensions/src/inheritance.ts');
 const tmp=mkdtempSync(join(tmpdir(),'resource-outside-')),root=join(tmp,'repo'),worktree=join(tmp,'wt'),outside=join(tmp,'outside.js');mkdirSync(root);mkdirSync(worktree);writeFileSync(outside,'outside');symlinkSync(outside,join(root,'guard.js'));
 assert.throws(()=>mapWorktreeExtensions(root,worktree,[join(root,'guard.js')]),/resolves outside repository/i);
});

test('rejects a mapped resource whose worktree path traverses a symlink outside it', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeExtensions}=await import('../extensions/src/inheritance.ts');
 const tmp=mkdtempSync(join(tmpdir(),'resource-wt-link-')),root=join(tmp,'repo'),worktree=join(tmp,'wt'),outside=join(tmp,'outside');mkdirSync(join(root,'nested'),{recursive:true});mkdirSync(worktree);mkdirSync(outside);
 writeFileSync(join(root,'nested','guard.js'),'same');writeFileSync(join(outside,'guard.js'),'same');symlinkSync(outside,join(worktree,'nested'),'dir');
 assert.throws(()=>mapWorktreeExtensions(root,worktree,[join(root,'nested','guard.js')]),/outside worktree/i);
});

test('rejects a project resource whose parent directory points outside the repository', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeExtensions}=await import('../extensions/src/inheritance.ts');
 const tmp=mkdtempSync(join(tmpdir(),'resource-parent-link-')),root=join(tmp,'repo'),worktree=join(tmp,'wt'),outside=join(tmp,'outside');mkdirSync(root);mkdirSync(worktree);mkdirSync(outside);writeFileSync(join(outside,'guard.js'),'outside');symlinkSync(outside,join(root,'linked'),'dir');
 assert.throws(()=>mapWorktreeExtensions(root,worktree,[join(root,'linked','guard.js')]),/resolves outside repository/i);
});

test('accepts matching internal symlinks inside a mapped skill directory', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeSkills}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'skill-links-root-')),worktree=mkdtempSync(join(tmpdir(),'skill-links-wt-'));
 for(const base of [root,worktree]) {mkdirSync(join(base,'skill','refs'),{recursive:true});writeFileSync(join(base,'skill','SKILL.md'),'body');writeFileSync(join(base,'skill','refs','guide.md'),'guide');symlinkSync('refs/guide.md',join(base,'skill','guide.md'));}
 assert.deepEqual(mapWorktreeSkills(root,worktree,[join(root,'skill')]),[join(worktree,'skill')]);
});

test('rejects mapped skill links to different or external files', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,unlinkSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeSkills}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'skill-links-root-')),worktree=mkdtempSync(join(tmpdir(),'skill-links-wt-')),outside=join(mkdtempSync(join(tmpdir(),'skill-outside-')),'outside.md');
 for(const base of [root,worktree]) {mkdirSync(join(base,'skill','refs'),{recursive:true});writeFileSync(join(base,'skill','SKILL.md'),'body');writeFileSync(join(base,'skill','refs','one.md'),'same');writeFileSync(join(base,'skill','refs','two.md'),'same');}
 writeFileSync(outside,'same');symlinkSync('refs/one.md',join(root,'skill','guide.md'));symlinkSync('refs/two.md',join(worktree,'skill','guide.md'));
 assert.throws(()=>mapWorktreeSkills(root,worktree,[join(root,'skill')]),/differs/);
 unlinkSync(join(worktree,'skill','guide.md'));symlinkSync(outside,join(worktree,'skill','guide.md'));
 assert.throws(()=>mapWorktreeSkills(root,worktree,[join(root,'skill')]),/differs/);
});

test('handles matching symlink cycles without unbounded recursion', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeSkills}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'skill-cycle-root-')),worktree=mkdtempSync(join(tmpdir(),'skill-cycle-wt-'));
 for(const base of [root,worktree]) {mkdirSync(join(base,'skill'));writeFileSync(join(base,'skill','SKILL.md'),'body');symlinkSync('.',join(base,'skill','self'),'dir');}
 assert.deepEqual(mapWorktreeSkills(root,worktree,[join(root,'skill')]),[join(worktree,'skill')]);
});

test('compares symlink targets outside the skill directory before accepting them', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,symlinkSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeSkills}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'skill-link-target-root-')),worktree=mkdtempSync(join(tmpdir(),'skill-link-target-wt-'));
 for(const base of [root,worktree]) {mkdirSync(join(base,'skill'));mkdirSync(join(base,'shared'));writeFileSync(join(base,'skill','SKILL.md'),'body');writeFileSync(join(base,'shared','guide.md'),'original');symlinkSync('../shared/guide.md',join(base,'skill','guide.md'));}
 writeFileSync(join(worktree,'shared','guide.md'),'changed');
 assert.throws(()=>mapWorktreeSkills(root,worktree,[join(root,'skill')]),/differs/);
});

test('rejects a mapped skill script with different executable permissions', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,chmodSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeSkills}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'skill-mode-root-')),worktree=mkdtempSync(join(tmpdir(),'skill-mode-wt-'));
 for(const base of [root,worktree]) {mkdirSync(join(base,'skill'));writeFileSync(join(base,'skill','SKILL.md'),'body');writeFileSync(join(base,'skill','run.sh'),'#!/bin/sh\n');}
 chmodSync(join(root,'skill','run.sh'),0o755);chmodSync(join(worktree,'skill','run.sh'),0o644);
 assert.throws(()=>mapWorktreeSkills(root,worktree,[join(root,'skill')]),/differs/);
 chmodSync(join(worktree,'skill','run.sh'),0o755);assert.doesNotThrow(()=>mapWorktreeSkills(root,worktree,[join(root,'skill')]));
});

test('does not reject identical extension sources solely for generated node_modules', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeExtensions}=await import('../extensions/src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'ext-deps-root-')),worktree=mkdtempSync(join(tmpdir(),'ext-deps-wt-'));
 for(const base of [root,worktree]) {mkdirSync(join(base,'pack'));writeFileSync(join(base,'pack','package.json'),'{}');writeFileSync(join(base,'pack','index.js'),'export default function(){}');}
 mkdirSync(join(root,'pack','node_modules','unused'),{recursive:true});writeFileSync(join(root,'pack','node_modules','unused','index.js'),'unused');
 assert.deepEqual(mapWorktreeExtensions(root,worktree,[join(root,'pack')]),[join(worktree,'pack')]);
});

test('inherits a CLI key only when it is the selected provider credential', async () => {
 const {runtimeApiKeyForChild}=await import('../extensions/src/inheritance.ts');
 const argv=['node','pi','--api-key','placeholder-test-key'];
 const resolve=async (provider:string)=>provider==='alpha' ? 'placeholder-test-key' : 'different-key';
 assert.equal(await runtimeApiKeyForChild(argv,'alpha',resolve),'placeholder-test-key');
 assert.equal(await runtimeApiKeyForChild(argv,'beta',resolve),undefined);
 assert.equal(await runtimeApiKeyForChild(argv,undefined,resolve),undefined);
 assert.equal(await runtimeApiKeyForChild(['node','pi','--','--api-key','placeholder-test-key'],'alpha',resolve),undefined);
});

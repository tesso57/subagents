import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { explicitExtensions } from '../src/inheritance.ts';

test('captures CLI extensions including hook-only extensions', () => {
 assert.deepEqual(explicitExtensions(['node','pi','-e','./guard.ts','--extension=/tmp/hook.ts'],'/repo'),['/repo/guard.ts','/tmp/hook.ts']);
});

test('keeps package and built-in extension specifications intact', () => {
 assert.deepEqual(explicitExtensions(['node','pi','-e','npm:example','--extension=git:owner/repo','-e','builtin:mcp'],'/repo'),['npm:example','git:owner/repo','builtin:mcp']);
});

test('worktree maps repository-local explicit extensions and rejects changed definitions', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {mapWorktreeExtensions}=await import('../src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'inherit-root-')),worktree=mkdtempSync(join(tmpdir(),'inherit-wt-'));
 mkdirSync(join(root,'scripts'));mkdirSync(join(worktree,'scripts'));
 const source=join(root,'scripts','guard.js'),target=join(worktree,'scripts','guard.js');
 writeFileSync(source,'same');writeFileSync(target,'same');
 assert.deepEqual(mapWorktreeExtensions(root,worktree,[source,'npm:foo']),[target,'npm:foo']);
 writeFileSync(target,'old');assert.throws(()=>mapWorktreeExtensions(root,worktree,[source]),/differs/);
});

test('worktree maps project skill directories without reading parent copies', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs'); const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {mapWorktreeSkills}=await import('../src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'skill-root-')),worktree=mkdtempSync(join(tmpdir(),'skill-wt-'));
 const from=join(root,'skill'),to=join(worktree,'skill');mkdirSync(from);mkdirSync(to);writeFileSync(join(from,'SKILL.md'),'same');writeFileSync(join(to,'SKILL.md'),'same');
 assert.deepEqual(mapWorktreeSkills(root,worktree,[from]),[to]);
 writeFileSync(join(from,'SKILL.md'),'new');assert.throws(()=>mapWorktreeSkills(root,worktree,[from]),/differs/);
});

test('worktree supports directory-based extensions', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');const {tmpdir}=await import('node:os');const {mapWorktreeExtensions}=await import('../src/inheritance.ts');
 const root=mkdtempSync(join(tmpdir(),'ext-root-')),worktree=mkdtempSync(join(tmpdir(),'ext-wt-'));
 mkdirSync(join(root,'extension'));mkdirSync(join(worktree,'extension'));writeFileSync(join(root,'extension','index.ts'),'same');writeFileSync(join(worktree,'extension','index.ts'),'same');
 assert.deepEqual(mapWorktreeExtensions(root,worktree,[join(root,'extension')]),[join(worktree,'extension')]);
});

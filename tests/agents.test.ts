import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgent } from '../extensions/src/agents.ts';

test('loads a named agent from the project and rejects traversal', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-test-'));
  mkdirSync(join(root,'.pi','agents'), {recursive:true});
  writeFileSync(join(root,'.pi','agents','reviewer.md'), '---\nname: reviewer\ndescription: review\nmodel: example\ntools: read, grep\n---\nReview carefully.\n');
  const agent = loadAgent(root,'reviewer');
  assert.equal(agent.prompt, 'Review carefully.');
  assert.deepEqual(agent.tools, ['read','grep']);
  assert.throws(() => loadAgent(root,'../secret'));
});

test('refuses invalid tool configuration rather than granting defaults', () => {
 const root=mkdtempSync(join(tmpdir(),'agent-invalid-'));
 mkdirSync(join(root,'.pi','agents'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','bad.md'),'---\nname: bad\ndescription: bad\ntools: 123\n---\nDo work.\n');
 assert.throws(()=>loadAgent(root,'bad'),/tools/);
});

test('loads an explicit repository skill agent by relative or absolute path without name collisions', () => {
 const root=mkdtempSync(join(tmpdir(),'skill-agent-'));
 mkdirSync(join(root,'.pi','agents'),{recursive:true});mkdirSync(join(root,'.pi','skills','factory','agents'),{recursive:true});
 writeFileSync(join(root,'.pi','agents','review.md'),'---\nname: review\ndescription: default\n---\nDefault.');
 const path=join(root,'.pi','skills','factory','agents','review.md');writeFileSync(path,'---\nname: review\ndescription: skill\n---\nSkill instructions.');
 assert.equal(loadAgent(root,'review').prompt,'Default.');
 assert.equal(loadAgent(root,'.pi/skills/factory/agents/review.md').prompt,'Skill instructions.');
 assert.equal(loadAgent(root,path).prompt,'Skill instructions.');
});

test('rejects explicit agent paths outside the repository, including symlinks', async () => {
 const {symlinkSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'skill-agent-root-')),outside=mkdtempSync(join(tmpdir(),'skill-agent-outside-'));
 writeFileSync(join(outside,'review.md'),'---\nname: review\ndescription: outside\n---\nOutside.');
 assert.throws(()=>loadAgent(root,join(outside,'review.md')),/inside repository/i);
 if(process.platform!=='win32'){symlinkSync(outside,join(root,'link'),'dir');assert.throws(()=>loadAgent(root,'link/review.md'),/inside repository/i);}
});

test('rejects paths that do not name a Markdown file matching frontmatter', () => {
 const root=mkdtempSync(join(tmpdir(),'skill-agent-invalid-'));mkdirSync(join(root,'agents'));writeFileSync(join(root,'agents','review.md'),'---\nname: other\ndescription: wrong name\n---\nNo.');writeFileSync(join(root,'agents','review.txt'),'---\nname: review\ndescription: wrong extension\n---\nNo.');
 assert.throws(()=>loadAgent(root,'agents/review.md'),/frontmatter/i);assert.throws(()=>loadAgent(root,'agents/review.txt'),/agent.*(path|name)/i);
});

test('rejects a path that leaves the repository through a symlink and returns', {skip:process.platform==='win32'}, async () => {
 const {symlinkSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'skill-agent-link-root-')),outside=mkdtempSync(join(tmpdir(),'skill-agent-link-out-'));
 writeFileSync(join(root,'review.md'),'---\nname: review\ndescription: review\n---\nReview.');
 symlinkSync(outside,join(root,'outside'),'dir');symlinkSync(root,join(outside,'back'),'dir');
 assert.throws(()=>loadAgent(root,join(root,'outside','back','review.md')),/inside repository/i);
});

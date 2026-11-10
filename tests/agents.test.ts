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

import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

test('Pi loads the extension entrypoint and registers subagent tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-smoke-'));
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, 'agent'),
      additionalExtensionPaths: [resolve('extensions/index.ts')],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    const extension = result.extensions.find(item => item.resolvedPath === resolve('extensions/index.ts'));
    assert.ok(extension, 'Pi did not load the extension');
    for (const name of ['subagent_start', 'subagent_wait', 'subagent_reply', 'subagent_stop']) {
      assert.ok(extension.tools.has(name), `Pi did not register ${name}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Exercise the files users receive, using the already-installed dependencies.
test('Pi loads the npm archive after extraction', {skip: process.platform === 'win32'}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-package-'));
  try {
    const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], {
      encoding: 'utf8',
      env: {...process.env, npm_config_cache: join(dir, 'npm-cache')},
    });
    const [{filename}] = JSON.parse(output) as Array<{filename: string}>;
    execFileSync('tar', ['-xzf', join(dir, filename), '-C', dir]);
    const packageDir = join(dir, 'package');
    await symlink(resolve('node_modules'), join(packageDir, 'node_modules'), 'dir');
    const entrypoint = join(packageDir, 'extensions', 'index.ts');
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: join(dir, 'agent'), additionalExtensionPaths: [entrypoint],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    const extension = result.extensions.find(item => item.resolvedPath === entrypoint);
    assert.ok(extension, 'Pi did not load the extracted extension');
    for (const name of ['subagent_start', 'subagent_wait', 'subagent_reply', 'subagent_stop']) {
      assert.ok(extension.tools.has(name), `Pi did not register ${name}`);
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

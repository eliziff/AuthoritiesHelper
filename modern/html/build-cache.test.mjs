import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { cached, inputStamp } from './build-cache.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'authorities-cache-'));
try {
  const cache = path.join(root, 'cache'), source = path.join(root, 'source');
  mkdirSync(source);
  const module = path.join(source, 'entry.tsx'), excluded = path.join(source, 'entry.test.tsx');
  const config = path.join(root, 'vite.config.ts'), env = path.join(root, '.env.authorities-dev');
  for (const file of [module, excluded, config, env]) writeFileSync(file, 'initial');
  let builds = 0;
  const step = async () => ({ value: ++builds, inputs: [module, config, env], watch: [module, 'source/**/*.tsx'] });
  const read = async (key = 'dev:env1') => {
    await setTimeout(10); // Start after this check's preceding filesystem mutation.
    return cached(cache, 'frontend', key, step, root);
  };
  assert.equal(await read(), 1);
  assert.equal(await read(), 1);
  writeFileSync(path.join(root, 'unrelated-doc.md'), 'unrelated');
  writeFileSync(excluded, 'excluded test changed');
  assert.equal(await read(), 1, 'unread docs and excluded existing tests do not rebuild');
  writeFileSync(module, 'module changed');
  assert.equal(await read(), 2);
  const added = path.join(source, 'new-component.tsx');
  writeFileSync(added, '<div className="new-class"/>');
  assert.equal(await read(), 3, 'new CSS sources are noticed without imports');
  rmSync(added);
  assert.equal(await read(), 4, 'deleted CSS sources invalidate');
  writeFileSync(config, 'config/import changed');
  assert.equal(await read(), 5);
  rmSync(env);
  assert.equal(await read(), 6, 'removed optional env input invalidates');
  assert.equal(await read('dev:env2'), 7, 'process environment belongs to the key');
  assert.equal(await read('release:env2'), 8, 'release and development output cannot alias');
  let changingBuilds = 0;
  const changing = async () => {
    const observed = { [env]: inputStamp(env) };
    writeFileSync(env, 'changed during build');
    return { value: ++changingBuilds, inputs: [env], observed };
  };
  await cached(cache, 'changing', '', changing, root);
  await setTimeout(10);
  assert.equal(await cached(cache, 'changing', '', changing, root), 2, 'changed-during-build output is not reused');
  const deletedDuringBuild = async () => {
    writeFileSync(module, 'read by build');
    rmSync(module);
    return { value: ++changingBuilds, inputs: [module], watch: [module] };
  };
  await cached(cache, 'deleted', '', deletedDuringBuild, root);
  assert.equal(await cached(cache, 'deleted', '', deletedDuringBuild, root), 4, 'deleted-during-build output is not reused');
  console.log('Authorities cache: dependency scope, additions/deletions, config/env/profile and concurrent changes passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocate, localUri, lock, run, save } from '../src/core.mjs';
import { validateManifest, environmentValues, expand } from '../src/config.mjs';
import { gatewayConfig } from '../src/gateway.mjs';

test('occupied ports are retained by their owner', async () => {
  const owner = createServer();
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  try {
    const used = new Set(), port = await allocate(owner.address().port, used);
    assert.notEqual(port, owner.address().port);
    assert.ok(owner.listening);
    assert.notEqual(await allocate(port, used), port);
  } finally { owner.close(); }
});
test('exclusive locks reject duplicates and recover dead owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devhub-lock-'));
  const path = join(directory, 'lock');
  try {
    const release = await lock(path);
    await assert.rejects(lock(path), /Another hub operation/);
    await release();
    await save(path, { pid: 2147483647 });
    const next = await lock(path);
    assert.equal(JSON.parse(await readFile(path)).pid, process.pid);
    await next();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('URL transforms preserve authentication and isolate arbitrary paths', () => {
  const context = { services: { store: 49152, events: 49153 }, instance: { isWorktree: true, id: 'sandbox-branch', hash: '123abc' } };
  const source = { STORE: 'custom://user:secret@localhost:10000/records?option=keep', EVENTS: 'custom://localhost:10001/' };
  const env = environmentValues({
    DATA: { source: 'STORE', url: { port: 'store', worktreePath: 'suffix' } },
    EVENTS: { source: 'EVENTS', url: { port: 'events', worktreePath: 'instance' } },
  }, source, context);
  const data = new URL(env.DATA);
  assert.equal(data.pathname, '/records_123abc');
  assert.equal(data.port, '49152');
  assert.equal(data.password, 'secret');
  assert.equal(data.searchParams.get('option'), 'keep');
  assert.equal(new URL(env.EVENTS).pathname, '/sandbox-branch');
  assert.throws(() => localUri('custom://remote.example/production', 49152), /local connection/);
  assert.throws(() => expand('${missing.key}', {}), /Unknown configuration variable/);
});
test('manifest validation rejects traversal and unbound process routes', () => {
  assert.throws(() => validateManifest({ version: 2, id: 'sandbox', processes: { task: { command: ['node'], cwd: '../outside' } } }), /paths/);
  assert.throws(() => validateManifest({ version: 2, id: 'sandbox', processes: { task: { command: ['node'] } }, gateway: { primary: 'main', routes: [{ name: 'main', host: '${instance.id}.localhost', paths: [{ process: 'unknown' }] }] } }), /unknown route process/);
});
test('routing supports arbitrary process names, paths and service UIs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devhub-gateway-'));
  try {
    const gateway = { httpPort: 18080, httpsPort: 18443, adminPort: 12019 };
    const entries = [{ id: 'sandbox', url: 'https://sandbox.localhost:18443', routes: [
      { hostname: 'sandbox.localhost', paths: [{ match: ['/rpc', '/rpc/*'], port: 19000 }, { port: 19001 }] },
      { hostname: 'tools.sandbox.localhost', paths: [{ port: 19002 }] },
    ] }];
    const config = gatewayConfig(gateway, entries, join(directory, 'storage'));
    assert.ok(config.includes('"/rpc" "/rpc/*"'));
    assert.ok(!config.includes('handle_path'));
    assert.throws(() => gatewayConfig(gateway, [...entries, ...entries], directory), /duplicate local hostname/);
    const path = join(directory, 'Caddyfile');
    await writeFile(path, config);
    await run(process.env.DEVHUB_CADDY || 'caddy', ['validate', '--config', path, '--adapter', 'caddyfile'], { quiet: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shared infrastructure requires an explicit single sibling, without relaxing process paths', () => {
  const manifest = { version: 2, id: 'consumer', processes: { app: { command: ['node'] } }, infrastructure: { owner: '../shared-services', project: 'shared', file: 'docker-compose.yml', ports: { db: { service: 'db', target: 1234, variable: 'DB_PORT' } } } };
  assert.equal(validateManifest(manifest).infrastructure.owner, '../shared-services');
  for (const owner of ['/tmp/foreign', '../../foreign', '../parent/child', '..', 'https://example.com']) {
    assert.throws(() => validateManifest({ ...manifest, infrastructure: { ...manifest.infrastructure, owner } }), /owner/);
  }
  assert.throws(() => validateManifest({ ...manifest, processes: { app: { command: ['node'], cwd: '../shared-services' } } }), /paths/);
});

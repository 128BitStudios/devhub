import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { run, delay } from '../src/core.mjs';

const cli = fileURLToPath(new URL('../bin/devhub.mjs', import.meta.url));
test('independent arbitrary applications start, reuse ports, stop independently and handle conflicts', { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devhub-independent-'));
  const state = join(directory, 'state'), children = [];
  const roots = [join(directory, 'first'), join(directory, 'second')];
  const env = { ...process.env, DEVHUB_STATE_DIR: state };
  const invoke = (root, ...args) => run(process.execPath, [cli, ...args], { cwd: root, env, quiet: true });
  const start = async root => {
    const child = spawn(process.execPath, [cli, 'up'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    for (let i = 0; i < 150; i++) {
      if (output.includes('Configured processes are running')) return;
      if (child.exitCode !== null) throw new Error(output);
      await delay(100);
    }
    throw new Error('Supervisor readiness failed: ' + output);
  };
  let foreign;
  try {
    for (const [index, root] of roots.entries()) {
      await mkdir(root);
      await writeFile(join(root, '.env.example'), 'SAMPLE_SECRET=\n');
      await writeFile(join(root, 'listener.mjs'), `import {createServer} from 'node:http';createServer((q,s)=>s.end('ready')).listen(Number(process.env.BIND_PORT),'127.0.0.1');`);
      await writeFile(join(root, 'devhub.json'), JSON.stringify({
        version: 2, id: `sandbox-${index}`,
        setup: { envFiles: [{ path: '.env.local', example: '.env.example', generate: { SAMPLE_SECRET: { bytes: 32 } } }] },
        processes: { telemetry: { cwd: '.', envFile: '.env.local', command: [process.execPath, 'listener.mjs'], ready: '/ready', env: { BIND_PORT: '${ports.telemetry}' } } },
      }));
      await start(root);
    }
    const first = JSON.parse(await invoke(roots[0], 'status'));
    const second = JSON.parse(await invoke(roots[1], 'status'));
    assert.notEqual(first.ports.telemetry, second.ports.telemetry);
    assert.match(await invoke(roots[0], 'up'), /Already running/);
    const configBefore = await readFile(join(roots[0], '.env.local'), 'utf8');
    await invoke(roots[0], 'setup');
    assert.equal(await readFile(join(roots[0], '.env.local'), 'utf8'), configBefore);
    await invoke(roots[0], 'stop');
    assert.equal(await (await fetch(`http://127.0.0.1:${second.ports.telemetry}/ready`)).text(), 'ready');
    foreign = createServer();
    await new Promise(resolve => foreign.listen(first.ports.telemetry, '127.0.0.1', resolve));
    await start(roots[0]);
    const restarted = JSON.parse(await invoke(roots[0], 'status'));
    assert.notEqual(restarted.ports.telemetry, first.ports.telemetry);
    assert.ok(foreign.listening);
    await invoke(roots[0], 'stop');
    await invoke(roots[1], 'stop');
  } finally {
    foreign?.close();
    for (const root of roots) await invoke(root, 'stop').catch(() => {});
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  }
});
test('configured check failures stop subsequent commands', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'devhub-check-'));
  try {
    await writeFile(join(root, 'devhub.json'), JSON.stringify({ version: 2, id: 'sandbox', processes: { task: { command: [process.execPath, '-e', ''] } }, checks: [
      { command: [process.execPath, '-e', 'process.exit(7)'] },
      { command: [process.execPath, '-e', `require('fs').writeFileSync('unexpected','bad')`] },
    ] }));
    await assert.rejects(run(process.execPath, [cli, 'check'], { cwd: root, env: { ...process.env, DEVHUB_STATE_DIR: join(root, 'state') }, quiet: true }));
    await assert.rejects(readFile(join(root, 'unexpected')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('reset requires confirmation and runs only the repository hook', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'devhub-reset-'));
  const env = { ...process.env, DEVHUB_STATE_DIR: join(root, 'state') };
  try {
    await writeFile(join(root, 'devhub.json'), JSON.stringify({ version: 2, id: 'sandbox', processes: { task: { command: [process.execPath, '-e', ''] } }, hooks: { reset: [
      { process: 'task', command: [process.execPath, '-e', `require('fs').writeFileSync('hook-result', process.env.DEVHUB_INSTANCE_ID)`] },
    ] } }));
    await assert.rejects(run(process.execPath, [cli, 'reset'], { cwd: root, env, quiet: true }));
    await assert.rejects(readFile(join(root, 'hook-result')), { code: 'ENOENT' });
    await run(process.execPath, [cli, 'reset', '--confirm'], { cwd: root, env, quiet: true });
    assert.equal(await readFile(join(root, 'hook-result'), 'utf8'), 'sandbox');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an explicit Compose owner must be a sibling Git root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devhub-owner-'));
  const root = join(directory, 'consumer'), owner = join(directory, 'services');
  try {
    await mkdir(root); await mkdir(owner);
    await run('git', ['init', '-q'], { cwd: root, quiet: true });
    await run('git', ['init', '-q'], { cwd: owner, quiet: true });
    const manifest = { version: 2, id: 'consumer', processes: { app: { command: ['node'] } }, infrastructure: { owner: '../services', project: 'shared', file: 'docker-compose.yml', ports: { db: { service: 'db', target: 1234, variable: 'DB_PORT' } } } };
    await writeFile(join(root, 'devhub.json'), JSON.stringify(manifest));
    assert.match(await run(process.execPath, [cli, 'validate'], { cwd: root, quiet: true }), /valid/i);
    await rm(join(owner, '.git'), { recursive: true, force: true });
    await assert.rejects(run(process.execPath, [cli, 'validate'], { cwd: root, quiet: true }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

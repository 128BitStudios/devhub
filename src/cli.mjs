#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync, openSync, closeSync, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { allocate, available, alive, delay, json, lock, origin, run, save, waitFor, withLock } from './core.mjs';
import { findRoot, safePath, validateManifest, expand, environmentValues } from './config.mjs';
import { gatewayConfig } from './gateway.mjs';

export async function main(cwd, argv) {
  const root = realpathSync(findRoot(cwd));
  const manifest = validateManifest(await json(join(root, 'devhub.json')));
  const stateRoot = process.env.DEVHUB_STATE_DIR || join(homedir(), platform() === 'darwin' ? 'Library/Application Support/Local Dev Hub' : '.local/state/devhub');
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 10);
  const commonGit = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, quiet: true }).catch(() => join(root, '.git'));
  const infrastructureRoot = dirname(commonGit);
  const isWorktree = realpathSync(infrastructureRoot) !== root;
  const id = manifest.id + (isWorktree ? `-${hash.slice(0, 6)}` : '');
  const instanceFile = join(stateRoot, 'instances', `${id}-${hash}.json`);
  const instanceLock = instanceFile + '.lock';
  const registryFile = join(stateRoot, 'registry.json');
  const gatewayFile = join(stateRoot, 'gateway.json');
  const caddyFile = join(stateRoot, 'Caddyfile');
  const globalLock = join(stateRoot, 'registry.lock');
  const logDirectory = join(root, '.devhub/logs');
  const command = argv[0] ?? 'up';
  const caddy = process.env.DEVHUB_CADDY || 'caddy';
  const local = port => `http://127.0.0.1:${port}`;
  const infrastructure = manifest.infrastructure;
  const composeRoot = infrastructure?.owner ? realpathSync(resolve(infrastructureRoot, infrastructure.owner)) : infrastructureRoot;
  if (infrastructure?.owner) {
    const ownerRoot = await run('git', ['rev-parse', '--show-toplevel'], { cwd: composeRoot, quiet: true });
    if (realpathSync(ownerRoot) !== composeRoot) throw new Error('Infrastructure owner must be a Git checkout root.');
  }
  const composeArgs = infrastructure ? ['compose', '-p', infrastructure.project, '-f', safePath(composeRoot, infrastructure.file)] : [];
  const compose = (args, env = {}, quiet = false) => run('docker', [...composeArgs, ...args], { cwd: composeRoot, env: { ...process.env, ...env }, quiet });

  async function supervisorAlive(entry) {
    if (!entry || !alive(entry.pid)) return false;
    try {
      const response = await fetch(local(entry.controlPort) + '/status', { headers: { Authorization: `Bearer ${entry.token}` }, signal: AbortSignal.timeout(2000) });
      return response.ok && (await response.json()).key === entry.key;
    } catch { return false; }
  }

  async function environment(name) {
    const item = manifest.processes[name];
    if (!item.envFile) return {};
    const path = safePath(root, item.envFile);
    if (!existsSync(path)) throw new Error(`Missing ${path}. Run devhub setup first.`);
    return parseEnv(await readFile(path, 'utf8'));
  }
  async function setup() {
    const dependencies = manifest.setup?.dependencies;
    if (dependencies && !existsSync(safePath(root, dependencies.check))) await run(dependencies.command[0], dependencies.command.slice(1), { cwd: root });
    for (const item of manifest.setup?.envFiles ?? []) {
      const target = safePath(root, item.path);
      if (existsSync(target)) continue;
      let contents = await readFile(safePath(root, item.example), 'utf8');
      for (const [key, generator] of Object.entries(item.generate ?? {})) {
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        if (!pattern.test(contents)) throw new Error(`Generated key ${key} is missing from ${item.example}`);
        contents = contents.replace(pattern, `${key}="${randomBytes(generator.bytes).toString(generator.encoding ?? 'base64')}"`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, { mode: 0o600, flag: 'wx' });
      console.log(`Created ${item.path}`);
    }
    if (manifest.gateway) await run(caddy, ['version'], { quiet: true }).catch(() => { throw new Error('Install Caddy before using HTTPS routing.'); });
    if (infrastructure) await run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
    console.log('Setup ready.');
  }
  async function infraStart() {
    if (!infrastructure) return {};
    return withLock(globalLock, async () => {
      const path = join(stateRoot, 'infrastructure', `${infrastructure.project}.json`);
      const previous = await json(path, {});
      const rows = (await compose(['ps', '--format', 'json'], {}, true)).split('\n').filter(Boolean).map(line => JSON.parse(line));
      const ports = {}, env = {}, used = new Set();
      for (const [key, item] of Object.entries(infrastructure.ports)) {
        const current = rows.find(row => row.Service === item.service && row.State === 'running')?.Publishers?.find(p => p.TargetPort === item.target)?.PublishedPort;
        ports[key] = current || await allocate(previous[key], used);
        used.add(ports[key]);
        env[item.variable] = String(ports[key]);
      }
      // Preserve the original Compose project and named volumes. Never evict port owners.
      console.log('Checking Docker services (existing data is retained)…');
      await compose(['up', '-d', '--wait', '--wait-timeout', '120', ...new Set(Object.values(infrastructure.ports).map(item => item.service))], env);
      for (const [key, item] of Object.entries(infrastructure.ports)) {
        const mapping = await compose(['port', item.service, String(item.target)], env, true);
        ports[key] = Number(mapping.split('\n')[0].split(':').at(-1));
        if (!ports[key]) throw new Error(`No published port for ${item.service}.`);
      }
      await save(path, ports);
      return ports;
    });
  }
  async function gatewayUpdate(entry, remove = false) {
    return withLock(globalLock, async () => {
      let entries = await json(registryFile, []);
      if (!Array.isArray(entries)) throw new Error('Incompatible hub routing protocol.');
      // A crashed supervisor cannot leave a route pointing at a newly reused port.
      const live = await Promise.all(entries.map(item => supervisorAlive(item)));
      entries = entries.filter((item, index) => item.key !== hash && live[index]);
      if (!remove) entries.push(entry);
      let gateway = await json(gatewayFile);
      if (gateway?.protocolVersion && gateway.protocolVersion !== 1) throw new Error('Incompatible gateway protocol version.');
      if (!gateway) {
        // High ports avoid requiring administrator access on macOS/Linux.
        const httpPort = Number(process.env.DEVHUB_HTTP_PORT || (await available(80) ? 80 : 8080));
        const httpsPort = Number(process.env.DEVHUB_HTTPS_PORT || (await available(443) ? 443 : 8443));
        gateway = { httpPort, httpsPort, adminPort: await allocate() };
      }
      const running = gateway.pid && alive(gateway.pid) && (await run('ps', ['-p', String(gateway.pid), '-o', 'command='], { quiet: true }).catch(() => '')).includes(caddyFile);
      if (!running) {
        if (process.env.DEVHUB_HTTP_PORT) gateway.httpPort = Number(process.env.DEVHUB_HTTP_PORT);
        if (process.env.DEVHUB_HTTPS_PORT) gateway.httpsPort = Number(process.env.DEVHUB_HTTPS_PORT);
        // The admin API is private implementation state and needs no stable port.
        if (!await available(gateway.adminPort)) gateway.adminPort = await allocate();
        for (const port of [gateway.httpPort, gateway.httpsPort, gateway.adminPort]) {
          if (!await available(port)) throw new Error(`Hub gateway port ${port} is unavailable. Set DEVHUB_HTTP_PORT / DEVHUB_HTTPS_PORT for this machine; no process was stopped.`);
        }
      }
      gateway.protocolVersion = 1;
      const config = gatewayConfig(gateway, entries, join(stateRoot, 'caddy-storage'));
      const candidate = caddyFile + '.candidate';
      await writeFile(candidate, config, { mode: 0o600 });
      await run(caddy, ['validate', '--config', candidate, '--adapter', 'caddyfile'], { quiet: true });
      await copyFile(candidate, caddyFile);
      await unlink(candidate);
      if (running) {
        await run(caddy, ['reload', '--address', `127.0.0.1:${gateway.adminPort}`, '--config', caddyFile, '--adapter', 'caddyfile'], { quiet: true });
      } else {
        const fd = openSync(join(stateRoot, 'gateway.log'), 'a', 0o600);
        const child = spawn(caddy, ['run', '--config', caddyFile, '--adapter', 'caddyfile'], { detached: true, stdio: ['ignore', fd, fd] });
        closeSync(fd);
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        gateway.pid = child.pid;
        child.unref();
        await save(gatewayFile, gateway);
        await waitFor(`http://127.0.0.1:${gateway.adminPort}/config/`, { timeout: 15_000, headers: { Origin: `http://127.0.0.1:${gateway.adminPort}` } });
      }
      await save(gatewayFile, gateway);
      await save(registryFile, entries);
      return gateway;
    });
  }
  function contextFor(ports, services, gateway) {
    const context = { root, instance: { id, hash, isWorktree }, ports, services, host: '127.0.0.1', urls: {}, gateway: { httpsPort: gateway.httpsPort, ca: join(stateRoot, 'caddy-storage/pki/authorities/local/root.crt') } };
    for (const route of manifest.gateway?.routes ?? []) context.urls[route.name] = origin(expand(route.host, context), gateway.httpsPort);
    context.url = context.urls[manifest.gateway?.primary] ?? '';
    return context;
  }
  function runtimeEnvironment(name, source, context) {
    return {
      ...process.env, ...source,
      ...environmentValues(manifest.env, source, context),
      ...environmentValues(manifest.processes[name]?.env, source, context),
      DEVHUB_INSTANCE_ID: id, DEVHUB_INSTANCE_HASH: hash,
      DEVHUB_WORKTREE: String(isWorktree), DEVHUB_ROOT: root,
      DEVHUB_INFRASTRUCTURE_ROOT: infrastructureRoot, DEVHUB_COMPOSE_ROOT: composeRoot, DEVHUB_REGISTRY_FILE: registryFile,
      DEVHUB_SERVICES_JSON: JSON.stringify(context.services), DEVHUB_URL: context.url,
    };
  }
  async function hooks(name, context) {
    for (const item of manifest.hooks?.[name] ?? []) {
      const source = item.process ? await environment(item.process) : {};
      const env = item.process ? runtimeEnvironment(item.process, source, context) : { ...process.env, ...environmentValues(manifest.env, source, context), DEVHUB_INSTANCE_ID: id, DEVHUB_INSTANCE_HASH: hash, DEVHUB_WORKTREE: String(isWorktree), DEVHUB_INFRASTRUCTURE_ROOT: infrastructureRoot, DEVHUB_COMPOSE_ROOT: composeRoot, DEVHUB_REGISTRY_FILE: registryFile, DEVHUB_SERVICES_JSON: JSON.stringify(context.services), DEVHUB_URL: context.url };
      const args = item.command.map(value => expand(value, context));
      await run(args[0], args.slice(1), { cwd: item.cwd ? safePath(root, item.cwd) : root, env });
    }
  }
  function resolvedRoutes(context) {
    return (manifest.gateway?.routes ?? []).map(route => ({
      hostname: new URL(context.urls[route.name]).hostname,
      paths: route.service ? [{ port: context.services[route.service] }] : route.paths.map(path => ({ match: path.match, port: context.ports[path.process] })),
    }));
  }
  async function stop() {
    const current = await json(instanceFile);
    if (!await supervisorAlive(current)) { console.log(`${manifest.id} is already stopped.`); return; }
    const response = await fetch(local(current.controlPort) + '/stop', {
      method: 'POST', headers: { Authorization: `Bearer ${current.token}` }, signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    if (!response?.ok) throw new Error('Could not reach this hub supervisor. No process was killed.');
    for (let i = 0; i < 150; i++) {
      if (!alive(current.pid)) { console.log('Stopped app processes. Docker data and shared services remain available.'); return; }
      await delay(200);
    }
    throw new Error('Supervisor is still stopping; inspect devhub logs.');
  }
  async function up() {
    const previous = await json(instanceFile);
    if (await supervisorAlive(previous)) { console.log(`Already running: ${previous.url || 'startup in progress'}`); return; }
    const release = await lock(instanceLock);
    const children = [];
    let stopping = false, control, published = false, entry;
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const cleanup = async (code = 0) => {
      if (stopping) return;
      stopping = true;
      for (const { child } of children) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
      }
      await Promise.all(children.map(async ({ child }) => {
        for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
        // Groups are created by this supervisor, never discovered by port number.
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Group exited normally. */ }
      }));
      if (published) await gatewayUpdate(entry, true).catch(error => console.error(error.message));
      control?.close();
      await unlink(instanceFile).catch(() => {});
      await release();
      process.exitCode = code;
      finish();
    };
    process.once('SIGTERM', () => void cleanup());
    process.once('SIGINT', () => void cleanup());
    try {
      // Publish control before long readiness checks so dev:stop can cancel startup.
      const token = randomBytes(32).toString('hex');
      control = createServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(404).end(); return; }
        if (req.method === 'GET' && req.url === '/status') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ key: hash })); return; }
        if (req.method !== 'POST' || req.url !== '/stop') { res.writeHead(404).end(); return; }
        res.writeHead(200).end('Stopping');
        void cleanup();
      });
      await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
      await save(instanceFile, { id, key: hash, pid: process.pid, root, phase: 'starting', controlPort: control.address().port, token });
      await setup();
      if (stopping) return;
      const gateway = manifest.gateway ? await gatewayUpdate(null, true) : { httpsPort: 8443 };
      const infra = await infraStart();
      if (stopping) return;
      const old = await json(join(root, '.devhub/ports.json'), {});
      const used = new Set(Object.values(infra)), ports = {};
      for (const name of Object.keys(manifest.processes)) ports[name] = await allocate(old[name], used);
      await save(join(root, '.devhub/ports.json'), ports);
      const context = contextFor(ports, infra, gateway);
      const url = context.url;
      await hooks('beforeStart', context);
      if (stopping) return;
      await mkdir(logDirectory, { recursive: true, mode: 0o700 });
      for (const [name, item] of Object.entries(manifest.processes)) {
        const path = join(logDirectory, `${name}.log`);
        await writeFile(path, '', { mode: 0o600 });
        const log = createWriteStream(path, { flags: 'a', mode: 0o600 });
        const env = runtimeEnvironment(name, await environment(name), context);
        const child = spawn(item.command[0], item.command.slice(1), { cwd: safePath(root, item.cwd ?? '.'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
        child.once('error', error => { console.error(`${name}: ${error.message}`); void cleanup(1); });
        child.once('exit', code => { log.end(); if (!stopping) { console.error(`${name} exited (${code}); see devhub logs -- ${name}`); void cleanup(1); } });
        children.push({ name, child });
      }
      console.log('Waiting for configured processes…');
      await Promise.all(children.filter(({ name }) => manifest.processes[name].ready).map(({ name, child }) => waitFor(local(ports[name]) + manifest.processes[name].ready, { check: () => !stopping && child.exitCode === null && child.signalCode === null })));
      if (stopping) return;
      entry = { protocolVersion: 1, id, key: hash, pid: process.pid, root, phase: 'ready', url, urls: context.urls, routes: resolvedRoutes(context), ports, infra, controlPort: control.address().port, token };
      if (manifest.gateway) {
        await gatewayUpdate(entry);
        published = true;
        if (stopping) { await gatewayUpdate(entry, true); return; }
      }
      await save(instanceFile, entry);
      for (const link of manifest.gateway?.links ?? []) console.log(`${link.label}: ${context.urls[link.route]}${link.path ?? ''}`);
      console.log(`${manifest.id} ready. Configured processes are running. Ctrl+C or devhub stop stops only this checkout.`);
      await finished;
    } catch (error) {
      console.error(error.message);
      await cleanup(1);
    } finally {
      if (stopping) await finished;
    }
  }
  async function status() {
    const current = await json(instanceFile);
    if (!await supervisorAlive(current)) { console.log('Stopped. Start with devhub up.'); return; }
    if (current.phase === 'starting') { console.log('Starting; devhub stop can cancel.'); return; }
    console.log(JSON.stringify({ status: 'running', app: current.url, urls: current.urls, ports: current.ports, infrastructure: current.infra }, null, 2));
  }
  async function logs() {
    const name = argv[1] ?? Object.keys(manifest.processes)[0];
    if (!manifest.processes[name]) throw new Error(`Choose a configured process: ${Object.keys(manifest.processes).join(', ')}`);
    const path = join(logDirectory, `${name}.log`);
    if (argv.includes('--follow')) {
      for (let i = 0; i < 120 && !existsSync(path); i++) await delay(500);
      if (!existsSync(path)) throw new Error('No logs yet. Start devhub up first.');
      await run('tail', ['-n', '60', '-F', path], { timeout: 2_147_483_647 });
      return;
    }
    const contents = await readFile(path, 'utf8').catch(() => 'No logs yet.');
    console.log(contents.split('\n').slice(-100).join('\n'));
  }
  async function doctor() {
    let failures = 0;
    for (const [name, fn] of [
      ['Node 22+', async () => { if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22+ is required'); }],
      ...(manifest.gateway ? [['Caddy', () => run(caddy, ['version'], { quiet: true })]] : []),
      ...(infrastructure ? [['Docker', () => run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true })]] : []),
      ['Environment files', async () => { for (const name of Object.keys(manifest.processes)) await environment(name); }],
    ]) {
      try { await fn(); console.log(`OK: ${name}`); } catch (error) { failures++; console.log(`Needs attention: ${name}: ${error.message}`); }
    }
    const current = await json(instanceFile);
    if (await supervisorAlive(current) && current.ports) {
      for (const [name, item] of Object.entries(manifest.processes)) {
        if (!item.ready) continue;
        try { await waitFor(local(current.ports[name]) + item.ready, { timeout: 3000 }); console.log(`OK: ${name} ready`); }
        catch { failures++; console.log(`Needs attention: ${name} readiness`); }
      }
      if (manifest.gateway?.ready) await new Promise(resolve => {
        const target = new URL(current.urls[manifest.gateway.ready.route]);
        const check = spawn('curl', ['--silent', '--fail', '--max-time', '5', '--resolve', `${target.hostname}:${target.port || 443}:127.0.0.1`, target.origin + manifest.gateway.ready.path], { stdio: 'ignore' });
        check.once('error', () => { failures++; resolve(); });
        check.once('exit', code => { if (code) { failures++; console.log('Needs attention: local HTTPS trust. Run devhub trust.'); } else console.log('OK: local HTTPS'); resolve(); });
      });
    }
    process.exitCode = failures ? 1 : 0;
  }
  async function trust() {
    const gateway = await json(gatewayFile);
    if (!gateway?.pid || !alive(gateway.pid)) throw new Error('Start devhub up first to create the local certificate authority.');
    if (platform() === 'darwin') {
      // User trust is sufficient; avoid Caddy's system-keychain sudo request.
      await run('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', join(homedir(), 'Library/Keychains/login.keychain-db'), join(stateRoot, 'caddy-storage/pki/authorities/local/root.crt')]);
    } else {
      await run(caddy, ['trust', '--address', `127.0.0.1:${gateway.adminPort}`]);
    }
    console.log('Local HTTPS trust installed.');
  }
  async function operationContext() {
    const infra = await infraStart();
    const used = new Set(Object.values(infra)), ports = {};
    for (const name of Object.keys(manifest.processes)) ports[name] = await allocate(null, used);
    return contextFor(ports, infra, await json(gatewayFile, { httpsPort: Number(process.env.DEVHUB_HTTPS_PORT || 8443) }));
  }
  async function reset() {
    if (!argv.includes('--confirm')) throw new Error('Explicitly choose devhub reset --confirm to execute the configured destructive reset hooks.');
    if (!manifest.hooks?.reset?.length) throw new Error('No reset hooks configured.');
    await stop();
    const release = await lock(instanceLock);
    try {
      await setup();
      await hooks('reset', await operationContext());
      console.log('Configured reset complete.');
    } finally { await release(); }
  }
  async function check() {
    if (!manifest.checks?.length) throw new Error('No checks configured.');
    await setup();
    const context = await operationContext();
    await hooks('beforeCheck', context);
    for (const item of manifest.checks ?? []) {
      const args = item.command.map(value => expand(value, context));
      await run(args[0], args.slice(1), { cwd: safePath(root, item.cwd ?? '.') });
    }
  }

  try {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const handlers = { setup, up, stop, status, logs, doctor, trust, reset, check, validate: async () => console.log('devhub.json is valid.') };
    if (!handlers[command]) throw new Error('Choose setup, up, stop, status, logs, doctor, trust, reset, check or validate.');
    await handlers[command]();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

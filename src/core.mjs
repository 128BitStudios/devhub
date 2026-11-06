import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const origin = (hostname, port, secure = true) => `${secure ? 'https' : 'http'}://${hostname}${port === (secure ? 443 : 80) ? '' : `:${port}`}`;
export async function json(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
export async function lock(path, timeout = 0) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
      await handle.close();
      return () => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // An empty file may be between exclusive creation and its owner write.
      let owner;
      try { owner = await json(path); } catch { owner = { pid: process.pid }; }
      if (owner && !alive(owner.pid)) { await unlink(path).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw new Error(`Another hub operation is active (${path}).`);
      await delay(150);
    }
  }
}
export async function withLock(path, fn) {
  const release = await lock(path, 240_000);
  try { return await fn(); } finally { await release(); }
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { quiet = false, timeout = 180_000, ...spawnOptions } = options;
    const child = spawn(command, args, { ...spawnOptions, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (quiet) {
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', () => {});
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} ${args[0] ?? ''} failed (${code ?? 'timeout/signal'}).`));
    });
  });
}
export async function available(port = 0) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(null));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const assigned = server.address().port;
      server.close(() => resolve(assigned));
    });
  });
}
export async function allocate(preferred, used = new Set()) {
  let port = preferred && !used.has(preferred) ? await available(preferred) : null;
  while (!port || used.has(port)) port = await available();
  used.add(port);
  return port;
}
export async function waitFor(url, { timeout = 120_000, check = () => true, headers = {} } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!check()) throw new Error(`Process exited before readiness: ${url}`);
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch { /* Retry connection failures while a development build starts. */ }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
export function localUri(value, port, suffix = '') {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Development infrastructure must use a local connection URL.');
  }
  url.hostname = '127.0.0.1';
  url.port = String(port);
  if (suffix) url.pathname = `${url.pathname}_${suffix}`;
  return url.href;
}

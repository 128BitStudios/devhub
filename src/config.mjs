import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, relative } from 'node:path';
import { localUri } from './core.mjs';

const slug = /^[a-z][a-z0-9-]*$/;
const bad = message => { throw new Error(`Invalid devhub.json: ${message}`); };
export function safePath(root, value) {
  if (typeof value !== 'string' || isAbsolute(value) || value.split(/[\\/]/).includes('..')) bad('paths must remain inside the checkout');
  const result = resolve(root, value);
  if (relative(root, result).startsWith('..')) bad('path escapes checkout');
  return result;
}
function command(item) {
  if (!item || !Array.isArray(item.command) || !item.command.length || item.command.some(value => typeof value !== 'string') || !item.command[0]) bad('commands must be non-empty argument arrays');
}
export function validateManifest(manifest) {
  if (!manifest || manifest.version !== 2 || !slug.test(manifest.id)) bad('expected version 2 and a lowercase application id');
  const known = new Set(['$schema', 'version', 'id', 'processes', 'setup', 'infrastructure', 'env', 'gateway', 'hooks', 'checks']);
  for (const key of Object.keys(manifest)) if (!known.has(key)) bad(`unknown option ${key}`);
  if (!manifest.processes || !Object.keys(manifest.processes).length) bad('declare at least one process');
  for (const [name, item] of Object.entries(manifest.processes)) {
    if (!slug.test(name)) bad('invalid process id');
    command(item); safePath('/checkout', item.cwd ?? '.');
    if (item.envFile) safePath('/checkout', item.envFile);
    if (item.ready && !item.ready.startsWith('/')) bad('ready must be a URL path');
  }
  for (const item of manifest.setup?.envFiles ?? []) {
    safePath('/checkout', item.path); safePath('/checkout', item.example);
    for (const [key, generator] of Object.entries(item.generate ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || !Number.isInteger(generator.bytes) || generator.bytes < 16 || generator.bytes > 256 || !['hex', 'base64'].includes(generator.encoding ?? 'base64')) bad('invalid generated environment value');
    }
  }
  if (manifest.setup?.dependencies) { command(manifest.setup.dependencies); safePath('/checkout', manifest.setup.dependencies.check); }
  if (manifest.infrastructure) {
    if (!slug.test(manifest.infrastructure.project)) bad('invalid Compose project');
    safePath('/checkout', manifest.infrastructure.file);
    if (manifest.infrastructure.owner !== undefined && !/^\.\.\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.infrastructure.owner)) bad('infrastructure owner must name one sibling checkout');
    for (const item of Object.values(manifest.infrastructure.ports ?? {})) {
      if (!slug.test(item.service) || !Number.isInteger(item.target) || item.target < 1 || item.target > 65535 || !/^[A-Z_][A-Z0-9_]*$/.test(item.variable)) bad('invalid infrastructure port');
    }
  }
  for (const [name, items] of Object.entries(manifest.hooks ?? {})) {
    if (!['beforeStart', 'beforeCheck', 'reset'].includes(name)) bad(`unknown hook ${name}`);
    if (!Array.isArray(items)) bad('hooks must contain command arrays');
    for (const item of items) {
      command(item);
      if (item.process && !manifest.processes[item.process]) bad('unknown hook process');
      if (item.cwd) safePath('/checkout', item.cwd);
    }
  }
  for (const item of manifest.checks ?? []) { command(item); if (item.cwd) safePath('/checkout', item.cwd); }
  for (const mapping of [manifest.env, ...Object.values(manifest.processes).map(item => item.env)]) {
    for (const [key, rule] of Object.entries(mapping ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) bad('invalid environment key');
      if (typeof rule === 'string') continue;
      if (!rule || typeof rule.source !== 'string') bad('environment rules require a source');
      if (rule.url) {
        if (!manifest.infrastructure?.ports?.[rule.url.port]) bad('unknown URL service port');
        if (rule.url.worktreePath && !['suffix', 'instance'].includes(rule.url.worktreePath)) bad('unknown worktree URL isolation mode');
      }
    }
  }
  const routes = manifest.gateway?.routes ?? [];
  if (manifest.gateway && !routes.length) bad('gateway requires routes');
  const names = new Set();
  for (const route of routes) {
    if (!slug.test(route.name) || names.has(route.name) || typeof route.host !== 'string') bad('routes require unique names and host templates');
    names.add(route.name);
    if (route.service && !manifest.infrastructure?.ports?.[route.service]) bad('unknown route service');
    if (!route.service && (!Array.isArray(route.paths) || !route.paths.length)) bad('route requires paths or a service');
    let fallback = false;
    for (const path of route.paths ?? []) {
      if (!manifest.processes[path.process]) bad('unknown route process');
      if (path.match && (!Array.isArray(path.match) || !path.match.length || path.match.some(value => typeof value !== 'string' || !value.startsWith('/')))) bad('invalid route path');
      if (!path.match) { if (fallback) bad('multiple fallback paths'); fallback = true; }
    }
  }
  if (routes.length && !names.has(manifest.gateway.primary)) bad('gateway.primary must name a route');
  if (manifest.gateway?.ready && (!names.has(manifest.gateway.ready.route) || !manifest.gateway.ready.path?.startsWith('/'))) bad('invalid gateway readiness route/path');
  for (const link of manifest.gateway?.links ?? []) if (!names.has(link.route)) bad('unknown link route');
  return manifest;
}
export function findRoot(start) {
  let root = resolve(start);
  while (!existsSync(resolve(root, 'devhub.json'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('No devhub.json found in this directory or its parents.');
    root = parent;
  }
  return root;
}
export function expand(value, context) {
  if (typeof value !== 'string') throw new Error('Environment and command values must be strings.');
  return value.replace(/\$\{([\w.]+)\}/g, (_, key) => {
    const result = key.split('.').reduce((object, part) => object?.[part], context);
    if (result === undefined || result === null) throw new Error(`Unknown configuration variable: ${key}`);
    if (typeof result === 'object') throw new Error(`Configuration variable must be scalar: ${key}`);
    return String(result);
  });
}
export function environmentValues(mapping, source, context) {
  const result = {};
  for (const [key, rule] of Object.entries(mapping ?? {})) {
    if (typeof rule === 'string') { result[key] = expand(rule, { ...context, env: source }); continue; }
    if (!rule || typeof rule.source !== 'string' || typeof source[rule.source] !== 'string') throw new Error(`Missing configured environment source for ${key}`);
    let value = source[rule.source];
    if (rule.url) {
      const port = context.services[rule.url.port];
      if (!port) throw new Error(`Missing service port for ${key}`);
      value = localUri(value, port, rule.url.worktreePath === 'suffix' && context.instance.isWorktree ? context.instance.hash : '');
      if (rule.url.worktreePath === 'instance' && context.instance.isWorktree) {
        const url = new URL(value); url.pathname = '/' + context.instance.id; value = url.href;
      }
    }
    result[key] = value;
  }
  return result;
}

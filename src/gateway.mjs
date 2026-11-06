import { origin } from './core.mjs';
const quote = JSON.stringify;
const html = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function gatewayConfig(gateway, entries, storage) {
  const links = entries.map(entry => `<li><a href='${html(entry.url)}'>${html(entry.id)}</a></li>`).join('');
  const page = `<!doctype html><html><head><title>Local Dev Hub</title></head><body><h1>Local Dev Hub</h1><ul>${links || '<li>No apps running</li>'}</ul></body></html>`;
  const global = `{
  admin 127.0.0.1:${gateway.adminPort}
  http_port ${gateway.httpPort}
  https_port ${gateway.httpsPort}
  default_bind 127.0.0.1
  skip_install_trust
  storage file_system {
    root ${quote(storage)}
  }
}\n`;
  const site = (hostname, body) => `${origin(hostname, gateway.httpsPort)} {\n  tls internal\n${body}\n}\n`;
  const hosts = new Set(['hub.localhost']);
  let config = global + site('hub.localhost', `  header Content-Type text/html\n  respond ${quote(page)}`);
  for (const entry of entries) {
    if (!Array.isArray(entry.routes)) throw new Error('Incompatible routing state. Stop older launchers before updating the hub.');
    for (const route of entry.routes) {
      if (!/^[a-z0-9.-]+\.localhost$/.test(route.hostname) || hosts.has(route.hostname)) throw new Error(`Invalid or duplicate local hostname: ${route.hostname}`);
      hosts.add(route.hostname);
      const paths = [...route.paths].sort((a, b) => Number(!a.match) - Number(!b.match));
      config += site(route.hostname, paths.map((path, index) => {
        if (!Number.isInteger(path.port) || path.port < 1 || path.port > 65535) throw new Error('Invalid route port.');
        const matcher = path.match ? `  @route${index} path ${path.match.map(quote).join(' ')}\n` : '';
        return `${matcher}  handle${path.match ? ` @route${index}` : ''} {\n    reverse_proxy 127.0.0.1:${path.port}\n  }`;
      }).join('\n'));
    }
  }
  return config;
}

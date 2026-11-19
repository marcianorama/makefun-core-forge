import http from 'node:http';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Forge } from './model.mjs';
import { rest } from './rest.mjs';
import { smart } from './smart.mjs';
import { graphqlEndpoint } from './graphql.mjs';
import { mcp } from './mcp.mjs';

const token = process.env.MAKEFUN_SHOP_TOKEN || '';
const login = process.env.MAKEFUN_FORGE_LOGIN || 'adaiversen';
const listenPort = Number(process.env.PORT || 0);
const forge = new Forge({
  login,
  baseUrl: '',
  directory: join(tmpdir(), `makefun-forge-${process.pid}`),
});

function ensureRequestId(res) {
  if (!res.getHeader('x-github-request-id')) res.setHeader('x-github-request-id', randomUUID());
}

function json(res, status, body, headers = {}) {
  ensureRequestId(res);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function unauthorized(res, isGit = false) {
  ensureRequestId(res);
  res.statusCode = 401;
  res.setHeader('www-authenticate', isGit ? 'Basic realm="makefun-core-forge"' : 'Bearer realm="makefun-core-forge"');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ message: 'Unauthorized' }));
}

function checkAuth(req) {
  if (!token) return true;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ') || auth.startsWith('token ')) return auth.slice(auth.indexOf(' ') + 1) === token;
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      const user = i >= 0 ? decoded.slice(0, i) : decoded;
      const pass = i >= 0 ? decoded.slice(i + 1) : '';
      return pass === token || (user === token && pass === '');
    } catch {
      return false;
    }
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 32 * 1024 * 1024) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      const enc = String(req.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc === 'gzip') buf = zlib.gunzipSync(buf);
        else if (enc === 'deflate') buf = zlib.inflateSync(buf);
      } catch {
        reject(Object.assign(new Error('invalid compressed body'), { status: 400 }));
        return;
      }
      resolve(buf);
    });
    req.on('error', reject);
  });
}

async function postJson(url, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode && res.statusCode >= 500) return reject(new Error('transient'));
        try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function lifecycle(server, port) {
  const base = process.env.MAKEFUN_ENV_URL;
  if (!base) return;
  await postJson(new URL('/register', base).toString(), { port });
  while (true) {
    try {
      const result = await getJson(new URL('/done', base).toString());
      if (result?.done === true) {
        server.close(() => process.exit(0));
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
}

const server = http.createServer(async (req, res) => {
  ensureRequestId(res);
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost'}`;
  forge.baseUrl = origin;
  const url = new URL(req.url || '/', origin);
  const isGit = /\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(url.pathname);

  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }

    if (!checkAuth(req)) {
      unauthorized(res, isGit);
      return;
    }

    const raw = await readBody(req);

    if (await smart(forge, req, res, url, raw)) return;

    if (url.pathname === '/graphql' || url.pathname === '/api/graphql') {
      let payload;
      try {
        payload = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        json(res, 400, { errors: [{ message: 'Malformed JSON' }] });
        return;
      }
      const result = await graphqlEndpoint(forge, payload);
      json(res, 200, result);
      return;
    }

    if (url.pathname === '/mcp') {
      let payload;
      try {
        payload = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      await mcp(forge, req, res, payload);
      return;
    }

    let parsed = raw;
    const contentType = String(req.headers['content-type'] || '');
    if (!isGit && contentType.includes('application/json')) {
      try {
        parsed = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        json(res, 400, { message: 'Malformed JSON' });
        return;
      }
    }

    if (await rest(forge, req, res, url, parsed)) return;

    json(res, 404, { message: 'Not Found' });
  } catch (err) {
    json(res, err?.status || 500, { message: err?.message || 'Internal Server Error' });
  }
});

server.listen(listenPort, '0.0.0.0', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : listenPort;
  lifecycle(server, port);
});

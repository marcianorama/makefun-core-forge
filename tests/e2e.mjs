import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import http from 'node:http';

const token = 'test-token';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const root = mkdtempSync(join(tmpdir(), 'makefun-e2e-'));
const clone = join(root, 'clone');
const clone2 = join(root, 'clone2');
const initRepo = join(root, 'init-repo');
const initClone = join(root, 'init-clone');
let server;
let stderrText = '';

function req(method, url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { authorization: `Bearer ${token}`, ...extraHeaders };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function git(args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['-c', 'core.autocrlf=false', ...args], { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => err.push(c));
    p.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(Buffer.concat(err).toString('utf8') || `git exit ${code}`));
    });
  });
}

async function waitForHealth(base) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await req('GET', `${base}/healthz`, null, {});
      if (res.status === 200 && res.json?.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy\n${stderrText}`);
}

async function main() {
  server = spawn(process.execPath, ['main.ts'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: '43123', MAKEFUN_SHOP_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (c) => { stderrText += c.toString('utf8'); });
  const base = 'http://127.0.0.1:43123';
  await waitForHealth(base);

  let res = await req('POST', `${base}/api/v3/user/repos`, { name: 'demo', description: 'e2e' });
  assert.equal(res.status, 201);

  await req('PUT', `${base}/api/v3/repos/adaiversen/demo/contents/README.md`, { message: 'seed', content: Buffer.from('hello\n').toString('base64') });
  await git(['clone', `http://x-access-token:${token}@127.0.0.1:43123/adaiversen/demo.git`, clone], root, { GIT_TRACE_PACKET: '1', GIT_TRACE: '1' });
  await git(['config', 'user.name', 'Test'], clone);
  await git(['config', 'user.email', 'test@example.com'], clone);
  writeFileSync(join(clone, 'README.md'), 'hello\nworld\n');
  await git(['add', 'README.md'], clone);
  await git(['commit', '-m', 'update main'], clone);
  await git(['push', 'origin', 'HEAD:main'], clone);
  await git(['checkout', '-b', 'feature'], clone);
  writeFileSync(join(clone, 'feature.txt'), 'feature-bytes\n');
  await git(['add', 'feature.txt'], clone);
  await git(['commit', '-m', 'feature work'], clone);
  await git(['tag', 'v1'], clone);
  await git(['push', 'origin', 'HEAD:feature'], clone);
  await git(['push', 'origin', 'v1'], clone);

  res = await req('POST', `${base}/api/v3/repos/adaiversen/demo/issues`, { title: 'Bug', body: 'Details' });
  const issueNumber = res.json.number;
  await req('POST', `${base}/api/v3/repos/adaiversen/demo/issues/${issueNumber}/comments`, { body: 'Investigating' });
  res = await req('POST', `${base}/api/v3/repos/adaiversen/demo/pulls`, { title: 'Feature', head: 'feature', base: 'main', body: 'Please merge' });
  const prNumber = res.json.number;
  res = await req('PUT', `${base}/api/v3/repos/adaiversen/demo/pulls/${prNumber}/merge`, { merge_method: 'squash' });
  assert.equal(res.status, 200);

  await git(['checkout', 'main'], clone);
  await git(['pull', '--ff-only'], clone, { GIT_TRACE_PACKET: '1', GIT_TRACE: '1' });
  assert.equal(readFileSync(join(clone, 'feature.txt'), 'utf8'), 'feature-bytes\n');
  await git(['clone', '--depth', '1', `http://x-access-token:${token}@127.0.0.1:43123/adaiversen/demo.git`, clone2], root, { GIT_TRACE_PACKET: '1', GIT_TRACE: '1' });
  assert.equal(readFileSync(join(clone2, 'README.md'), 'utf8'), 'hello\nworld\n');

  res = await req('POST', `${base}/graphql`, { query: `query($o:String!,$n:String!){ repository(owner:$o,name:$n){ name issue(number:${issueNumber}){ title } pullRequest(number:${prNumber}){ title state merged } } }`, variables: { o: 'adaiversen', n: 'demo' } });
  assert.equal(res.status, 200);
  res = await req('POST', `${base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal(res.status, 200);

  res = await req('POST', `${base}/api/v3/user/repos`, { name: 'native-init', description: 'git init push' });
  assert.equal(res.status, 201);
  await git(['init', '-b', 'main', initRepo], root);
  await git(['config', 'user.name', 'Init Test'], initRepo);
  await git(['config', 'user.email', 'init@example.com'], initRepo);
  writeFileSync(join(initRepo, 'README.md'), 'from git init\n');
  writeFileSync(join(initRepo, 'alpha.txt'), 'alpha\n');
  mkdirSync(join(initRepo, 'nested'), { recursive: true });
  writeFileSync(join(initRepo, 'nested', 'path.txt'), 'nested-bytes\n');
  await git(['add', '.'], initRepo);
  await git(['commit', '-m', 'initial main'], initRepo);
  await git(['remote', 'add', 'origin', `http://x-access-token:${token}@127.0.0.1:43123/adaiversen/native-init.git`], initRepo);
  await git(['push', '-u', 'origin', 'main'], initRepo, { GIT_TRACE_PACKET: '1', GIT_TRACE: '1' });
  await git(['tag', '-a', 'annotated-v1', '-m', 'annotated tag'], initRepo);
  await git(['push', 'origin', 'annotated-v1'], initRepo);
  await git(['clone', `http://x-access-token:${token}@127.0.0.1:43123/adaiversen/native-init.git`, initClone], root, { GIT_TRACE_PACKET: '1', GIT_TRACE: '1' });
  assert.equal(readFileSync(join(initClone, 'README.md'), 'utf8'), 'from git init\n');
  assert.equal(readFileSync(join(initClone, 'alpha.txt'), 'utf8'), 'alpha\n');
  assert.equal(readFileSync(join(initClone, 'nested', 'path.txt'), 'utf8'), 'nested-bytes\n');
  await git(['fetch', '--tags', 'origin'], initClone, { GIT_TRACE_PACKET: '1', GIT_TRACE: '1' });
  const fetchedTag = (await git(['tag', '-l', 'annotated-v1'], initClone)).trim();
  assert.equal(fetchedTag, 'annotated-v1');
  writeFileSync(join(initRepo, 'remote-advance.txt'), 'remote advance\n');
  await git(['add', 'remote-advance.txt'], initRepo);
  await git(['commit', '-m', 'advance remote main'], initRepo);
  await git(['push', 'origin', 'main'], initRepo, { GIT_TRACE_PACKET: '1', GIT_TRACE: '1' });
  await git(['config', 'user.name', 'Clone Test'], initClone);
  await git(['config', 'user.email', 'clone@example.com'], initClone);
  writeFileSync(join(initClone, 'README.md'), 'conflicting clone edit\n');
  await git(['add', 'README.md'], initClone);
  await git(['commit', '-m', 'conflicting clone commit'], initClone);
  let rejected = false;
  try {
    await git(['push', 'origin', 'HEAD:main'], initClone, { GIT_TRACE_PACKET: '1', GIT_TRACE: '1' });
  } catch (err) {
    rejected = /non-fast-forward|fetch first|failed to push/i.test(String(err));
  }
  assert.equal(rejected, true);
  console.log('e2e ok');
}

main().catch((err) => {
  console.error(err);
  if (stderrText) console.error(stderrText);
  process.exitCode = 1;
}).finally(() => {
  if (server && !server.killed) server.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
});

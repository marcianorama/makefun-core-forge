const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS_V0 = ['multi_ack_detailed', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', 'side-band-64k', 'symref=HEAD:refs/heads/main'];
const RECEIVE_CAPS = ['report-status', 'side-band-64k', 'delete-refs'];

function pkt(data) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(String(data));
  const len = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), data]);
}
function flush() { return Buffer.from('0000', 'ascii'); }
function delim() { return Buffer.from('0001', 'ascii'); }

function sideband(channel, data) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(String(data));
  const max = 65515;
  const out = [];
  for (let off = 0; off < data.length || (data.length === 0 && off === 0); off += max) {
    const chunk = data.subarray(off, off + max);
    out.push(pkt(Buffer.concat([Buffer.from([channel]), chunk])));
    if (data.length === 0) break;
  }
  return Buffer.concat(out);
}

function parseRepoPath(pathname) {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  return m ? { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), action: m[3] } : null;
}

function parsePktLines(buffer) {
  const out = [];
  let off = 0;
  while (off + 4 <= buffer.length) {
    const hex = buffer.subarray(off, off + 4).toString('ascii');
    off += 4;
    if (hex === '0000') { out.push({ type: 'flush' }); continue; }
    if (hex === '0001') { out.push({ type: 'delim' }); continue; }
    if (hex === '0002') { out.push({ type: 'response-end' }); continue; }
    const len = Number.parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len - 4 > buffer.length) throw new Error('invalid pkt-line');
    const data = buffer.subarray(off, off + len - 4);
    off += len - 4;
    out.push({ type: 'data', data, text: data.toString('utf8') });
  }
  return out;
}

function writeBinary(res, status, headers, body) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}

function repoRefs(repo) {
  const refs = [];
  for (const [ref, sha] of repo.refs.entries()) {
    if (!ref.startsWith('refs/') || !sha) continue;
    refs.push({ ref, sha });
  }
  refs.sort((a, b) => a.ref.localeCompare(b.ref));
  return refs;
}

function peelTag(git, sha) {
  try {
    let cur = sha;
    while (true) {
      const obj = git.readObject(cur);
      if (obj.type !== 'tag') return cur;
      const text = obj.data.toString('utf8');
      const line = text.split('\n').find((l) => l.startsWith('object '));
      if (!line) return cur;
      cur = line.slice(7).trim();
    }
  } catch { return sha; }
}

function headTarget(repo) {
  const head = repo.refs.get('HEAD');
  if (typeof head === 'string' && head.startsWith('ref: ')) return head.slice(5);
  return `refs/heads/${repo.default_branch || 'main'}`;
}

function advertisedRefs(forge, repo, { includeHead = false, prefixes = [], peel = false, symrefs = false } = {}) {
  const out = [];
  const target = headTarget(repo);
  const targetSha = repo.refs.get(target) || null;
  if (includeHead && targetSha && (!prefixes.length || prefixes.some((p) => 'HEAD'.startsWith(p)))) {
    out.push({ ref: 'HEAD', sha: targetSha, attrs: symrefs ? ` symref-target:${target}` : '', peeled: null });
  }
  for (const { ref, sha } of repoRefs(repo)) {
    if (prefixes.length && !prefixes.some((p) => ref.startsWith(p))) continue;
    out.push({ ref, sha, attrs: '', peeled: peel ? peelTag(forge.git, sha) : null });
  }
  return out;
}

function advertiseV0(forge, repo, service) {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const target = headTarget(repo);
  const refs = advertisedRefs(forge, repo, { includeHead: true, peel: true });
  const parts = [pkt(`# service=${service}\n`), flush()];
  if (!refs.length) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps.join(' ')}\n`), flush());
    return Buffer.concat(parts);
  }
  refs.forEach((entry, i) => {
    let line = `${entry.sha} ${entry.ref}`;
    if (entry.ref === 'HEAD' && service === 'git-upload-pack') line += ` symref-target:${target}`;
    if (i === 0) line += `\0${caps.join(' ')}`;
    parts.push(pkt(`${line}\n`));
    if (entry.peeled && entry.peeled !== entry.sha) parts.push(pkt(`${entry.peeled} ${entry.ref}^{}\n`));
  });
  parts.push(flush());
  return Buffer.concat(parts);
}

function advertiseV2() {
  return Buffer.concat([pkt('version 2\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow\n'), pkt('object-format=sha1\n'), pkt(`agent=${AGENT}\n`), flush()]);
}

function parseV0WantHave(lines) {
  const wants = [], haves = [], shallows = [];
  let depth = Infinity, sideband = false;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const parts = line.trim().split(' ');
      wants.push(parts[1]);
      if (parts.includes('side-band-64k')) sideband = true;
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || Infinity;
  }
  return { wants, haves, shallows, depth, sideband };
}

function buildShallowLines(boundaries, unshallow = []) {
  const parts = [];
  for (const sha of boundaries) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  return parts;
}

function computeShallowInfo(forge, wants, haves, depth, clientShallows) {
  const reachable = forge.git.reachable(wants, haves, depth, clientShallows);
  return {
    reachable,
    boundaries: [...new Set(reachable.boundaries || [])],
    unshallow: [...new Set(reachable.unshallow || [])],
  };
}

function listRefsV2(forge, repo, lines) {
  let peel = false, symrefs = false, unborn = false;
  const prefixes = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const parts = [];
  const target = headTarget(repo);
  const targetSha = repo.refs.get(target);
  if (!targetSha && unborn && (!prefixes.length || prefixes.some((p) => 'HEAD'.startsWith(p)))) {
    let line = 'unborn HEAD';
    if (symrefs) line += ` symref-target:${target}`;
    parts.push(pkt(`${line}\n`));
  }
  for (const entry of advertisedRefs(forge, repo, { includeHead: !!targetSha, prefixes, peel, symrefs })) {
    let line = `${entry.sha} ${entry.ref}`;
    if (entry.ref === 'HEAD' && symrefs) line += ` symref-target:${target}`;
    if (entry.peeled && entry.peeled !== entry.sha) line += ` peeled:${entry.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(flush());
  return Buffer.concat(parts);
}

function fetchV2(forge, repo, lines) {
  const wants = [], haves = [], shallows = [];
  let depth = Infinity;
  let done = false;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || Infinity;
    else if (line === 'done') done = true;
  }
  const common = haves.filter((sha) => forge.git.hasObject(sha));
  const ack = [];
  if (!done) {
    ack.push(pkt('acknowledgments\n'));
    if (common.length) {
      for (const sha of common) ack.push(pkt(`ACK ${sha}\n`));
      ack.push(pkt('ready\n'));
    } else {
      ack.push(pkt('NAK\n'));
    }
    if (!wants.length || !common.length) return Buffer.concat([...ack, flush()]);
  }
  const { reachable, boundaries, unshallow } = computeShallowInfo(forge, wants, haves, depth, shallows);
  const pack = forge.git.pack(reachable.objects);
  const parts = [];
  if (!done) parts.push(...ack, delim());
  const shallowLines = buildShallowLines(boundaries, unshallow);
  if (shallowLines.length) parts.push(pkt('shallow-info\n'), ...shallowLines, delim());
  parts.push(pkt('packfile\n'), sideband(1, pack), flush());
  return Buffer.concat(parts);
}

function uploadPackV0(forge, repo, body) {
  const lines = parsePktLines(body).filter((x) => x.type === 'data').map((x) => x.text.replace(/\n$/, ''));
  const req = parseV0WantHave(lines);
  const { reachable, boundaries, unshallow } = computeShallowInfo(forge, req.wants, req.haves, req.depth, req.shallows);
  const pack = forge.git.pack(reachable.objects);
  const parts = [...buildShallowLines(boundaries, unshallow), flush(), pkt('NAK\n')];
  if (req.sideband) parts.push(sideband(1, pack), flush());
  else parts.push(pack);
  return Buffer.concat(parts);
}

function uploadPackV2(forge, repo, body) {
  const packets = parsePktLines(body);
  const first = packets.find((p) => p.type === 'data');
  if (!first) throw new Error('missing v2 command');
  let command = first.text.replace(/\n$/, '');
  if (command.startsWith('command=')) command = command.slice(8);
  const start = packets.indexOf(first);
  const lines = packets.filter((p, i) => i > start && p.type === 'data').map((p) => p.text.replace(/\n$/, ''));
  if (command === 'ls-refs') return listRefsV2(forge, repo, lines);
  if (command === 'fetch') return fetchV2(forge, repo, lines);
  return flush();
}

function parseCommandsAndPack(body) {
  let off = 0;
  const commands = [];
  let pack = Buffer.alloc(0);
  while (off + 4 <= body.length) {
    if (body.subarray(off, off + 4).toString('ascii') === 'PACK') { pack = body.subarray(off); break; }
    const hex = body.subarray(off, off + 4).toString('ascii');
    off += 4;
    if (hex === '0000') break;
    const len = Number.parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len - 4 > body.length) throw new Error('invalid receive-pack command pkt');
    const data = body.subarray(off, off + len - 4);
    off += len - 4;
    commands.push(data.toString('utf8').replace(/\n$/, ''));
  }
  if (!pack.length && off < body.length && body.subarray(off, off + 4).toString('ascii') === 'PACK') pack = body.subarray(off);
  return { commands, pack };
}

function applyReceivePack(forge, repo, body) {
  const { commands, pack } = parseCommandsAndPack(body);
  let caps = [];
  const updates = [];
  commands.forEach((line, i) => {
    const nul = line.indexOf('\0');
    let text = line;
    if (i === 0 && nul >= 0) {
      text = line.slice(0, nul);
      caps = line.slice(nul + 1).trim().split(/\s+/).filter(Boolean);
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(text);
    if (m) updates.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
  });
  if (pack.length) forge.git.unpack(pack);
  const report = [];
  for (const u of updates) {
    const current = repo.refs.get(u.ref) || ZERO;
    if (current !== u.oldSha) { report.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    if (u.newSha === ZERO) { repo.refs.delete(u.ref); report.push({ ref: u.ref, ok: true }); continue; }
    if (!forge.git.hasObject(u.newSha)) { report.push({ ref: u.ref, ok: false, reason: 'missing object' }); continue; }
    if (u.oldSha !== ZERO && !forge.git.isAncestor(u.oldSha, u.newSha)) { report.push({ ref: u.ref, ok: false, reason: 'non-fast-forward' }); continue; }
    repo.refs.set(u.ref, u.newSha);
    if (u.ref === headTarget(repo)) repo.refs.set('HEAD', `ref: ${u.ref}`);
    report.push({ ref: u.ref, ok: true });
  }
  let inner = pkt('unpack ok\n');
  for (const r of report) inner = Buffer.concat([inner, pkt(`${r.ok ? 'ok' : 'ng'} ${r.ref}${r.ok ? '' : ` ${r.reason}`}\n`)]);
  inner = Buffer.concat([inner, flush()]);
  return caps.includes('side-band-64k') ? Buffer.concat([sideband(1, inner), flush()]) : inner;
}

export async function smart(forge, req, res, url, body) {
  const parsed = parseRepoPath(url.pathname);
  if (!parsed) return false;
  let repo;
  try { repo = forge.getRepo(parsed.owner, parsed.repo); }
  catch {
    writeBinary(res, 404, { 'content-type': 'text/plain' }, Buffer.from('not found'));
    return true;
  }

  if (req.method === 'GET' && parsed.action === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      writeBinary(res, 400, { 'content-type': 'text/plain' }, Buffer.from('bad service'));
      return true;
    }
    const version = String(req.headers['git-protocol'] || '').includes('version=2') ? 2 : 0;
    writeBinary(res, 200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache' }, version === 2 ? advertiseV2() : advertiseV0(forge, repo, service));
    return true;
  }

  if (req.method === 'POST' && parsed.action === 'git-upload-pack') {
    const version = String(req.headers['git-protocol'] || '').includes('version=2') ? 2 : 0;
    writeBinary(res, 200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' }, version === 2 ? uploadPackV2(forge, repo, body) : uploadPackV0(forge, repo, body));
    return true;
  }

  if (req.method === 'POST' && parsed.action === 'git-receive-pack') {
    writeBinary(res, 200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' }, applyReceivePack(forge, repo, body));
    return true;
  }

  writeBinary(res, 405, { 'content-type': 'text/plain' }, Buffer.from('method not allowed'));
  return true;
}

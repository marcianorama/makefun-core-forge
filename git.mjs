import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';

const MODES = new Set(['100644', '100755', '120000', '40000']);
const TYPE_TO_NUM = { commit: 1, tree: 2, blob: 3, tag: 4, ofs_delta: 6, ref_delta: 7 };
const NUM_TO_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs_delta', 7: 'ref_delta' };
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEFAULT_IDENT = { name: 'makefun', email: 'makefun@example.invalid', time: 1700000000, tz: '+0000' };

function sha1(data) { return createHash('sha1').update(data).digest('hex'); }
function toRaw(type, data) { return Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]); }
function ensureDir(path) { if (!existsSync(path)) mkdirSync(path, { recursive: true }); }
function objectPath(base, sha) { return join(base, sha.slice(0, 2), sha.slice(2)); }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }

function parseHeader(raw) {
  const nul = raw.indexOf(0);
  if (nul < 0) throw new Error('invalid object header');
  const head = raw.subarray(0, nul).toString('utf8');
  const sp = head.indexOf(' ');
  if (sp < 0) throw new Error('invalid object header');
  const type = head.slice(0, sp);
  const size = Number(head.slice(sp + 1));
  const data = raw.subarray(nul + 1);
  if (data.length !== size) throw new Error('invalid object length');
  return { type, data };
}

function decodeVarint(buf, offset) {
  let res = 0, shift = 0, i = offset;
  while (true) {
    if (i >= buf.length) throw new Error('unexpected eof varint');
    const b = buf[i++];
    res |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value: res, offset: i };
}

function readDeltaOffset(buf, offset) {
  if (offset >= buf.length) throw new Error('unexpected eof ofs-delta');
  let c = buf[offset++];
  let value = c & 0x7f;
  while (c & 0x80) {
    if (offset >= buf.length) throw new Error('unexpected eof ofs-delta');
    c = buf[offset++];
    value = ((value + 1) << 7) | (c & 0x7f);
  }
  return { value, offset };
}

function applyDelta(base, delta) {
  let off = 0;
  const src = decodeVarint(delta, off);
  off = src.offset;
  if (base.length !== src.value) throw new Error('delta base size mismatch');
  const dst = decodeVarint(delta, off);
  off = dst.offset;
  const outSize = dst.value;
  const chunks = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0, cpLen = 0;
      if (op & 0x01) cpOff |= delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpLen |= delta[off++];
      if (op & 0x20) cpLen |= delta[off++] << 8;
      if (op & 0x40) cpLen |= delta[off++] << 16;
      if (cpLen === 0) cpLen = 0x10000;
      const part = base.subarray(cpOff, cpOff + cpLen);
      if (part.length !== cpLen) throw new Error('delta copy out of range');
      chunks.push(part);
      produced += part.length;
    } else if (op) {
      const part = delta.subarray(off, off + op);
      if (part.length !== op) throw new Error('delta insert out of range');
      chunks.push(part);
      produced += part.length;
      off += op;
    } else throw new Error('invalid delta opcode');
  }
  const out = Buffer.concat(chunks);
  if (produced !== outSize || out.length !== outSize) throw new Error('delta result size mismatch');
  return out;
}

function parsePerson(line) {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  return m ? { name: m[1], email: m[2], time: Number(m[3]), tz: m[4], raw: line } : { name: '', email: '', time: 0, tz: '+0000', raw: line };
}
function formatPerson(identity = {}) { const id = { ...DEFAULT_IDENT, ...identity }; return `${id.name} <${id.email}> ${id.time} ${id.tz}`; }

function parseCommitBody(buf, sha = '') {
  const text = buf.toString('utf8');
  const split = text.indexOf('\n\n');
  const headers = split >= 0 ? text.slice(0, split).split('\n') : text.split('\n');
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents = [];
  let author = null;
  let committer = null;
  for (const line of headers) {
    if (!line) continue;
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = parsePerson(line.slice(7));
    else if (line.startsWith('committer ')) committer = parsePerson(line.slice(10));
  }
  return { sha, tree, parents, message, author, committer };
}

function parseTree(buf) {
  const entries = [];
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    const nul = buf.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > buf.length) throw new Error('invalid tree');
    entries.push({ mode: buf.subarray(off, sp).toString('utf8'), name: buf.subarray(sp + 1, nul).toString('utf8'), sha: buf.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}

function buildTree(entries) {
  const parts = [];
  for (const { mode, name, sha } of entries) {
    parts.push(Buffer.from(`${mode} ${name}\0`));
    parts.push(Buffer.from(sha, 'hex'));
  }
  return Buffer.concat(parts);
}

function normalizeFilesMap(filesMap) { return filesMap instanceof Map ? new Map(filesMap) : new Map(Object.entries(filesMap || {})); }
function splitPathParts(p) { return p.split('/').filter(Boolean); }
function compareTreeEntries(a, b) { const an = a.mode === '40000' ? `${a.name}/` : a.name; const bn = b.mode === '40000' ? `${b.name}/` : b.name; return an < bn ? -1 : an > bn ? 1 : 0; }
function bufferLines(buf) { return buf.toString('utf8').split('\n'); }
function isProbablyText(buf) { for (const b of buf.subarray(0, Math.min(buf.length, 8000))) if (b === 0) return false; return true; }
function entryEqual(a, b) { return !!a && !!b && a.sha === b.sha && a.mode === b.mode; }

function simplePatch(path, aBuf, bBuf) {
  if (!isProbablyText(aBuf) || !isProbablyText(bBuf)) return null;
  const a = bufferLines(aBuf), b = bufferLines(bBuf);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let enda = a.length - 1, endb = b.length - 1;
  while (enda >= start && endb >= start && a[enda] === b[endb]) { enda--; endb--; }
  const oldCount = Math.max(0, enda - start + 1), newCount = Math.max(0, endb - start + 1);
  const chunk = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1},${oldCount} +${start + 1},${newCount} @@`];
  for (let i = start; i <= enda; i++) chunk.push(`-${a[i]}`);
  for (let i = start; i <= endb; i++) chunk.push(`+${b[i]}`);
  return chunk.join('\n');
}

export class GitStore {
  constructor({ directory } = {}) {
    this.directory = directory || join(tmpdir(), `makefun-git-${process.pid}`);
    this.objectsDir = join(this.directory, 'objects');
    ensureDir(this.objectsDir);
    this.journalPath = join(this.directory, 'objects.journal');
    this.objects = new Map();
    this.commitCache = new Map();
    this.treeCache = new Map();
    this.flattenCache = new Map();
    this.packCache = new Map();
    this.packCacheLimit = 64;
    this._loadJournal();
    if (!this.hasObject(EMPTY_TREE)) this.writeObject('tree', Buffer.alloc(0));
  }

  _loadJournal() {
    if (!existsSync(this.journalPath)) return;
    const buf = readFileSync(this.journalPath);
    let off = 0;
    while (off + 4 <= buf.length) {
      const typeLen = buf.readUInt32BE(off); off += 4;
      if (off + typeLen + 4 > buf.length) break;
      const type = buf.subarray(off, off + typeLen).toString('utf8'); off += typeLen;
      const dataLen = buf.readUInt32BE(off); off += 4;
      if (off + dataLen > buf.length) break;
      const data = Buffer.from(buf.subarray(off, off + dataLen)); off += dataLen;
      const raw = toRaw(type, data);
      this.objects.set(sha1(raw), { type, data, raw });
    }
  }

  _persistRecord(type, data) {
    appendFileSync(this.journalPath, Buffer.concat([u32(Buffer.byteLength(type)), Buffer.from(type), u32(data.length), data]));
  }

  _cachePack(key, pack) {
    if (this.packCache.has(key)) this.packCache.delete(key);
    this.packCache.set(key, pack);
    while (this.packCache.size > this.packCacheLimit) this.packCache.delete(this.packCache.keys().next().value);
  }

  hasObject(sha) { return this.objects.has(sha); }

  writeObject(type, data) {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);
    const raw = toRaw(type, data);
    const sha = sha1(raw);
    if (!this.objects.has(sha)) {
      const record = { type, data, raw };
      this.objects.set(sha, record);
      this._persistRecord(type, data);
    }
    return sha;
  }

  readObject(sha) {
    const hit = this.objects.get(sha);
    if (!hit) throw Object.assign(new Error(`missing object ${sha}`), { status: 404 });
    return { type: hit.type, data: Buffer.from(hit.data) };
  }

  getCommit(sha) {
    if (this.commitCache.has(sha)) return this.commitCache.get(sha);
    const obj = this.readObject(sha);
    if (obj.type !== 'commit') throw new Error(`object ${sha} is not commit`);
    const commit = parseCommitBody(obj.data, sha);
    this.commitCache.set(sha, commit);
    return commit;
  }

  _treeEntries(treeSha) {
    if (this.treeCache.has(treeSha)) return this.treeCache.get(treeSha);
    const obj = this.readObject(treeSha);
    if (obj.type !== 'tree') throw new Error(`object ${treeSha} is not tree`);
    const entries = parseTree(obj.data);
    this.treeCache.set(treeSha, entries);
    return entries;
  }

  flattenTree(treeSha, prefix = '') {
    const key = `${treeSha}:${prefix}`;
    if (this.flattenCache.has(key)) return new Map(this.flattenCache.get(key));
    const out = new Map();
    const walk = (sha, pre) => {
      for (const entry of this._treeEntries(sha)) {
        const p = pre ? `${pre}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.sha, p);
        else out.set(p, { sha: entry.sha, mode: entry.mode });
      }
    };
    walk(treeSha, prefix);
    this.flattenCache.set(key, new Map(out));
    return out;
  }

  writeTree(filesMap) {
    const files = normalizeFilesMap(filesMap);
    const root = { files: new Map(), dirs: new Map() };
    for (const [path, value] of files) {
      if (!value?.sha) continue;
      const mode = value.mode || '100644';
      if (!MODES.has(mode) || mode === '40000') throw new Error('invalid file mode');
      const parts = splitPathParts(path);
      if (!parts.length) continue;
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { files: new Map(), dirs: new Map() });
        node = node.dirs.get(parts[i]);
      }
      node.files.set(parts.at(-1), { sha: value.sha, mode });
    }
    const writeNode = (node) => {
      const entries = [];
      for (const [name, dir] of node.dirs) entries.push({ name, mode: '40000', sha: writeNode(dir) });
      for (const [name, file] of node.files) entries.push({ name, mode: file.mode, sha: file.sha });
      entries.sort(compareTreeEntries);
      return this.writeObject('tree', buildTree(entries));
    };
    return writeNode(root);
  }

  createCommit(filesMap, parents, message, identity = {}) {
    const tree = this.writeTree(filesMap);
    const ident = formatPerson(identity);
    const lines = [`tree ${tree}`];
    for (const p of parents || []) lines.push(`parent ${p}`);
    lines.push(`author ${ident}`, `committer ${ident}`, '', message || '');
    return this.writeObject('commit', Buffer.from(lines.join('\n')));
  }

  ancestors(sha) {
    const seen = new Set();
    const stack = sha ? [sha] : [];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      seen.add(cur);
      for (const p of this.getCommit(cur).parents) stack.push(p);
    }
    return seen;
  }

  isAncestor(oldSha, newSha) {
    if (!oldSha || !newSha) return false;
    if (oldSha === newSha) return true;
    try {
      const parents = this.getCommit(newSha).parents;
      if (parents.includes(oldSha)) return true;
    } catch {}
    const seen = new Set();
    const stack = [newSha];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || seen.has(cur)) continue;
      if (cur === oldSha) return true;
      seen.add(cur);
      try { for (const p of this.getCommit(cur).parents) stack.push(p); } catch {}
    }
    return false;
  }

  mergeBase(a, b) {
    if (!a || !b) return null;
    if (a === b) return a;
    const aa = this.ancestors(a);
    const seen = new Set();
    const queue = [b];
    while (queue.length) {
      const cur = queue.shift();
      if (!cur || seen.has(cur)) continue;
      if (aa.has(cur)) return cur;
      seen.add(cur);
      for (const p of this.getCommit(cur).parents) queue.push(p);
    }
    return null;
  }

  mergeTrees(baseCommit, leftCommit, rightCommit) {
    const base = this.flattenTree(baseCommit ? this.getCommit(baseCommit).tree : EMPTY_TREE);
    const left = this.flattenTree(leftCommit ? this.getCommit(leftCommit).tree : EMPTY_TREE);
    const right = this.flattenTree(rightCommit ? this.getCommit(rightCommit).tree : EMPTY_TREE);
    const paths = new Set([...base.keys(), ...left.keys(), ...right.keys()]);
    const out = new Map();
    const conflicts = [];
    for (const path of [...paths].sort()) {
      const be = base.get(path), le = left.get(path), re = right.get(path);
      if (entryEqual(le, re)) { if (le) out.set(path, le); continue; }
      if (entryEqual(be, le)) { if (re) out.set(path, re); continue; }
      if (entryEqual(be, re)) { if (le) out.set(path, le); continue; }
      if (!be && le && !re) { out.set(path, le); continue; }
      if (!be && !le && re) { out.set(path, re); continue; }
      conflicts.push(path);
    }
    if (conflicts.length) {
      const err = new Error(`merge conflict: ${conflicts.join(', ')}`);
      err.status = 405;
      err.conflicts = conflicts;
      throw err;
    }
    return out;
  }

  diff(aCommit, bCommit) {
    const a = this.flattenTree(aCommit ? this.getCommit(aCommit).tree : EMPTY_TREE);
    const b = this.flattenTree(bCommit ? this.getCommit(bCommit).tree : EMPTY_TREE);
    const out = [];
    for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const ae = a.get(path), be = b.get(path);
      if (entryEqual(ae, be)) continue;
      const aBuf = ae ? this.readObject(ae.sha).data : Buffer.alloc(0);
      const bBuf = be ? this.readObject(be.sha).data : Buffer.alloc(0);
      const status = !ae ? 'added' : !be ? 'removed' : 'modified';
      let additions = 0, deletions = 0;
      if (isProbablyText(aBuf) && isProbablyText(bBuf)) {
        const al = aBuf.length ? bufferLines(aBuf) : [], bl = bBuf.length ? bufferLines(bBuf) : [];
        let start = 0;
        while (start < al.length && start < bl.length && al[start] === bl[start]) start++;
        let enda = al.length - 1, endb = bl.length - 1;
        while (enda >= start && endb >= start && al[enda] === bl[endb]) { enda--; endb--; }
        deletions = Math.max(0, enda - start + 1);
        additions = Math.max(0, endb - start + 1);
      } else {
        additions = be ? 1 : 0;
        deletions = ae ? 1 : 0;
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions, patch: simplePatch(path, aBuf, bBuf), sha: be?.sha || ae?.sha || '' });
    }
    return out;
  }

  _tagTarget(sha) {
    const obj = this.readObject(sha);
    if (obj.type !== 'tag') return null;
    const text = obj.data.toString('utf8');
    const objectLine = text.split('\n').find((l) => l.startsWith('object '));
    const typeLine = text.split('\n').find((l) => l.startsWith('type '));
    if (!objectLine) return null;
    return { sha: objectLine.slice(7).trim(), type: typeLine ? typeLine.slice(5).trim() : null };
  }

  _collectObjectClosure(startShas, stop = new Set(), shallowStops = new Set()) {
    const seen = new Set();
    const stack = [...startShas.filter(Boolean)];
    while (stack.length) {
      const sha = stack.pop();
      if (!sha || seen.has(sha) || stop.has(sha) || !this.hasObject(sha)) continue;
      seen.add(sha);
      const obj = this.readObject(sha);
      if (obj.type === 'commit') {
        const c = this.getCommit(sha);
        stack.push(c.tree);
        if (!shallowStops.has(sha)) stack.push(...c.parents);
      } else if (obj.type === 'tree') {
        for (const e of this._treeEntries(sha)) if (e.mode !== '160000') stack.push(e.sha);
      } else if (obj.type === 'tag') {
        const target = this._tagTarget(sha);
        if (target) stack.push(target.sha);
      }
    }
    return seen;
  }

  reachable(wants, haves = [], depth = Infinity, clientShallows = []) {
    const shallowStops = new Set(clientShallows || []);
    const haveClosure = this._collectObjectClosure(haves || [], new Set(), shallowStops);
    const include = new Set();
    const boundaries = new Set();
    const unshallow = new Set();
    const commitSeen = new Set();
    const queue = [];

    const addObjectClosure = (sha) => {
      const stack = [sha];
      const seen = new Set();
      while (stack.length) {
        const cur = stack.pop();
        if (!cur || seen.has(cur) || !this.hasObject(cur)) continue;
        seen.add(cur);
        if (!haveClosure.has(cur)) include.add(cur);
        const obj = this.readObject(cur);
        if (obj.type === 'tree') {
          for (const e of this._treeEntries(cur)) if (e.mode !== '160000') stack.push(e.sha);
        } else if (obj.type === 'tag') {
          const target = this._tagTarget(cur);
          if (target) stack.push(target.sha);
        } else if (obj.type === 'commit') {
          const c = this.getCommit(cur);
          stack.push(c.tree, ...c.parents);
        }
      }
    };

    for (const want of wants || []) {
      if (!want || !this.hasObject(want)) continue;
      const obj = this.readObject(want);
      if (obj.type === 'commit') queue.push({ sha: want, depth: 0 });
      else addObjectClosure(want);
    }

    while (queue.length) {
      const { sha, depth: d } = queue.shift();
      if (!sha || commitSeen.has(sha) || !this.hasObject(sha)) continue;
      commitSeen.add(sha);
      const commit = this.getCommit(sha);
      const alreadyHeld = haveClosure.has(sha);
      if (!alreadyHeld) include.add(sha);
      addObjectClosure(commit.tree);
      const canTraverseParents = d < depth - 1;
      if (shallowStops.has(sha) && canTraverseParents) unshallow.add(sha);
      if (!canTraverseParents) {
        if (commit.parents.length) boundaries.add(sha);
        continue;
      }
      for (const p of commit.parents) {
        if (haveClosure.has(p) && !shallowStops.has(p)) continue;
        queue.push({ sha: p, depth: d + 1 });
      }
    }

    const objects = [...include].filter((sha) => !haveClosure.has(sha)).map((sha) => {
      const { type, data } = this.readObject(sha);
      return { sha, type, data };
    });
    return { objects, boundaries: [...boundaries], unshallow: [...unshallow] };
  }

  pack(objects) {
    const key = JSON.stringify(objects.map((o) => o.sha));
    if (this.packCache.has(key)) {
      const cached = this.packCache.get(key);
      this.packCache.delete(key);
      this.packCache.set(key, cached);
      return Buffer.from(cached);
    }
    const head = Buffer.alloc(12);
    head.write('PACK', 0, 'ascii');
    head.writeUInt32BE(2, 4);
    head.writeUInt32BE(objects.length, 8);
    const parts = [head];
    for (const obj of objects.map((o) => ({ sha: o.sha, type: o.type, data: Buffer.from(o.data) }))) {
      const typeNum = TYPE_TO_NUM[obj.type];
      let size = obj.data.length;
      let first = (typeNum << 4) | (size & 0x0f);
      size >>>= 4;
      const hdr = [];
      if (size) first |= 0x80;
      hdr.push(first);
      while (size) {
        let b = size & 0x7f;
        size >>>= 7;
        if (size) b |= 0x80;
        hdr.push(b);
      }
      parts.push(Buffer.from(hdr), zlib.deflateSync(obj.data));
    }
    const body = Buffer.concat(parts);
    const trailer = createHash('sha1').update(body).digest();
    const pack = Buffer.concat([body, trailer]);
    this._cachePack(key, pack);
    return pack;
  }

  unpack(buffer) {
    if (buffer.length < 32) throw new Error('short pack');
    const payload = buffer.subarray(0, buffer.length - 20);
    const checksum = buffer.subarray(buffer.length - 20);
    if (!createHash('sha1').update(payload).digest().equals(checksum)) throw new Error('pack checksum mismatch');
    if (payload.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('invalid pack signature');
    const version = payload.readUInt32BE(4);
    if (version !== 2 && version !== 3) throw new Error('unsupported pack version');
    const count = payload.readUInt32BE(8);
    let off = 12;
    const unpacked = [];
    const byOffset = new Map();
    const pending = [];

    const inflateObject = (start) => {
      const out = zlib.inflateSync(payload.subarray(start), { info: true });
      const consumed = out.engine?.bytesWritten;
      if (!consumed || typeof consumed !== 'number') throw new Error('inflate consumed unavailable');
      return { data: out.buffer, consumed };
    };

    for (let i = 0; i < count; i++) {
      const entryOffset = off;
      let c = payload[off++];
      const typeNum = (c >> 4) & 0x07;
      let size = c & 0x0f;
      let shift = 4;
      while (c & 0x80) { c = payload[off++]; size |= (c & 0x7f) << shift; shift += 7; }
      const type = NUM_TO_TYPE[typeNum];
      let baseRef = null, baseOffset = null;
      if (type === 'ofs_delta') {
        const parsed = readDeltaOffset(payload, off);
        off = parsed.offset;
        baseOffset = entryOffset - parsed.value;
      } else if (type === 'ref_delta') {
        baseRef = payload.subarray(off, off + 20).toString('hex');
        off += 20;
      }
      const inflated = inflateObject(off);
      off += inflated.consumed;
      const body = Buffer.from(inflated.data);
      if (type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag') {
        if (body.length !== size) throw new Error('pack object size mismatch');
        const sha = this.writeObject(type, body);
        const rec = { sha, type, data: body, offset: entryOffset };
        unpacked.push(rec);
        byOffset.set(entryOffset, rec);
      } else {
        if (body.length !== size) throw new Error('pack delta size mismatch');
        pending.push({ type, body, baseRef, baseOffset, offset: entryOffset });
      }
    }

    let progress = true;
    while (pending.length && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const p = pending[i];
        let base = null;
        if (p.type === 'ofs_delta') base = byOffset.get(p.baseOffset);
        else if (p.type === 'ref_delta') {
          if (this.hasObject(p.baseRef)) {
            const obj = this.readObject(p.baseRef);
            base = { sha: p.baseRef, type: obj.type, data: obj.data };
          } else base = unpacked.find((u) => u.sha === p.baseRef) || null;
        }
        if (!base) continue;
        const result = applyDelta(base.data, p.body);
        const sha = this.writeObject(base.type, result);
        const rec = { sha, type: base.type, data: result, offset: p.offset };
        unpacked.push(rec);
        byOffset.set(p.offset, rec);
        pending.splice(i--, 1);
        progress = true;
      }
    }
    if (pending.length) throw new Error('unresolved thin pack deltas');
  }
}

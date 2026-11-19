import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitStore } from '../git.mjs';
import { Forge } from '../model.mjs';

const dir = mkdtempSync(join(tmpdir(), 'makefun-unit-'));
try {
  const git = new GitStore({ directory: join(dir, 'git') });
  const b1 = git.writeObject('blob', Buffer.from('hello\n'));
  const b2 = git.writeObject('blob', Buffer.from('world\n'));
  const c1 = git.createCommit(new Map([['a.txt', { sha: b1, mode: '100644' }]]), [], 'init');
  const c2 = git.createCommit(new Map([['a.txt', { sha: b2, mode: '100644' }]]), [c1], 'next');
  assert.equal(git.isAncestor(c1, c2), true);
  assert.equal(git.mergeBase(c1, c2), c1);
  assert.equal(git.diff(c1, c2)[0].filename, 'a.txt');

  const ba = git.writeObject('blob', Buffer.from('a'));
  const bb = git.writeObject('blob', Buffer.from('b'));
  const base = git.createCommit(new Map([['a.txt', { sha: ba, mode: '100644' }]]), [], 'base');
  const tip = git.createCommit(new Map([['a.txt', { sha: ba, mode: '100644' }], ['b.txt', { sha: bb, mode: '100644' }]]), [base], 'tip');
  const inc = git.reachable([tip], [base]);
  const incSet = new Set(inc.objects.map((o) => o.sha));
  assert.equal(incSet.has(ba), false);
  assert.equal(incSet.has(bb), true);
  assert.equal(incSet.has(base), false);
  assert.equal(incSet.has(tip), true);

  const depth1 = git.reachable([tip], [], 1);
  const depth1Set = new Set(depth1.objects.map((o) => o.sha));
  assert.equal(depth1Set.has(tip), true);
  assert.equal(depth1Set.has(base), false);
  assert.equal(depth1.boundaries.includes(tip), true);

  const depth2 = git.reachable([tip], [], 2);
  const depth2Set = new Set(depth2.objects.map((o) => o.sha));
  assert.equal(depth2Set.has(base), true);

  const b0 = git.writeObject('blob', Buffer.from('root\n'));
  const b3 = git.writeObject('blob', Buffer.from('leaf\n'));
  const c0 = git.createCommit(new Map([['root.txt', { sha: b0, mode: '100644' }]]), [], 'root');
  const c1s = git.createCommit(new Map([['root.txt', { sha: b0, mode: '100644' }], ['mid.txt', { sha: ba, mode: '100644' }]]), [c0], 'mid');
  const c2s = git.createCommit(new Map([['root.txt', { sha: b0, mode: '100644' }], ['mid.txt', { sha: ba, mode: '100644' }], ['leaf.txt', { sha: b3, mode: '100644' }]]), [c1s], 'leaf');

  const shallow1 = git.reachable([c2s], [], 1);
  const shallow1Set = new Set(shallow1.objects.map((o) => o.sha));
  assert.deepEqual(new Set(shallow1.boundaries), new Set([c2s]));
  assert.deepEqual(new Set(shallow1.unshallow), new Set());
  assert.equal(shallow1Set.has(c2s), true);
  assert.equal(shallow1Set.has(c1s), false);
  assert.equal(shallow1Set.has(c0), false);

  const deepen2 = git.reachable([c2s], [c2s], 2, [c2s]);
  const deepen2Set = new Set(deepen2.objects.map((o) => o.sha));
  assert.deepEqual(new Set(deepen2.boundaries), new Set([c1s]));
  assert.deepEqual(new Set(deepen2.unshallow), new Set([c2s]));
  assert.equal(deepen2Set.has(c2s), false);
  assert.equal(deepen2Set.has(c1s), true);
  assert.equal(deepen2Set.has(c0), false);

  const fullHaveNoNew = git.reachable([base], [base]);
  assert.equal(fullHaveNoNew.objects.length, 0);
  assert.deepEqual(fullHaveNoNew.boundaries, []);
  assert.deepEqual(fullHaveNoNew.unshallow, []);

  const noobj = git.reachable([c2s], [c2s]);
  assert.equal(noobj.objects.length, 0);
  assert.deepEqual(noobj.boundaries, []);
  assert.deepEqual(noobj.unshallow, []);

  const tagBody = Buffer.from(`object ${tip}\ntype commit\ntag v1\ntagger Test <t@example.com> 1700000000 +0000\n\nmsg\n`);
  const tag = git.writeObject('tag', tagBody);
  const tagged = git.reachable([tag], []);
  const tagSet = new Set(tagged.objects.map((o) => o.sha));
  assert.equal(tagSet.has(tag), true);
  assert.equal(tagSet.has(tip), true);

  const journalDir = join(dir, 'journal-store');
  const gitPersist1 = new GitStore({ directory: journalDir });

  const encodeTypeSize = (typeNum, size) => {
    let n = size;
    let first = (typeNum << 4) | (n & 0x0f);
    n >>>= 4;
    const out = [];
    if (n) first |= 0x80;
    out.push(first);
    while (n) {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    }
    return Buffer.from(out);
  };
  const encodeVarint = (n) => {
    const out = [];
    let v = n >>> 0;
    while (true) {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      out.push(b);
      if (!v) break;
    }
    return Buffer.from(out);
  };
  const packEntry = (typeNum, body, extra = Buffer.alloc(0)) => Buffer.concat([encodeTypeSize(typeNum, body.length), extra, deflateSync(body)]);

  const baseBlob = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  const deltaBody = Buffer.concat([
    encodeVarint(baseBlob.length),
    encodeVarint(31),
    Buffer.from([0x90, 0x1a]),
    Buffer.from([0x05]),
    Buffer.from('XYZ!!'),
  ]);
  assert.notEqual(deltaBody.length, 31);
  const packHead = Buffer.alloc(12);
  packHead.write('PACK', 0, 'ascii');
  packHead.writeUInt32BE(2, 4);
  packHead.writeUInt32BE(2, 8);
  const packPayload = Buffer.concat([
    packHead,
    packEntry(3, baseBlob),
    packEntry(7, deltaBody, createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${baseBlob.length}\0`), baseBlob])).digest()),
  ]);
  const syntheticPack = Buffer.concat([packPayload, createHash('sha1').update(packPayload).digest()]);
  const gitDelta = new GitStore({ directory: join(dir, 'delta-pack') });
  gitDelta.unpack(syntheticPack);
  const expandedBlob = Buffer.from('abcdefghijklmnopqrstuvwxyzXYZ!!');
  const expandedSha = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${expandedBlob.length}\0`), expandedBlob])).digest('hex');
  assert.deepEqual(gitDelta.readObject(expandedSha), { type: 'blob', data: expandedBlob });
  const persistBlob = Buffer.from('persisted bytes\nline 2\n');
  const persistBlobSha = gitPersist1.writeObject('blob', persistBlob);
  const persistCommit = gitPersist1.createCommit(new Map([['nested/file.txt', { sha: persistBlobSha, mode: '100644' }]]), [], 'persist commit');
  const persistTree = gitPersist1.getCommit(persistCommit).tree;
  const gitPersist2 = new GitStore({ directory: journalDir });
  assert.deepEqual(gitPersist2.readObject(persistBlobSha), { type: 'blob', data: persistBlob });
  assert.deepEqual(gitPersist2.readObject(persistTree), gitPersist1.readObject(persistTree));
  assert.deepEqual(gitPersist2.readObject(persistCommit), gitPersist1.readObject(persistCommit));
  assert.equal(gitPersist2.getCommit(persistCommit).message, 'persist commit');

  const forge = new Forge({ directory: join(dir, 'forge') });
  const repo = forge.createRepo({ name: 'demo' });
  const put = forge.putContent(repo, 'README.md', { message: 'add', content: Buffer.from('demo\n').toString('base64') });
  assert.equal(typeof put.commit.sha, 'string');
  const issue = forge.createIssue(repo, { title: 'bug', body: 'details' });
  assert.equal(forge.issueJSON(repo, issue).title, 'bug');
  forge.createRef(repo, { ref: 'refs/heads/feature', sha: repo.refs.get('refs/heads/main') });
  forge.putContent(repo, 'feature.txt', { branch: 'feature', message: 'feat', content: Buffer.from('x').toString('base64') });
  const pr = forge.createPull(repo, { title: 'merge me', head: 'feature', base: 'main', body: 'ok' });
  assert.equal(forge.mergePull(repo, pr.number, { merge_method: 'squash' }).merged, true);

  forge.deleteRepo('adaiversen', 'demo');
  assert.throws(() => forge.getRepo('adaiversen', 'demo'), /repository not found/);
  const recreated = forge.createRepo({ name: 'demo' });
  assert.equal(recreated.issues.size, 0);
  assert.equal(recreated.pulls.size, 0);
  assert.equal(recreated.labels.size, 0);
  assert.equal(recreated.comments.size, 0);
  assert.equal(recreated.refs.get('refs/heads/main'), null);
  assert.equal(forge.listRepos().some((r) => r.name === 'demo'), true);

  console.log('unit ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

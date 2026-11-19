import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitStore } from './git.mjs';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function opaqueId(kind, key) {
  return Buffer.from(`${kind}:${key}`).toString('base64');
}

function decodeRefName(ref) {
  if (!ref) return 'main';
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('heads/')) return ref.slice('heads/'.length);
  return ref;
}

function normalizeHeadRef(ref) {
  if (!ref) return 'refs/heads/main';
  if (ref.startsWith('refs/')) return ref;
  if (ref.startsWith('heads/')) return `refs/${ref}`;
  return `refs/heads/${ref}`;
}

function formatUrl(baseUrl, path) {
  const base = baseUrl ? baseUrl.replace(/\/$/, '') : '';
  return `${base}${path}`;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function toIso(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString();
}

function normalizeIssueState(state) {
  if (!state) return 'open';
  const s = String(state).toLowerCase();
  if (s === 'open' || s === 'closed' || s === 'all') return s;
  throw httpError(422, 'invalid state');
}

function normalizePullState(state) {
  if (!state) return 'open';
  const s = String(state).toLowerCase();
  if (s === 'open' || s === 'closed' || s === 'all') return s;
  throw httpError(422, 'invalid state');
}

function commitIdentity(ts) {
  return {
    name: 'makefun',
    email: 'makefun@example.invalid',
    time: ts,
    tz: '+0000',
  };
}

export class Forge {
  constructor({ login = 'adaiversen', baseUrl = '', directory } = {}) {
    this.login = login;
    this.baseUrl = baseUrl;
    this.directory = directory || join(tmpdir(), `makefun-forge-${process.pid}`);
    this.git = new GitStore({ directory: join(this.directory, 'git') });
    this.repos = new Map();
    this.nodes = new Map();
    this._dbid = 1;
    this._clock = 1700000000;
  }

  _nextDbId() {
    return this._dbid++;
  }

  _tick() {
    return this._clock++;
  }

  _registerNode(kind, key, value) {
    const id = opaqueId(kind, key);
    value.id = id;
    if (!('node_id' in value)) value.node_id = id;
    this.nodes.set(id, value);
    return id;
  }

  _repoKey(owner, name) {
    return `${owner}/${name}`.toLowerCase();
  }

  _repoUrls(repo) {
    const p = `/${repo.owner.login}/${repo.name}`;
    return {
      html_url: formatUrl(this.baseUrl, p),
      url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}`),
      git_url: formatUrl(this.baseUrl, `${p}.git`),
      clone_url: formatUrl(this.baseUrl, `${p}.git`),
      ssh_url: `git@github.com:${repo.owner.login}/${repo.name}.git`,
      issues_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/issues{/number}`),
      pulls_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls{/number}`),
      contents_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/contents/{+path}`),
      comments_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/comments{/number}`),
      commits_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/commits{/sha}`),
      branches_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/branches{/branch}`),
    };
  }

  _ensureBranchRef(repo, branch) {
    const ref = normalizeHeadRef(branch);
    if (!repo.refs.has(ref)) throw httpError(404, 'branch not found');
    return ref;
  }

  _branchCommit(repo, branch) {
    const ref = this._ensureBranchRef(repo, branch);
    return repo.refs.get(ref) || null;
  }

  _resolveCommitish(repo, ref) {
    if (!ref) return this._branchCommit(repo, repo.default_branch);
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    if (repo.refs.has(full)) return repo.refs.get(full);
    throw httpError(404, 'ref not found');
  }

  _filesAtCommit(commitSha) {
    if (!commitSha) return new Map();
    return this.git.flattenTree(this.git.getCommit(commitSha).tree);
  }

  _currentUser() {
    return {
      login: this.login,
      id: 1,
      node_id: opaqueId('User', this.login),
      avatar_url: '',
      html_url: formatUrl(this.baseUrl, `/${this.login}`),
      type: 'User',
      site_admin: false,
    };
  }

  createRepo(input) {
    const owner = input?.owner || this.login;
    const name = String(input?.name || '').trim();
    if (!name) throw httpError(422, 'name is required');
    const key = this._repoKey(owner, name);
    if (this.repos.has(key)) throw httpError(422, 'repository already exists');
    const repo = {
      databaseId: this._nextDbId(),
      node_id: '',
      id: '',
      name,
      owner: { login: owner, id: 1, type: 'User' },
      description: input?.description ?? null,
      private: !!input?.private,
      default_branch: 'main',
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      created_at: toIso(this._tick()),
      updated_at: null,
      deleted: false,
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      has_issues: true,
    };
    this._registerNode('Repository', `${owner}/${name}`, repo);
    repo.refs.set('HEAD', 'ref: refs/heads/main');
    repo.refs.set('refs/heads/main', null);
    repo.updated_at = repo.created_at;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner, name) {
    const repo = this.repos.get(this._repoKey(owner, name));
    if (!repo || repo.deleted) throw httpError(404, 'repository not found');
    return repo;
  }

  deleteRepo(owner, name) {
    const key = this._repoKey(owner, name);
    const repo = this.repos.get(key);
    if (!repo || repo.deleted) throw httpError(404, 'repository not found');
    repo.deleted = true;
    this.repos.delete(key);
    if (repo.id) this.nodes.delete(repo.id);
    if (repo.node_id && repo.node_id !== repo.id) this.nodes.delete(repo.node_id);
    for (const issue of repo.issues.values()) {
      if (issue?.id) this.nodes.delete(issue.id);
      if (issue?.node_id && issue.node_id !== issue.id) this.nodes.delete(issue.node_id);
    }
    for (const pull of repo.pulls.values()) {
      if (pull?.id) this.nodes.delete(pull.id);
      if (pull?.node_id && pull.node_id !== pull.id) this.nodes.delete(pull.node_id);
    }
    for (const label of repo.labels.values()) {
      if (label?.id) this.nodes.delete(label.id);
      if (label?.node_id && label.node_id !== label.id) this.nodes.delete(label.node_id);
    }
    for (const comment of repo.comments.values()) {
      if (comment?.id) this.nodes.delete(comment.id);
      if (comment?.node_id && comment.node_id !== comment.id) this.nodes.delete(comment.node_id);
    }
  }

  repoJSON(repo) {
    const urls = this._repoUrls(repo);
    return {
      id: repo.databaseId,
      node_id: repo.node_id,
      name: repo.name,
      full_name: `${repo.owner.login}/${repo.name}`,
      private: repo.private,
      owner: this._currentUser(),
      html_url: urls.html_url,
      description: repo.description,
      fork: false,
      url: urls.url,
      git_url: urls.git_url,
      ssh_url: urls.ssh_url,
      clone_url: urls.clone_url,
      default_branch: repo.default_branch,
      has_issues: true,
      open_issues_count: [...repo.issues.values()].filter((i) => i.pull_request == null && i.state === 'open').length,
      created_at: repo.created_at,
      updated_at: repo.updated_at,
      permissions: repo.permissions,
      branches_url: urls.branches_url,
      contents_url: urls.contents_url,
      comments_url: urls.comments_url,
      commits_url: urls.commits_url,
      issues_url: urls.issues_url,
      pulls_url: urls.pulls_url,
    };
  }

  listRepos() {
    return [...this.repos.values()].filter((r) => !r.deleted);
  }

  _labelJSON(repo, label) {
    return {
      id: label.databaseId,
      node_id: label.node_id,
      url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`),
      name: label.name,
      color: label.color,
      default: false,
      description: label.description ?? null,
    };
  }

  issueJSON(repo, issue) {
    const base = formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}`);
    return {
      id: issue.databaseId,
      node_id: issue.node_id,
      url: base,
      repository_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}`),
      labels_url: `${base}/labels{/name}`,
      comments_url: `${base}/comments`,
      events_url: `${base}/events`,
      html_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/issues/${issue.number}`),
      number: issue.number,
      state: issue.state,
      title: issue.title,
      body: issue.body ?? '',
      user: this._currentUser(),
      labels: issue.labels.map((name) => this._labelJSON(repo, repo.labels.get(name))),
      assignee: null,
      assignees: [],
      milestone: null,
      locked: false,
      active_lock_reason: null,
      comments: issue.comments.length,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at,
      author_association: 'OWNER',
      draft: false,
      pull_request: issue.pull_request || undefined,
    };
  }

  _validateLabels(repo, labels) {
    const out = [];
    for (const name of labels || []) {
      if (!repo.labels.has(name)) throw httpError(422, `unknown label: ${name}`);
      out.push(name);
    }
    return out;
  }

  createIssue(repo, input) {
    const title = String(input?.title || '').trim();
    if (!title) throw httpError(422, 'title is required');
    const number = repo.nextNumber++;
    const ts = toIso(this._tick());
    const issue = {
      databaseId: this._nextDbId(),
      node_id: '',
      id: '',
      number,
      title,
      body: input?.body ?? '',
      state: 'open',
      created_at: ts,
      updated_at: ts,
      closed_at: null,
      labels: this._validateLabels(repo, input?.labels || []),
      comments: [],
      pull_request: null,
    };
    this._registerNode('Issue', `${repo.owner.login}/${repo.name}#${number}`, issue);
    repo.issues.set(number, issue);
    repo.updated_at = ts;
    return issue;
  }

  getIssue(repo, n) {
    const issue = repo.issues.get(Number(n));
    if (!issue) throw httpError(404, 'issue not found');
    return issue;
  }

  listIssues(repo, { state, sort, direction } = {}) {
    const st = normalizeIssueState(state || 'open');
    let items = [...repo.issues.values()];
    if (st !== 'all') items = items.filter((i) => i.state === st);
    const dir = String(direction || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const field = sort === 'updated' ? 'updated_at' : 'created_at';
    items.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : a.number - b.number) * dir);
    return items;
  }

  editIssue(repo, n, input) {
    const issue = this.getIssue(repo, n);
    if (input?.title !== undefined) issue.title = String(input.title);
    if (input?.body !== undefined) issue.body = input.body ?? '';
    if (input?.state !== undefined) {
      const st = normalizeIssueState(input.state);
      if (st === 'all') throw httpError(422, 'invalid state');
      issue.state = st;
      if (st === 'closed' && !issue.closed_at) issue.closed_at = toIso(this._tick());
      if (st === 'open') issue.closed_at = null;
    }
    if (input?.labels !== undefined) issue.labels = this._validateLabels(repo, input.labels);
    issue.updated_at = toIso(this._tick());
    repo.updated_at = issue.updated_at;
    return issue;
  }

  createLabel(repo, input) {
    const name = String(input?.name || '').trim();
    if (!name) throw httpError(422, 'name is required');
    const label = {
      databaseId: this._nextDbId(),
      node_id: '',
      id: '',
      name,
      color: String(input?.color || 'ededed').replace(/^#/, ''),
      description: input?.description ?? null,
    };
    this._registerNode('Label', `${repo.owner.login}/${repo.name}:${name}`, label);
    repo.labels.set(name, label);
    repo.updated_at = toIso(this._tick());
    return label;
  }

  comment(repo, n, input) {
    const issue = this.getIssue(repo, n);
    const body = String(input?.body || '');
    if (!body) throw httpError(422, 'body is required');
    const ts = toIso(this._tick());
    const comment = {
      databaseId: this._nextDbId(),
      node_id: '',
      id: '',
      body,
      created_at: ts,
      updated_at: ts,
      issue_number: issue.number,
      pull_number: repo.pulls.has(issue.number) ? issue.number : null,
    };
    this._registerNode('IssueComment', `${repo.owner.login}/${repo.name}:${issue.number}:${comment.databaseId}`, comment);
    issue.comments.push(comment.id);
    repo.comments.set(comment.id, comment);
    issue.updated_at = ts;
    repo.updated_at = ts;
    return comment;
  }

  comments(repo, n) {
    const issue = this.getIssue(repo, n);
    return issue.comments.map((id) => repo.comments.get(id)).filter(Boolean).map((c) => ({
      id: c.databaseId,
      node_id: c.node_id,
      url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/comments/${c.databaseId}`),
      html_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/issues/${issue.number}#issuecomment-${c.databaseId}`),
      body: c.body,
      user: this._currentUser(),
      created_at: c.created_at,
      updated_at: c.updated_at,
      author_association: 'OWNER',
    }));
  }

  _pullRefs(repo, input) {
    const baseRef = normalizeHeadRef(input?.base || input?.baseRefName || repo.default_branch);
    const headRef = normalizeHeadRef(input?.head || input?.headRefName);
    if (!repo.refs.has(baseRef)) throw httpError(422, 'base ref not found');
    if (!repo.refs.has(headRef)) throw httpError(422, 'head ref not found');
    const baseSha = repo.refs.get(baseRef);
    const headSha = repo.refs.get(headRef);
    if (!headSha) throw httpError(422, 'head ref is empty');
    return { baseRef, headRef, baseSha, headSha };
  }

  _mergeable(repo, pull) {
    const currentBase = repo.refs.get(pull.base.ref);
    const currentHead = repo.refs.get(pull.head.ref);
    if (!currentBase || !currentHead) return 'UNKNOWN';
    try {
      this.git.mergeTrees(this.git.mergeBase(currentBase, currentHead), currentBase, currentHead);
      return 'MERGEABLE';
    } catch {
      return 'CONFLICTING';
    }
  }

  pullJSON(repo, pull) {
    const mergeable = this._mergeable(repo, pull);
    return {
      id: pull.databaseId,
      node_id: pull.node_id,
      url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${pull.number}`),
      html_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/pull/${pull.number}`),
      issue_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${pull.number}`),
      number: pull.number,
      state: pull.state,
      title: pull.title,
      body: pull.body ?? '',
      user: this._currentUser(),
      created_at: pull.created_at,
      updated_at: pull.updated_at,
      closed_at: pull.closed_at,
      merged_at: pull.merged_at,
      merge_commit_sha: pull.merge_commit_sha,
      draft: false,
      merged: !!pull.merged_at,
      mergeable,
      head: {
        ref: decodeRefName(pull.head.ref),
        sha: repo.refs.get(pull.head.ref),
        repo: this.repoJSON(repo),
      },
      base: {
        ref: decodeRefName(pull.base.ref),
        sha: repo.refs.get(pull.base.ref),
        repo: this.repoJSON(repo),
      },
    };
  }

  createPull(repo, input) {
    const title = String(input?.title || '').trim();
    if (!title) throw httpError(422, 'title is required');
    const { baseRef, headRef, baseSha, headSha } = this._pullRefs(repo, input);
    const number = repo.nextNumber++;
    const ts = toIso(this._tick());
    const pull = {
      databaseId: this._nextDbId(),
      node_id: '',
      id: '',
      number,
      title,
      body: input?.body ?? '',
      state: 'open',
      created_at: ts,
      updated_at: ts,
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
      merge_method: null,
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
    };
    this._registerNode('PullRequest', `${repo.owner.login}/${repo.name}!${number}`, pull);
    repo.pulls.set(number, pull);
    const issue = {
      databaseId: this._nextDbId(),
      node_id: '',
      id: '',
      number,
      title,
      body: input?.body ?? '',
      state: 'open',
      created_at: ts,
      updated_at: ts,
      closed_at: null,
      labels: [],
      comments: [],
      pull_request: {
        url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${number}`),
        html_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/pull/${number}`),
        diff_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/pull/${number}.diff`),
        patch_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/pull/${number}.patch`),
      },
    };
    this._registerNode('Issue', `${repo.owner.login}/${repo.name}#${number}`, issue);
    repo.issues.set(number, issue);
    repo.updated_at = ts;
    return pull;
  }

  getPull(repo, n) {
    const pull = repo.pulls.get(Number(n));
    if (!pull) throw httpError(404, 'pull request not found');
    return pull;
  }

  listPulls(repo, { state } = {}) {
    const st = normalizePullState(state || 'open');
    let pulls = [...repo.pulls.values()];
    if (st !== 'all') pulls = pulls.filter((p) => p.state === st);
    pulls.sort((a, b) => (a.number - b.number));
    return pulls;
  }

  _pullBaseHead(repo, pull) {
    const baseSha = repo.refs.get(pull.base.ref);
    const headSha = repo.refs.get(pull.head.ref);
    if (!headSha) throw httpError(422, 'head ref missing');
    return { baseSha, headSha };
  }

  editPull(repo, n, input) {
    const pull = this.getPull(repo, n);
    if (input?.title !== undefined) pull.title = String(input.title);
    if (input?.body !== undefined) pull.body = input.body ?? '';
    if (input?.state !== undefined) {
      const st = normalizePullState(input.state);
      if (st === 'all') throw httpError(422, 'invalid state');
      pull.state = st;
      if (st === 'closed' && !pull.closed_at) pull.closed_at = toIso(this._tick());
      if (st === 'open') pull.closed_at = null;
      const issue = repo.issues.get(pull.number);
      if (issue) {
        issue.state = st;
        issue.closed_at = pull.closed_at;
        issue.updated_at = toIso(this._tick());
      }
    }
    pull.updated_at = toIso(this._tick());
    repo.updated_at = pull.updated_at;
    return pull;
  }

  pullFiles(repo, n) {
    const pull = this.getPull(repo, n);
    const { baseSha, headSha } = this._pullBaseHead(repo, pull);
    return this.git.diff(baseSha, headSha);
  }

  _contentEntryJSON(repo, path, refSha, entry) {
    const obj = this.git.readObject(entry.sha);
    return {
      type: 'file',
      encoding: 'base64',
      size: obj.data.length,
      name: path.split('/').pop(),
      path,
      content: obj.data.toString('base64'),
      sha: entry.sha,
      url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/contents/${path}`),
      html_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/blob/${refSha}/${path}`),
      git_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/git/blobs/${entry.sha}`),
      download_url: null,
      _links: {
        self: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/contents/${path}`),
        git: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/git/blobs/${entry.sha}`),
        html: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/blob/${refSha}/${path}`),
      },
    };
  }

  putContent(repo, path, input) {
    if (!path) throw httpError(422, 'path is required');
    const branch = input?.branch || repo.default_branch;
    const ref = normalizeHeadRef(branch);
    if (!repo.refs.has(ref)) throw httpError(404, 'branch not found');
    const head = repo.refs.get(ref);
    const files = this._filesAtCommit(head);
    const existing = files.get(path);
    if (input?.sha !== undefined) {
      if (!existing || existing.sha !== input.sha) throw httpError(409, 'stale sha');
    } else if (existing) {
      throw httpError(409, 'file exists');
    }
    const data = Buffer.from(String(input?.content || ''), 'base64');
    const blobSha = this.git.writeObject('blob', data);
    files.set(path, { sha: blobSha, mode: '100644' });
    const ts = this._tick();
    const commitSha = this.git.createCommit(files, head ? [head] : [], input?.message || `Update ${path}`, commitIdentity(ts));
    repo.refs.set(ref, commitSha);
    repo.updated_at = toIso(ts);
    return {
      content: this._contentEntryJSON(repo, path, commitSha, { sha: blobSha, mode: '100644' }),
      commit: this._commitJSON(repo, commitSha),
    };
  }

  deleteContent(repo, path, input) {
    const branch = input?.branch || repo.default_branch;
    const ref = normalizeHeadRef(branch);
    if (!repo.refs.has(ref)) throw httpError(404, 'branch not found');
    const head = repo.refs.get(ref);
    const files = this._filesAtCommit(head);
    const existing = files.get(path);
    if (!existing) throw httpError(404, 'content not found');
    if (input?.sha !== existing.sha) throw httpError(409, 'stale sha');
    files.delete(path);
    const ts = this._tick();
    const commitSha = this.git.createCommit(files, head ? [head] : [], input?.message || `Delete ${path}`, commitIdentity(ts));
    repo.refs.set(ref, commitSha);
    repo.updated_at = toIso(ts);
    return {
      content: null,
      commit: this._commitJSON(repo, commitSha),
    };
  }

  getContent(repo, path, ref) {
    const commitSha = this._resolveCommitish(repo, ref || repo.default_branch);
    const files = this._filesAtCommit(commitSha);
    if (!path) {
      return this._listDirectory(repo, '', commitSha, files);
    }
    const exact = files.get(path);
    if (exact) return this._contentEntryJSON(repo, path, commitSha, exact);
    const prefix = `${path.replace(/\/$/, '')}/`;
    const found = [...files.keys()].filter((p) => p.startsWith(prefix));
    if (!found.length) throw httpError(404, 'content not found');
    return this._listDirectory(repo, path.replace(/\/$/, ''), commitSha, files);
  }

  _listDirectory(repo, path, refSha, files) {
    const prefix = path ? `${path}/` : '';
    const names = new Map();
    for (const [p, entry] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (!rest) continue;
      const first = rest.split('/')[0];
      if (names.has(first)) continue;
      if (rest.includes('/')) {
        names.set(first, {
          type: 'dir',
          size: 0,
          name: first,
          path: prefix + first,
          sha: null,
          url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/contents/${prefix + first}`),
          html_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/tree/${refSha}/${prefix + first}`),
          git_url: null,
          download_url: null,
        });
      } else {
        const obj = this.git.readObject(entry.sha);
        names.set(first, {
          type: 'file',
          size: obj.data.length,
          name: first,
          path: prefix + first,
          sha: entry.sha,
          url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/contents/${prefix + first}`),
          html_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/blob/${refSha}/${prefix + first}`),
          git_url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/git/blobs/${entry.sha}`),
          download_url: null,
        });
      }
    }
    return [...names.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  _commitJSON(repo, sha) {
    const commit = this.git.getCommit(sha);
    return {
      sha,
      node_id: opaqueId('Commit', sha),
      url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${sha}`),
      html_url: formatUrl(this.baseUrl, `/${repo.owner.login}/${repo.name}/commit/${sha}`),
      parents: commit.parents.map((p) => ({ sha: p, url: formatUrl(this.baseUrl, `/api/v3/repos/${repo.owner.login}/${repo.name}/commits/${p}`) })),
      commit: {
        message: commit.message,
        author: {
          name: commit.author?.name || 'makefun',
          email: commit.author?.email || 'makefun@example.invalid',
          date: toIso(commit.author?.time || 1700000000),
        },
        committer: {
          name: commit.committer?.name || 'makefun',
          email: commit.committer?.email || 'makefun@example.invalid',
          date: toIso(commit.committer?.time || 1700000000),
        },
        tree: { sha: commit.tree },
      },
    };
  }

  commits(repo, ref) {
    const start = this._resolveCommitish(repo, ref || repo.default_branch);
    const out = [];
    const seen = new Set();
    const stack = start ? [start] : [];
    while (stack.length) {
      const sha = stack.shift();
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      out.push(this._commitJSON(repo, sha));
      for (const p of this.git.getCommit(sha).parents) stack.push(p);
    }
    return out;
  }

  branches(repo) {
    return [...repo.refs.entries()]
      .filter(([k]) => k.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: sha ? this._commitJSON(repo, sha) : null,
        protected: false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  createRef(repo, input) {
    const ref = input?.ref;
    const sha = input?.sha;
    if (!ref || !sha) throw httpError(422, 'ref and sha are required');
    if (!ref.startsWith('refs/')) throw httpError(422, 'invalid ref');
    if (!this.git.hasObject(sha)) throw httpError(422, 'unknown object');
    if (repo.refs.has(ref)) throw httpError(422, 'ref exists');
    repo.refs.set(ref, sha);
    repo.updated_at = toIso(this._tick());
    return { ref, object: { type: 'commit', sha } };
  }

  resolveRef(repo, ref) {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const normalized = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    if (repo.refs.has(normalized)) return repo.refs.get(normalized);
    throw httpError(404, 'ref not found');
  }

  mergePull(repo, n, input = {}) {
    const pull = this.getPull(repo, n);
    if (pull.state !== 'open') throw httpError(405, 'pull request is not open');
    const method = String(input.merge_method || input.mergeMethod || 'merge').toLowerCase();
    const baseSha = repo.refs.get(pull.base.ref);
    const headSha = repo.refs.get(pull.head.ref);
    if (!baseSha || !headSha) throw httpError(405, 'missing base or head');
    let mergedFiles;
    try {
      const base = this.git.mergeBase(baseSha, headSha);
      mergedFiles = this.git.mergeTrees(base, baseSha, headSha);
    } catch (err) {
      throw httpError(405, 'merge conflict');
    }
    const ts = this._tick();
    const message = input.commit_message || input.commit_title || `Merge pull request #${pull.number} from ${decodeRefName(pull.head.ref)}`;
    let commitSha;
    if (method === 'squash') {
      commitSha = this.git.createCommit(mergedFiles, baseSha ? [baseSha] : [], message, commitIdentity(ts));
    } else {
      commitSha = this.git.createCommit(mergedFiles, [baseSha, headSha].filter(Boolean), message, commitIdentity(ts));
    }
    repo.refs.set(pull.base.ref, commitSha);
    pull.state = 'closed';
    pull.closed_at = toIso(ts);
    pull.merged_at = pull.closed_at;
    pull.merge_commit_sha = commitSha;
    pull.merge_method = method;
    pull.updated_at = pull.closed_at;
    const issue = repo.issues.get(pull.number);
    if (issue) {
      issue.state = 'closed';
      issue.closed_at = pull.closed_at;
      issue.updated_at = pull.closed_at;
    }
    repo.updated_at = pull.closed_at;
    return {
      sha: commitSha,
      merged: true,
      message: 'Pull Request successfully merged',
    };
  }
}

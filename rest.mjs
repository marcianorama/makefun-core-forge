import { randomUUID } from 'node:crypto';

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (!res.getHeader('x-github-request-id')) res.setHeader('x-github-request-id', randomUUID());
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (status === 204) return res.end();
  res.end(JSON.stringify(body));
}

function apiError(res, err) {
  send(res, err?.status || 500, { message: err?.message || 'Internal Server Error' });
}

function parseIntOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function absoluteOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function paginate(req, url, items) {
  const perPage = parseIntOr(url.searchParams.get('per_page'), items.length || 30);
  const page = parseIntOr(url.searchParams.get('page'), 1);
  const start = (page - 1) * perPage;
  const paged = items.slice(start, start + perPage);
  const links = [];
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const origin = absoluteOrigin(req);
  const make = (p, rel) => {
    const u = new URL(origin + url.pathname + url.search);
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(perPage));
    links.push(`<${u.toString()}>; rel="${rel}"`);
  };
  if (page < lastPage) make(page + 1, 'next');
  if (lastPage > 1) make(lastPage, 'last');
  if (page > 1) make(1, 'first');
  if (page > 1) make(page - 1, 'prev');
  return { items: paged, headers: links.length ? { link: links.join(', ') } : {} };
}

function normalizePath(pathname) {
  if (pathname === '/api/v3' || pathname === '/api/v3/') return '/';
  if (pathname.startsWith('/api/v3/')) return pathname.slice('/api/v3'.length);
  return pathname;
}

function splitPath(pathname) {
  return pathname.split('/').filter(Boolean).map(decodeURIComponent);
}

export async function rest(forge, req, res, url, body) {
  const pathname = url.pathname;
  if (!(pathname === '/api/v3' || pathname === '/api/v3/' || pathname === '/user' || pathname.startsWith('/user/') || pathname.startsWith('/users/') || pathname.startsWith('/repos/') || pathname.startsWith('/api/v3/'))) return false;
  const path = normalizePath(pathname);
  const parts = splitPath(path);

  try {
    if (req.method === 'GET' && path === '/') {
      send(res, 200, { current_user_url: `${forge.baseUrl.replace(/\/$/, '')}/api/v3/user`, repository_url: `${forge.baseUrl.replace(/\/$/, '')}/api/v3/repos/{owner}/{repo}` }, { 'x-oauth-scopes': 'repo' });
      return true;
    }
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'meta') {
      send(res, 200, { installed_version: '1.0.0' });
      return true;
    }
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'user') {
      send(res, 200, { login: forge.login, id: 1, node_id: Buffer.from(`User:${forge.login}`).toString('base64'), avatar_url: '', html_url: `${forge.baseUrl.replace(/\/$/, '')}/${forge.login}`, type: 'User', site_admin: false });
      return true;
    }
    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'users') {
      send(res, 200, { login: parts[1], id: 1, node_id: Buffer.from(`User:${parts[1]}`).toString('base64'), avatar_url: '', html_url: `${forge.baseUrl.replace(/\/$/, '')}/${parts[1]}`, type: 'User', site_admin: false });
      return true;
    }

    if (parts[0] === 'user' && parts[1] === 'repos') {
      if (req.method === 'GET') {
        const { items, headers } = paginate(req, url, forge.listRepos().map((r) => forge.repoJSON(r)));
        send(res, 200, items, headers);
        return true;
      }
      if (req.method === 'POST') {
        const repo = forge.createRepo(body || {});
        send(res, 201, forge.repoJSON(repo));
        return true;
      }
    }

    if (parts[0] === 'repos' && parts.length === 1 && req.method === 'GET') {
      const { items, headers } = paginate(req, url, forge.listRepos().map((r) => forge.repoJSON(r)));
      send(res, 200, items, headers);
      return true;
    }

    if (parts[0] === 'repos' && parts.length >= 3) {
      const [_, owner, name] = parts;
      let repo;
      try {
        repo = forge.getRepo(owner, name);
      } catch {
        send(res, 404, { message: 'Not Found' });
        return true;
      }

      if (parts.length === 3) {
        if (req.method === 'GET') return send(res, 200, forge.repoJSON(repo)), true;
        if (req.method === 'PATCH') {
          if (body?.description !== undefined) repo.description = body.description;
          if (body?.default_branch !== undefined) repo.default_branch = body.default_branch;
          send(res, 200, forge.repoJSON(repo));
          return true;
        }
        if (req.method === 'DELETE') {
          forge.deleteRepo(owner, name);
          return send(res, 204, null), true;
        }
      }

      if (parts[3] === 'branches' && req.method === 'GET') {
        if (parts.length === 4) {
          const { items, headers } = paginate(req, url, forge.branches(repo));
          send(res, 200, items, headers);
          return true;
        }
        const branchName = parts.slice(4).join('/');
        const branch = forge.branches(repo).find((b) => b.name === branchName);
        if (!branch) return send(res, 404, { message: 'Not Found' }), true;
        send(res, 200, branch);
        return true;
      }

      if (parts[3] === 'git' && parts[4] === 'ref' && req.method === 'GET') {
        const refName = parts.slice(5).join('/');
        const sha = forge.resolveRef(repo, refName);
        send(res, 200, { ref: refName.startsWith('refs/') ? refName : `refs/heads/${refName}`, object: { type: 'commit', sha } });
        return true;
      }
      if (parts[3] === 'git' && parts[4] === 'refs' && req.method === 'POST') {
        send(res, 201, forge.createRef(repo, body || {}));
        return true;
      }

      if (parts[3] === 'commits' && req.method === 'GET') {
        const ref = url.searchParams.get('sha') || repo.default_branch;
        const { items, headers } = paginate(req, url, forge.commits(repo, ref));
        send(res, 200, items, headers);
        return true;
      }

      if (parts[3] === 'contents') {
        const contentPath = parts.slice(4).join('/');
        if (req.method === 'GET') return send(res, 200, forge.getContent(repo, contentPath, url.searchParams.get('ref') || repo.default_branch)), true;
        if (req.method === 'PUT') {
          const created = !body?.sha;
          send(res, created ? 201 : 200, forge.putContent(repo, contentPath, body || {}));
          return true;
        }
        if (req.method === 'DELETE') return send(res, 200, forge.deleteContent(repo, contentPath, body || {})), true;
      }

      if (parts[3] === 'labels') {
        if (req.method === 'GET' && parts.length === 4) {
          const labels = [...repo.labels.values()].map((l) => ({ id: l.databaseId, node_id: l.node_id, url: `${forge.baseUrl.replace(/\/$/, '')}/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(l.name)}`, name: l.name, color: l.color, default: false, description: l.description }));
          const { items, headers } = paginate(req, url, labels);
          send(res, 200, items, headers);
          return true;
        }
        if (req.method === 'POST' && parts.length === 4) {
          const label = forge.createLabel(repo, body || {});
          send(res, 201, { id: label.databaseId, node_id: label.node_id, url: `${forge.baseUrl.replace(/\/$/, '')}/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(label.name)}`, name: label.name, color: label.color, default: false, description: label.description });
          return true;
        }
      }

      if (parts[3] === 'issues') {
        if (req.method === 'GET' && parts.length === 4) {
          const issues = forge.listIssues(repo, { state: url.searchParams.get('state') || undefined, sort: url.searchParams.get('sort') || undefined, direction: url.searchParams.get('direction') || undefined }).map((i) => forge.issueJSON(repo, i));
          const { items, headers } = paginate(req, url, issues);
          send(res, 200, items, headers);
          return true;
        }
        if (req.method === 'POST' && parts.length === 4) return send(res, 201, forge.issueJSON(repo, forge.createIssue(repo, body || {}))), true;
        if (parts.length === 5) {
          const number = Number(parts[4]);
          if (req.method === 'GET') return send(res, 200, forge.issueJSON(repo, forge.getIssue(repo, number))), true;
          if (req.method === 'PATCH') return send(res, 200, forge.issueJSON(repo, forge.editIssue(repo, number, body || {}))), true;
        }
        if (parts.length === 6 && parts[5] === 'comments') {
          const number = Number(parts[4]);
          if (req.method === 'GET') {
            const { items, headers } = paginate(req, url, forge.comments(repo, number));
            send(res, 200, items, headers);
            return true;
          }
          if (req.method === 'POST') {
            const comment = forge.comment(repo, number, body || {});
            send(res, 201, forge.comments(repo, number).find((c) => c.id === comment.databaseId));
            return true;
          }
        }
      }

      if (parts[3] === 'pulls') {
        if (req.method === 'GET' && parts.length === 4) {
          const pulls = forge.listPulls(repo, { state: url.searchParams.get('state') || undefined }).map((p) => forge.pullJSON(repo, p));
          const { items, headers } = paginate(req, url, pulls);
          send(res, 200, items, headers);
          return true;
        }
        if (req.method === 'POST' && parts.length === 4) return send(res, 201, forge.pullJSON(repo, forge.createPull(repo, body || {}))), true;
        if (parts.length >= 5) {
          const number = Number(parts[4]);
          if (req.method === 'GET' && parts.length === 5) return send(res, 200, forge.pullJSON(repo, forge.getPull(repo, number))), true;
          if (req.method === 'PATCH' && parts.length === 5) return send(res, 200, forge.pullJSON(repo, forge.editPull(repo, number, body || {}))), true;
          if (req.method === 'GET' && parts[5] === 'files') {
            const { items, headers } = paginate(req, url, forge.pullFiles(repo, number));
            send(res, 200, items, headers);
            return true;
          }
          if (req.method === 'GET' && parts[5] === 'commits') {
            const pull = forge.getPull(repo, number);
            const { items, headers } = paginate(req, url, forge.commits(repo, pull.head.ref));
            send(res, 200, items, headers);
            return true;
          }
          if (req.method === 'PUT' && parts[5] === 'merge') {
            try {
              send(res, 200, forge.mergePull(repo, number, body || {}));
            } catch (err) {
              if (err?.status === 405) send(res, 405, { message: err.message });
              else throw err;
            }
            return true;
          }
        }
      }
    }

    send(res, 404, { message: 'Not Found' });
    return true;
  } catch (err) {
    apiError(res, err);
    return true;
  }
}

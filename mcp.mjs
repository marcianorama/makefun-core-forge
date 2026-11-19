function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated forge user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and repo name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function structured(result) {
  return {
    structuredContent: result,
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

function requireArgs(args, required) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('invalid arguments'), { code: -32602 });
  for (const key of required) if (args[key] === undefined) throw Object.assign(new Error(`missing required field: ${key}`), { code: -32602 });
}

async function handleCall(forge, name, args) {
  switch (name) {
    case 'create_repo': {
      requireArgs(args, ['name']);
      const repo = forge.createRepo({ name: args.name, description: args.description, private: args.private });
      return structured(forge.repoJSON(repo));
    }
    case 'get_repo': {
      requireArgs(args, ['owner', 'repo']);
      const repo = forge.getRepo(args.owner, args.repo);
      return structured(forge.repoJSON(repo));
    }
    case 'create_issue': {
      requireArgs(args, ['owner', 'repo', 'title']);
      const repo = forge.getRepo(args.owner, args.repo);
      const issue = forge.createIssue(repo, { title: args.title, body: args.body ?? '' });
      return structured(forge.issueJSON(repo, issue));
    }
    case 'list_issues': {
      requireArgs(args, ['owner', 'repo']);
      const repo = forge.getRepo(args.owner, args.repo);
      return structured(forge.listIssues(repo, { state: args.state }).map((i) => forge.issueJSON(repo, i)));
    }
    case 'create_pull_request': {
      requireArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      const repo = forge.getRepo(args.owner, args.repo);
      const pull = forge.createPull(repo, { title: args.title, head: args.head, base: args.base, body: args.body ?? '' });
      return structured(forge.pullJSON(repo, pull));
    }
    case 'merge_pull_request': {
      requireArgs(args, ['owner', 'repo', 'pull_number']);
      const repo = forge.getRepo(args.owner, args.repo);
      return structured(forge.mergePull(repo, args.pull_number, { merge_method: 'squash' }));
    }
    default:
      throw Object.assign(new Error('tool not found'), { code: -32601 });
  }
}

async function handleOne(forge, reqBody) {
  if (!reqBody || typeof reqBody !== 'object' || Array.isArray(reqBody)) return { httpStatus: 200, body: rpcError(null, -32600, 'Invalid Request') };
  const { id, method, params } = reqBody;
  const isNotification = id === undefined;

  if (method === 'notifications/initialized') {
    return isNotification ? { httpStatus: 202, body: { ok: true } } : { httpStatus: 200, body: rpcResult(id, { ok: true }) };
  }

  if (method === 'initialize' || method === 'server/discover') {
    const result = {
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: 'makefun-core-forge', version: '1.0.0' },
      _meta: { serverInfo: { name: 'makefun-core-forge', version: '1.0.0' } },
    };
    return isNotification ? { httpStatus: 202, body: { ok: true } } : { httpStatus: 200, body: rpcResult(id, result) };
  }

  if (method === 'tools/list') {
    const result = { tools: TOOLS };
    return isNotification ? { httpStatus: 202, body: { ok: true } } : { httpStatus: 200, body: rpcResult(id, result) };
  }

  if (method === 'tools/call') {
    try {
      if (!params || typeof params !== 'object') throw Object.assign(new Error('invalid params'), { code: -32602 });
      if (!params.name) throw Object.assign(new Error('missing required field: name'), { code: -32602 });
      const result = await handleCall(forge, params.name, params.arguments || {});
      return isNotification ? { httpStatus: 202, body: { ok: true } } : { httpStatus: 200, body: rpcResult(id, result) };
    } catch (err) {
      const code = err?.code || -32602;
      const payload = rpcError(id ?? null, code, err?.message || 'Tool error', { isError: true });
      return isNotification ? { httpStatus: 202, body: { ok: true } } : { httpStatus: 200, body: payload };
    }
  }

  return isNotification ? { httpStatus: 202, body: { ok: true } } : { httpStatus: 200, body: rpcError(id ?? null, -32601, 'Method not found') };
}

export async function mcp(forge, req, res, body) {
  const result = await handleOne(forge, body);
  send(res, result.httpStatus, result.body);
}

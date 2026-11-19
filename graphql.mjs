import { buildSchema, parse, validate, specifiedRules, execute } from './vendor/graphql.mjs';

const schema = buildSchema(`
  schema { query: Query mutation: Mutation }
  interface Node { id: ID! }

  type Query {
    viewer: User!
    node(id: ID!): Node
    repository(owner: String!, name: String!): Repository
  }

  type Mutation {
    createIssue(input: CreateIssueInput!): CreateIssuePayload!
    closeIssue(input: CloseIssueInput!): CloseIssuePayload!
    createPullRequest(input: CreatePullRequestInput!): CreatePullRequestPayload!
    mergePullRequest(input: MergePullRequestInput!): MergePullRequestPayload!
    addComment(input: AddCommentInput!): AddCommentPayload!
  }

  type User implements Node { id: ID! login: String! }
  type Repository implements Node {
    id: ID!
    databaseId: Int!
    name: String!
    nameWithOwner: String!
    owner: User!
    defaultBranchRef: Ref
    viewerPermission: RepositoryPermission!
    hasIssuesEnabled: Boolean!
    issue(number: Int!): Issue
    issues(first: Int, after: String, states: [IssueState!], orderBy: IssueOrder): IssueConnection!
    pullRequest(number: Int!): PullRequest
    pullRequests(first: Int, after: String, states: [PullRequestState!]): PullRequestConnection!
  }
  type Ref { name: String! target: Commit }
  type Commit implements Node { id: ID! oid: String! message: String! }
  type Issue implements Node { id: ID! number: Int! title: String! state: IssueState! body: String }
  type PullRequest implements Node {
    id: ID!
    number: Int!
    title: String!
    headRefName: String!
    baseRefName: String!
    mergeable: MergeableState!
    state: PullRequestState!
    merged: Boolean!
    files(first: Int, after: String): PullRequestChangedFileConnection!
  }
  type PullRequestChangedFile { path: String! }
  type PullRequestChangedFileEdge { cursor: String! node: PullRequestChangedFile! }
  type PullRequestChangedFileConnection { nodes: [PullRequestChangedFile!]! edges: [PullRequestChangedFileEdge!]! pageInfo: PageInfo! totalCount: Int! }
  type IssueEdge { cursor: String! node: Issue! }
  type IssueConnection { nodes: [Issue!]! edges: [IssueEdge!]! pageInfo: PageInfo! totalCount: Int! }
  type PullRequestEdge { cursor: String! node: PullRequest! }
  type PullRequestConnection { nodes: [PullRequest!]! edges: [PullRequestEdge!]! pageInfo: PageInfo! totalCount: Int! }
  type IssueComment implements Node { id: ID! body: String! }
  type IssueCommentEdge { cursor: String! node: IssueComment! }
  type CreateIssuePayload { issue: Issue! }
  type CloseIssuePayload { issue: Issue! }
  type CreatePullRequestPayload { pullRequest: PullRequest! }
  type MergePullRequestPayload { pullRequest: PullRequest! }
  type AddCommentPayload { commentEdge: IssueCommentEdge! }

  input CreateIssueInput { repositoryId: ID! title: String! body: String }
  input CloseIssueInput { issueId: ID! }
  input CreatePullRequestInput { repositoryId: ID! baseRefName: String! headRefName: String! title: String! body: String }
  input MergePullRequestInput { pullRequestId: ID! mergeMethod: PullRequestMergeMethod }
  input AddCommentInput { subjectId: ID! body: String! }
  input IssueOrder { field: IssueOrderField! direction: OrderDirection! }

  type PageInfo { hasNextPage: Boolean! endCursor: String }
  enum IssueState { OPEN CLOSED }
  enum PullRequestState { OPEN CLOSED MERGED }
  enum MergeableState { MERGEABLE CONFLICTING UNKNOWN }
  enum PullRequestMergeMethod { MERGE SQUASH REBASE }
  enum RepositoryPermission { ADMIN MAINTAIN WRITE TRIAGE READ }
  enum IssueOrderField { CREATED_AT UPDATED_AT COMMENTS }
  enum OrderDirection { ASC DESC }
  enum SearchType { ISSUE REPOSITORY }
`);

function cursorFor(prefix, index) { return Buffer.from(`${prefix}:${index}`).toString('base64'); }
function parseCursor(cursor, prefix) {
  if (!cursor) return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const cut = decoded.lastIndexOf(':');
    if (cut < 0 || decoded.slice(0, cut) !== prefix) return -1;
    const n = Number.parseInt(decoded.slice(cut + 1), 10);
    return Number.isFinite(n) ? n : -1;
  } catch { return -1; }
}
function connection(prefix, allNodes, first = 20, after = null) {
  const size = Math.max(0, Math.min(first ?? 20, 100));
  const offset = parseCursor(after, prefix);
  const start = Math.max(0, offset + 1);
  const end = start + size;
  const slice = allNodes.slice(start, end);
  const edges = slice.map((node, i) => ({ cursor: cursorFor(prefix, start + i), node }));
  return { nodes: slice, edges, totalCount: allNodes.length, pageInfo: { hasNextPage: end < allNodes.length, endCursor: edges.length ? edges.at(-1).cursor : after || null } };
}

function userNode(forge) { return { id: Buffer.from(`User:${forge.login}`).toString('base64'), login: forge.login, __typename: 'User' }; }
function issueState(issue) { return issue.state === 'closed' ? 'CLOSED' : 'OPEN'; }
function pullState(pull) { return pull.merged_at ? 'MERGED' : pull.state === 'closed' ? 'CLOSED' : 'OPEN'; }
function repoPermission(repo) { return repo.permissions.admin ? 'ADMIN' : repo.permissions.maintain ? 'MAINTAIN' : repo.permissions.push ? 'WRITE' : repo.permissions.triage ? 'TRIAGE' : 'READ'; }

function wrapIssue(repo, issue) { return { ...issue, __typename: 'Issue', state: issueState(issue), body: issue.body ?? '', repository: repo }; }
function wrapComment(comment) { return { ...comment, __typename: 'IssueComment' }; }
function wrapRef(forge, repo, ref) {
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const sha = repo.refs.get(full);
  return { name: ref.replace(/^refs\/heads\//, ''), target: sha ? { id: Buffer.from(`Commit:${sha}`).toString('base64'), oid: sha, message: forge.git.getCommit(sha).message, __typename: 'Commit' } : null, __typename: 'Ref' };
}
function wrapPull(forge, repo, pull) {
  const json = forge.pullJSON(repo, pull);
  return {
    ...pull,
    __typename: 'PullRequest',
    state: pullState(pull),
    merged: !!pull.merged_at,
    mergeable: json.mergeable,
    headRefName: json.head.ref,
    baseRefName: json.base.ref,
    repository: repo,
    files(args) {
      const files = forge.pullFiles(repo, pull.number).map((f) => ({ path: f.filename, __typename: 'PullRequestChangedFile' }));
      return connection(`prfiles:${repo.owner.login}/${repo.name}#${pull.number}`, files, args?.first, args?.after);
    },
  };
}
function wrapRepo(forge, repo) {
  return {
    ...repo,
    __typename: 'Repository',
    databaseId: repo.databaseId,
    nameWithOwner: `${repo.owner.login}/${repo.name}`,
    owner: userNode(forge),
    defaultBranchRef: wrapRef(forge, repo, repo.default_branch),
    viewerPermission: repoPermission(repo),
    hasIssuesEnabled: true,
    issue({ number }) { try { return wrapIssue(repo, forge.getIssue(repo, number)); } catch { return null; } },
    issues(args) {
      let issues = forge.listIssues(repo, { state: !args?.states?.length ? 'all' : undefined, sort: args?.orderBy?.field === 'UPDATED_AT' ? 'updated' : 'created', direction: args?.orderBy?.direction === 'ASC' ? 'asc' : 'desc' });
      if (args?.states?.length) {
        const allowed = new Set(args.states.map((s) => s === 'CLOSED' ? 'closed' : 'open'));
        issues = issues.filter((i) => allowed.has(i.state));
      }
      return connection(`issues:${repo.owner.login}/${repo.name}`, issues.map((i) => wrapIssue(repo, i)), args?.first, args?.after);
    },
    pullRequest({ number }) { try { return wrapPull(forge, repo, forge.getPull(repo, number)); } catch { return null; } },
    pullRequests(args) {
      let pulls = forge.listPulls(repo, { state: 'all' });
      if (args?.states?.length) {
        const allowed = new Set(args.states);
        pulls = pulls.filter((p) => allowed.has(pullState(p)));
      } else pulls = pulls.filter((p) => pullState(p) === 'OPEN');
      pulls.sort((a, b) => b.number - a.number);
      return connection(`pulls:${repo.owner.login}/${repo.name}`, pulls.map((p) => wrapPull(forge, repo, p)), args?.first, args?.after);
    },
  };
}

function nodeFromId(forge, id) {
  if (!id) return null;
  const node = forge.nodes.get(id);
  if (!node) return null;
  if (node.owner?.login && node.refs instanceof Map) return wrapRepo(forge, node);
  if (typeof node.number === 'number' && node.head && node.base) {
    const repo = [...forge.repos.values()].find((r) => r.pulls.get(node.number) === node);
    return repo ? wrapPull(forge, repo, node) : null;
  }
  if (typeof node.number === 'number') {
    const repo = [...forge.repos.values()].find((r) => r.issues.get(node.number) === node);
    return repo ? wrapIssue(repo, node) : null;
  }
  if (typeof node.body === 'string' && node.issue_number) return wrapComment(node);
  return null;
}

function rootValue(forge) {
  return {
    viewer: () => userNode(forge),
    node: ({ id }) => nodeFromId(forge, id),
    repository: ({ owner, name }) => { try { return wrapRepo(forge, forge.getRepo(owner, name)); } catch { return null; } },
    createIssue: ({ input }) => {
      const repoNode = nodeFromId(forge, input.repositoryId);
      if (!repoNode || repoNode.__typename !== 'Repository') throw new Error('repository not found');
      const repo = forge.getRepo(repoNode.owner.login, repoNode.name);
      return { issue: wrapIssue(repo, forge.createIssue(repo, { title: input.title, body: input.body ?? '' })) };
    },
    closeIssue: ({ input }) => {
      const issue = nodeFromId(forge, input.issueId);
      if (!issue || issue.__typename !== 'Issue') throw new Error('issue not found');
      const repo = forge.getRepo(issue.repository.owner.login, issue.repository.name);
      return { issue: wrapIssue(repo, forge.editIssue(repo, issue.number, { state: 'closed' })) };
    },
    createPullRequest: ({ input }) => {
      const repoNode = nodeFromId(forge, input.repositoryId);
      if (!repoNode || repoNode.__typename !== 'Repository') throw new Error('repository not found');
      const repo = forge.getRepo(repoNode.owner.login, repoNode.name);
      return { pullRequest: wrapPull(forge, repo, forge.createPull(repo, { title: input.title, body: input.body, base: input.baseRefName, head: input.headRefName })) };
    },
    mergePullRequest: ({ input }) => {
      const pull = nodeFromId(forge, input.pullRequestId);
      if (!pull || pull.__typename !== 'PullRequest') throw new Error('pull request not found');
      const repo = forge.getRepo(pull.repository.owner.login, pull.repository.name);
      const method = input.mergeMethod || 'SQUASH';
      forge.mergePull(repo, pull.number, { merge_method: String(method).toLowerCase() === 'rebase' ? 'merge' : String(method).toLowerCase() });
      return { pullRequest: wrapPull(forge, repo, forge.getPull(repo, pull.number)) };
    },
    addComment: ({ input }) => {
      const subject = nodeFromId(forge, input.subjectId);
      if (!subject) throw new Error('subject not found');
      let repo, number;
      if (subject.__typename === 'Issue' || subject.__typename === 'PullRequest') {
        repo = forge.getRepo(subject.repository.owner.login, subject.repository.name);
        number = subject.number;
      } else throw new Error('subject not commentable');
      const comment = forge.comment(repo, number, { body: input.body });
      return { commentEdge: { cursor: cursorFor(`comments:${repo.owner.login}/${repo.name}#${number}`, repo.comments.size - 1), node: wrapComment(comment) } };
    },
  };
}

async function runOne(forge, payload) {
  const source = payload?.query;
  if (typeof source !== 'string') return { errors: [{ message: 'Must provide query string.' }] };
  const document = parse(source);
  const errors = validate(schema, document, specifiedRules);
  if (errors.length) return { errors };
  return execute({ schema, document, rootValue: rootValue(forge), variableValues: payload?.variables || {}, operationName: payload?.operationName || undefined });
}

export async function graphqlEndpoint(forge, payload) {
  if (Array.isArray(payload)) return Promise.all(payload.map((entry) => runOne(forge, entry)));
  return runOne(forge, payload);
}

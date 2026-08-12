import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  manifestPath,
  validateManifestEvidence,
  validateProvenance,
} from './capture-manifest.mjs';
import { validCaptureEvidence } from './query-coverage.mjs';
import { loadQuerySets } from './query-set.mjs';

const execFileAsync = promisify(execFile);
const CAPTURE = /^raw\/adzuna-query\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2})\.json$/;
const MANIFEST = /^raw\/_manifests\/(\d{4}-\d{2}-\d{2})\/[^/]+\.json$/;
const ROOTS = ['raw/adzuna-query', 'raw/_manifests'];

function invalidEvidence() {
  throw new Error('census commit evidence invalid');
}

async function git(root, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    invalidEvidence();
  }
}

function nulFields(value) {
  return value.split('\0').filter((field) => field.length > 0);
}

async function assertCleanIndex(root) {
  const staged = nulFields(await git(root, [
    'diff', '--cached', '--name-only', '-z', '--', ...ROOTS,
  ]));
  if (staged.length > 0) invalidEvidence();
}

async function candidatePaths(root) {
  const candidates = new Set();
  const changed = nulFields(await git(root, [
    'diff', '--name-status', '--no-renames', '-z', '--', ...ROOTS,
  ]));
  for (let index = 0; index < changed.length; index += 2) {
    const status = changed[index];
    const path = changed[index + 1];
    if (status !== 'A' || typeof path !== 'string') invalidEvidence();
    candidates.add(path);
  }

  for (const path of nulFields(await git(root, [
    'ls-files', '--others', '--exclude-standard', '-z', '--', ...ROOTS,
  ]))) {
    candidates.add(path);
  }

  for (const path of candidates) {
    if (!path.endsWith('.json') || (!CAPTURE.test(path) && !MANIFEST.test(path))) invalidEvidence();
  }
  return [...candidates].sort();
}

function containedBy(base, path) {
  const fromBase = relative(base, path);
  return fromBase === '' || (!fromBase.startsWith('..') && !isAbsolute(fromBase));
}

async function assertPhysicalCandidate(root, path) {
  const absolutePath = resolve(root, ...path.split('/'));
  const expectedRoot = path.startsWith('raw/adzuna-query/')
    ? resolve(root, 'raw', 'adzuna-query')
    : resolve(root, 'raw', '_manifests');
  if (!containedBy(root, expectedRoot) || !containedBy(expectedRoot, absolutePath)
    || absolutePath === expectedRoot) invalidEvidence();

  try {
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) invalidEvidence();
    let current = root;
    for (const component of relative(root, dirname(absolutePath)).split(sep).filter(Boolean)) {
      current = join(current, component);
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) invalidEvidence();
    }
    const candidateStats = await lstat(absolutePath);
    if (candidateStats.isSymbolicLink() || !candidateStats.isFile()) invalidEvidence();

    const realRoot = await realpath(root);
    const realExpectedRoot = await realpath(expectedRoot);
    const realCandidate = await realpath(absolutePath);
    if (!containedBy(realRoot, realExpectedRoot)
      || !containedBy(realExpectedRoot, realCandidate)) invalidEvidence();
  } catch {
    invalidEvidence();
  }
}

async function committedPaths(root) {
  return new Set(nulFields(await git(root, [
    'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...ROOTS,
  ])));
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    invalidEvidence();
  }
}

function provenanceKey(partition, querySet, run) {
  return JSON.stringify([
    partition,
    querySet,
    run.event_name,
    run.run_id,
    run.run_attempt,
    run.sha,
  ]);
}

function sameProvenance(left, right) {
  return left.event_name === right.event_name
    && left.run_id === right.run_id
    && left.run_attempt === right.run_attempt
    && left.sha === right.sha;
}

function captureRun(value) {
  return {
    event_name: value.event_name,
    run_id: value.run_id,
    run_attempt: value.run_attempt,
    sha: value.sha,
  };
}

function repoPath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function canonicalCapturePath(querySet, queryId, partition) {
  return `raw/adzuna-query/${querySet.country}/${queryId}/${partition}.json`;
}

export async function censusCommitEvidencePaths({
  root = process.cwd(),
  expectedProvenance,
} = {}) {
  const repositoryRoot = resolve(root);
  let expected;
  if (expectedProvenance !== undefined) {
    try {
      expected = validateProvenance(expectedProvenance);
    } catch {
      invalidEvidence();
    }
    if (expected.sha !== (await git(repositoryRoot, ['rev-parse', 'HEAD'])).trim()) invalidEvidence();
  }
  await assertCleanIndex(repositoryRoot);
  const paths = await candidatePaths(repositoryRoot);
  if (paths.length === 0) return [];

  const committed = await committedPaths(repositoryRoot);
  let querySets;
  try {
    querySets = await loadQuerySets(join(repositoryRoot, 'config', 'query-sets'));
  } catch {
    invalidEvidence();
  }
  const querySetsById = new Map(querySets.map((querySet) => [querySet.id, querySet]));
  const capturesByPath = new Map();
  const manifestsByRun = new Map();

  for (const path of paths) {
    await assertPhysicalCandidate(repositoryRoot, path);
    const absolutePath = join(repositoryRoot, ...path.split('/'));
    const captureMatch = CAPTURE.exec(path);
    if (captureMatch) {
      const [, country, queryId, partition] = captureMatch;
      const value = await readJson(absolutePath);
      const querySet = querySetsById.get(value?.query_set);
      const query = querySet?.queries.find((candidate) => candidate.id === queryId);
      if (!querySet || querySet.country !== country
        || !validCaptureEvidence(value, querySet, partition, query)) invalidEvidence();
      capturesByPath.set(path, { path, value, querySet, query, partition });
      continue;
    }

    const manifestMatch = MANIFEST.exec(path);
    if (!manifestMatch) invalidEvidence();
    let value;
    try {
      value = validateManifestEvidence(await readJson(absolutePath));
    } catch {
      invalidEvidence();
    }
    if (expected && !sameProvenance(value.run, expected)) invalidEvidence();
    const querySet = querySetsById.get(value.query_set);
    if (!querySet || value.partition !== manifestMatch[1]
      || value.daily_page_budget !== querySet.daily_page_budget
      || repoPath(repositoryRoot, manifestPath(
        repositoryRoot,
        value.partition,
        value.run.run_id,
        value.run.run_attempt,
      )) !== path) invalidEvidence();

    const expectedIds = new Set(querySet.queries.map((query) => query.id));
    const actualIds = new Set(value.queries.map((query) => query.query_id));
    if (actualIds.size !== value.queries.length || actualIds.size !== expectedIds.size
      || [...expectedIds].some((queryId) => !actualIds.has(queryId))) invalidEvidence();

    const key = provenanceKey(value.partition, value.query_set, value.run);
    if (manifestsByRun.has(key)) invalidEvidence();
    manifestsByRun.set(key, { path, value, querySet });
  }

  const matchedCaptures = new Set();
  for (const { value: manifest, querySet } of manifestsByRun.values()) {
    for (const entry of manifest.queries) {
      const query = querySet.queries.find((candidate) => candidate.id === entry.query_id);
      const path = canonicalCapturePath(querySet, entry.query_id, manifest.partition);
      const candidate = capturesByPath.get(path);
      if (entry.status === 'written' || entry.status === 'valid_zero') {
        const expectedStatus = candidate?.value.count === 0 ? 'valid_zero' : 'written';
        if (!candidate
          || provenanceKey(candidate.partition, candidate.querySet.id, captureRun(candidate.value))
            !== provenanceKey(manifest.partition, manifest.query_set, manifest.run)
          || entry.status !== expectedStatus
          || entry.record_count !== candidate.value.count
          || entry.page_requests !== candidate.value.meta.pages_fetched) invalidEvidence();
        matchedCaptures.add(path);
      } else if (entry.status === 'skipped') {
        if (candidate || !committed.has(path)) invalidEvidence();
        await assertPhysicalCandidate(repositoryRoot, path);
        const historical = await readJson(join(repositoryRoot, ...path.split('/')));
        if (!validCaptureEvidence(historical, querySet, manifest.partition, query)) invalidEvidence();
      } else if (candidate || committed.has(path)) {
        invalidEvidence();
      }
    }
  }

  if (matchedCaptures.size !== capturesByPath.size) invalidEvidence();
  return paths;
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createChecker } from './lib/verify.mjs';
import { runQueryCensus } from './lib/query-census.mjs';

const { check, finish } = createChecker('verify-census-commit-evidence');
const gateScript = resolve('scripts/census-commit-evidence.mjs');
const gateLibrary = resolve('scripts/lib/census-commit-evidence.mjs');
const partition = '2026-08-10';
const provenance = {
  event_name: 'schedule',
  run_id: 'run-a',
  run_attempt: 1,
  sha: '0000000000000000000000000000000000000000',
};
const queries = [
  { id: 'data-analyst', text: 'data analyst', role_family: 'data_analysis_bi' },
  { id: 'data-engineer', text: 'data engineer', role_family: 'data_engineering_architecture' },
];
const querySet = {
  id: 'nz-ai-data-v1',
  country: 'nz',
  effective_from: partition,
  results_per_page: 2,
  daily_page_budget: 60,
  queries,
};

async function test(name, action) {
  try {
    await action();
    check(name, true);
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : String(error));
  }
}

async function run(executable, args, { cwd, env = process.env } = {}) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectChild);
    child.on('close', (code) => resolveChild({ code, stdout, stderr }));
  });
}

async function git(root, ...args) {
  const result = await run('git', args, { cwd: root });
  assert.equal(result.code, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function initRepo(root, selectedQuerySet = querySet) {
  await writeJson(join(root, 'config', 'query-sets', `${selectedQuerySet.id}.json`), selectedQuerySet);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Commit Evidence Test');
  await git(root, 'config', 'user.email', 'commit-evidence@example.invalid');
  await git(root, 'add', '--', 'config');
  await git(root, 'commit', '-m', 'test: baseline');
}

async function commitPaths(root, ...paths) {
  await git(root, 'add', '--', ...paths);
  await git(root, 'commit', '-m', 'test: historical evidence');
}

function capture(query, {
  run = provenance,
  records = [{ id: `${query.id}-1` }],
  termination = records.length === 0 ? 'valid_zero' : 'short_page',
} = {}) {
  return {
    source: 'adzuna',
    coverage_mode: 'query_census',
    country: querySet.country,
    partition,
    fetched_at: '2026-08-10T00:00:00.000Z',
    event_name: run.event_name,
    run_id: run.run_id,
    run_attempt: run.run_attempt,
    sha: run.sha,
    query_set: querySet.id,
    query,
    count: records.length,
    meta: {
      reported_total: records.length,
      pages_fetched: 1,
      results_per_page: querySet.results_per_page,
      termination,
    },
    records,
  };
}

function entry(query, status, { pageRequests = status === 'skipped' ? 0 : 1, recordCount } = {}) {
  const successful = status === 'written' || status === 'valid_zero';
  return {
    query_id: query.id,
    status,
    page_requests: pageRequests,
    record_count: successful ? (recordCount ?? (status === 'valid_zero' ? 0 : 1)) : null,
    error_code: status === 'failed' ? 'http_error' : null,
  };
}

function manifest(items, { run = provenance, dailyPageBudget = querySet.daily_page_budget } = {}) {
  return {
    schema_version: 1,
    collector: 'adzuna-query-census',
    partition,
    query_set: querySet.id,
    run: { ...run },
    started_at: '2026-08-10T00:00:00.000Z',
    finished_at: '2026-08-10T00:01:00.000Z',
    page_requests: items.reduce((sum, item) => sum + item.page_requests, 0),
    daily_page_budget: dailyPageBudget,
    queries: items,
  };
}

function capturePath(root, query = queries[0]) {
  return join(root, 'raw', 'adzuna-query', querySet.country, query.id, `${partition}.json`);
}

function manifestPath(root, run = provenance) {
  return join(root, 'raw', '_manifests', partition, `${run.run_id}-${run.run_attempt}.json`);
}

async function runGate(root, expectedProvenance) {
  const args = [gateScript];
  const env = { ...process.env };
  if (expectedProvenance) {
    args.push('--expected-provenance');
    env.GITHUB_EVENT_NAME = expectedProvenance.event_name;
    env.GITHUB_RUN_ID = expectedProvenance.run_id;
    env.GITHUB_RUN_ATTEMPT = String(expectedProvenance.run_attempt);
    env.GITHUB_SHA = expectedProvenance.sha;
  }
  return run(process.execPath, args, { cwd: root, env });
}

async function runMutatedGate(root, mutator, label) {
  const original = await readFile(gateLibrary, 'utf8');
  const changed = mutator(original);
  assert.notEqual(changed, original, `${label} mutation target missing`);
  const withDependencies = changed
    .replace("from './capture-manifest.mjs'", `from '${pathToFileURL(resolve('scripts/lib/capture-manifest.mjs')).href}'`)
    .replace("from './query-coverage.mjs'", `from '${pathToFileURL(resolve('scripts/lib/query-coverage.mjs')).href}'`)
    .replace("from './query-set.mjs'", `from '${pathToFileURL(resolve('scripts/lib/query-set.mjs')).href}'`);
  const script = join(root, `mutant-gate-${label}.mjs`);
  await writeFile(script, `${withDependencies}\ntry {\n  const paths = await censusCommitEvidencePaths();\n  if (paths.length > 0) process.stdout.write(paths.join('\\n') + '\\n');\n} catch {\n  console.error('census commit evidence invalid');\n  process.exitCode = 1;\n}\n`, 'utf8');
  return run(process.execPath, [script], { cwd: root });
}

async function assertGateRejected(root, expectedProvenance) {
  assert.deepEqual(await runGate(root, expectedProvenance), {
    code: 1,
    stdout: '',
    stderr: 'census commit evidence invalid\n',
  });
}

async function openThenRejectWrite(path, flags) {
  const handle = await open(path, flags);
  return {
    writeFile: async () => { throw new Error('injected manifest write failure'); },
    close: () => handle.close(),
  };
}

await test('no census candidates is a clean no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-empty-'));
  try {
    await initRepo(root);
    assert.deepEqual(await runGate(root), { code: 0, stdout: '', stderr: '' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('staged valid census additions are rejected at the clean-index precondition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-staged-add-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0]));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await git(root, 'add', '--', 'raw');
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('staged additions deleted from the worktree cannot cancel to a clean gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-ad-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0]));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await git(root, 'add', '--', 'raw');
    await rm(capturePath(root));
    await rm(manifestPath(root));
    assert.match(await git(root, 'status', '--short'), /^AD /m);
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('staged invalid modification restored only in the worktree cannot cancel to clean', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-mm-'));
  const selected = { ...querySet, queries: [queries[0]] };
  const relativeCapture = `raw/adzuna-query/nz/data-analyst/${partition}.json`;
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0]));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await commitPaths(root, 'raw');
    await writeJson(capturePath(root), capture(queries[0], { records: [{ id: 'undefined' }] }));
    await git(root, 'add', '--', relativeCapture);
    const original = await run('git', ['show', `HEAD:${relativeCapture}`], { cwd: root });
    assert.equal(original.code, 0, original.stderr);
    await writeFile(capturePath(root), original.stdout, 'utf8');
    assert.match(await git(root, 'status', '--short'), /^MM /m);
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('mutation guard kills removal of the census clean-index precondition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-index-mutant-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0]));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await git(root, 'add', '--', 'raw');
    const result = await runMutatedGate(
      root,
      (source) => source.replace('  await assertCleanIndex(repositoryRoot);\n', ''),
      'remove-clean-index',
    );
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('local mode accepts an internally consistent run without binding it to HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-partial-'));
  try {
    await initRepo(root);
    await writeJson(capturePath(root), capture(queries[0]));
    await writeJson(manifestPath(root), manifest([
      entry(queries[0], 'written'),
      entry(queries[1], 'failed'),
    ]));
    const result = await runGate(root);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      `raw/_manifests/${partition}/run-a-1.json`,
      `raw/adzuna-query/nz/data-analyst/${partition}.json`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, mutate] of [
  ['event name', (run) => { run.event_name = 'workflow_dispatch'; }],
  ['run id', (run) => { run.run_id = 'run-b'; }],
  ['run attempt', (run) => { run.run_attempt = 2; }],
  ['SHA', (run) => { run.sha = '0000000000000000000000000000000000000000'; }],
]) {
  await test(`expected provenance rejects mismatched evidence ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'commit-evidence-expected-mismatch-'));
    const selected = { ...querySet, queries: [queries[0]] };
    try {
      await initRepo(root, selected);
      const expected = { ...provenance, sha: await git(root, 'rev-parse', 'HEAD') };
      const candidate = { ...expected };
      mutate(candidate);
      await writeJson(capturePath(root), capture(queries[0], { run: candidate }));
      await writeJson(
        manifestPath(root, candidate),
        manifest([entry(queries[0], 'written')], { run: candidate }),
      );
      await assertGateRejected(root, expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test('expected provenance accepts evidence bound to this run and repository HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-expected-match-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    const expected = { ...provenance, sha: await git(root, 'rev-parse', 'HEAD') };
    await writeJson(capturePath(root), capture(queries[0], { run: expected }));
    await writeJson(
      manifestPath(root, expected),
      manifest([entry(queries[0], 'written')], { run: expected }),
    );
    const result = await runGate(root, expected);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      `raw/_manifests/${partition}/run-a-1.json`,
      `raw/adzuna-query/nz/data-analyst/${partition}.json`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('expected provenance rejects a claimed SHA that is not repository HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-expected-head-'));
  const selected = { ...querySet, queries: [queries[0]] };
  const claimed = { ...provenance, sha: '0000000000000000000000000000000000000000' };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0], { run: claimed }));
    await writeJson(
      manifestPath(root, claimed),
      manifest([entry(queries[0], 'written')], { run: claimed }),
    );
    await assertGateRejected(root, claimed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a candidate valid-zero final is paired and accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-zero-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0], { records: [] }));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'valid_zero')]));
    assert.equal((await runGate(root)).code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('an all-failed candidate manifest needs no final', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-failed-'));
  try {
    await initRepo(root);
    await writeJson(manifestPath(root), manifest(queries.map((query) => entry(query, 'failed'))));
    const result = await runGate(root);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `raw/_manifests/${partition}/run-a-1.json\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a written manifest entry without its candidate final is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-missing-final-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a skipped entry is accepted only for a final already immutable in HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-skip-'));
  const selected = { ...querySet, queries: [queries[0]] };
  const retry = { ...provenance, run_id: 'run-b' };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0]));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await commitPaths(root, 'raw');
    await writeJson(manifestPath(root, retry), manifest([entry(queries[0], 'skipped')], { run: retry }));
    const result = await runGate(root);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `raw/_manifests/${partition}/run-b-1.json\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('historical manifest evidence cannot pair a new candidate capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-history-mask-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await commitPaths(root, 'raw');
    await writeJson(capturePath(root), capture(queries[0]));
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, mutateManifest] of [
  ['record count', (value) => { value.queries[0].record_count = 2; }],
  ['page requests', (value) => { value.queries[0].page_requests = 2; value.page_requests = 2; }],
  ['status', (value) => { value.queries[0].status = 'valid_zero'; }],
  ['run provenance', (value) => { value.run.run_id = 'run-b'; }],
]) {
  await test(`candidate capture rejects mismatched manifest ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'commit-evidence-mismatch-'));
    const selected = { ...querySet, queries: [queries[0]] };
    try {
      await initRepo(root, selected);
      await writeJson(capturePath(root), capture(queries[0]));
      const value = manifest([entry(queries[0], 'written')]);
      mutateManifest(value);
      const path = label === 'run provenance' ? manifestPath(root, value.run) : manifestPath(root);
      await writeJson(path, value);
      await assertGateRejected(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test('candidate manifests must account for every selected query exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-denominator-'));
  try {
    await initRepo(root);
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'failed')]));
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('modifying an immutable census final is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-modified-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0]));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await commitPaths(root, 'raw');
    await writeJson(capturePath(root), capture(queries[0], { records: [{ id: 'modified' }] }));
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a canonical capture symlink is rejected before target content is read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-capture-link-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    const target = join(root, 'outside-raw', 'capture.json');
    await writeJson(target, capture(queries[0]));
    await mkdir(dirname(capturePath(root)), { recursive: true });
    await symlink(target, capturePath(root));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a canonical manifest symlink is rejected before target content is read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-manifest-link-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0]));
    const target = join(root, 'outside-raw', 'manifest.json');
    await writeJson(target, manifest([entry(queries[0], 'written')]));
    await mkdir(dirname(manifestPath(root)), { recursive: true });
    await symlink(target, manifestPath(root));
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a skipped entry never follows a committed canonical symlink outside raw', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-historical-link-'));
  const selected = { ...querySet, queries: [queries[0]] };
  const retry = { ...provenance, run_id: 'run-b' };
  try {
    await initRepo(root, selected);
    const target = join(root, 'outside-raw', 'historical-capture.json');
    await writeJson(target, capture(queries[0]));
    await mkdir(dirname(capturePath(root)), { recursive: true });
    await symlink(target, capturePath(root));
    await commitPaths(root, 'raw/adzuna-query');
    await writeJson(manifestPath(root, retry), manifest([entry(queries[0], 'skipped')], { run: retry }));
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a candidate reached through a symlinked parent escape is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-parent-link-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    const outside = join(root, 'outside-raw', 'data-analyst');
    await writeJson(join(outside, `${partition}.json`), capture(queries[0]));
    const countryParent = join(root, 'raw', 'adzuna-query', 'nz');
    await mkdir(countryParent, { recursive: true });
    await symlink(outside, join(countryParent, 'data-analyst'), 'dir');
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('mutation guard kills removal of physical candidate validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-link-mutant-'));
  const selected = { ...querySet, queries: [queries[0]] };
  try {
    await initRepo(root, selected);
    const target = join(root, 'outside-raw', 'capture.json');
    await writeJson(target, capture(queries[0]));
    await mkdir(dirname(capturePath(root)), { recursive: true });
    await symlink(target, capturePath(root));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    const result = await runMutatedGate(
      root,
      (source) => source.replace('    await assertPhysicalCandidate(repositoryRoot, path);\n', ''),
      'remove-physical-candidate-check',
    );
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a failed retry cannot contradict a canonical final already immutable in HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-forged-failed-'));
  const selected = { ...querySet, queries: [queries[0]] };
  const retry = { ...provenance, run_id: 'run-b' };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0]));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await commitPaths(root, 'raw');
    await writeJson(manifestPath(root, retry), manifest([entry(queries[0], 'failed')], { run: retry }));
    await assertGateRejected(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('mutation guard kills allowing failed status beside an immutable final', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-failed-mutant-'));
  const selected = { ...querySet, queries: [queries[0]] };
  const retry = { ...provenance, run_id: 'run-b' };
  try {
    await initRepo(root, selected);
    await writeJson(capturePath(root), capture(queries[0]));
    await writeJson(manifestPath(root), manifest([entry(queries[0], 'written')]));
    await commitPaths(root, 'raw');
    await writeJson(manifestPath(root, retry), manifest([entry(queries[0], 'failed')], { run: retry }));
    const result = await runMutatedGate(
      root,
      (source) => source.replace('      } else if (candidate || committed.has(path)) {', '      } else if (candidate) {'),
      'allow-failed-with-committed-final',
    );
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('manifest write failure followed by retry skip cannot retroactively bless the final', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commit-evidence-retry-'));
  const selected = { ...querySet, queries: [queries[0]] };
  const retry = { ...provenance, run_id: 'run-b' };
  const runCensus = (run, overrides = {}) => runQueryCensus({
    rawRoot: root,
    querySet: selected,
    partition,
    provenance: run,
    fetchPage: async () => ({ count: 1, results: [{ id: 'real-runner-record' }] }),
    adapt: (record) => record,
    requiredFields: ['id'],
    validateCapture: async () => ({ ok: true, problems: [], notes: [] }),
    now: () => new Date('2026-08-10T00:00:00.000Z'),
    ...overrides,
  });
  try {
    await initRepo(root, selected);
    await assert.rejects(
      runCensus(provenance, { manifestOpen: openThenRejectWrite }),
      /injected manifest write failure/,
    );
    assert.equal(await access(capturePath(root)).then(() => true, () => false), true);
    assert.equal(await access(manifestPath(root)).then(() => true, () => false), false);
    let retryFetches = 0;
    const retryResult = await runQueryCensus({
      rawRoot: root,
      querySet: selected,
      partition,
      provenance: retry,
      fetchPage: async () => { retryFetches += 1; throw new Error('must skip'); },
      adapt: (record) => record,
      requiredFields: ['id'],
      validateCapture: async () => ({ ok: true, problems: [], notes: [] }),
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    });
    assert.deepEqual({ retryFetches, skipped: retryResult.skipped }, { retryFetches: 0, skipped: 1 });
    await assertGateRejected(root);
    assert.equal(await readFile(capturePath(root), 'utf8').then((body) => JSON.parse(body).run_id), 'run-a');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

finish();

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChecker } from './lib/verify.mjs';
import { listBroadCaptures } from './lib/raw-capture-discovery.mjs';
import { validateManifestEvidence } from './lib/capture-manifest.mjs';
import { buildCoverage } from './lib/query-coverage.mjs';

const { check, finish } = createChecker('verify-query-status');
const partition = '2026-08-10';
const querySet = {
  id: 'nz-ai-data-v1',
  country: 'nz',
  effective_from: partition,
  results_per_page: 50,
  daily_page_budget: 60,
  queries: Array.from({ length: 10 }, (_, index) => ({
    id: `query-${index + 1}`,
    text: `query ${index + 1}`,
    role_family: 'test',
  })),
};

async function test(name, action) {
  try {
    await action();
    check(name, true);
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : String(error));
  }
}

function capture(query, records, options = {}) {
  const validZero = options.validZero ?? false;
  return {
    source: 'adzuna',
    coverage_mode: 'query_census',
    country: options.country ?? 'nz',
    partition: options.partition ?? partition,
    fetched_at: '2026-08-10T00:00:00.000Z',
    event_name: 'test',
    run_id: options.runId ?? 'run-a',
    run_attempt: options.runAttempt ?? 1,
    sha: 'abcdef0',
    query_set: options.querySet ?? querySet.id,
    query: {
      id: options.queryId ?? query.id,
      text: query.text,
      role_family: query.role_family,
    },
    count: records.length,
    meta: {
      reported_total: validZero ? 0 : records.length,
      pages_fetched: validZero ? 1 : 1,
      results_per_page: 50,
      termination: validZero ? 'valid_zero' : 'short_page',
    },
    records,
  };
}

function manifest(entries, options = {}) {
  return {
    schema_version: 1,
    collector: 'adzuna-query-census',
    partition: options.partition ?? partition,
    query_set: options.querySet ?? querySet.id,
    run: {
      event_name: 'test',
      run_id: options.runId ?? 'run-a',
      run_attempt: options.runAttempt ?? 1,
      sha: 'abcdef0',
    },
    started_at: '2026-08-10T00:00:00.000Z',
    finished_at: '2026-08-10T00:01:00.000Z',
    page_requests: entries.length,
    daily_page_budget: 60,
    queries: entries.map(([query, status, recordCount = null]) => ({
      query_id: query.id,
      status,
      page_requests: 1,
      record_count: recordCount,
      error_code: status === 'failed' ? 'http_error' : null,
    })),
  };
}

function summary(model) {
  return {
    expected: model.expected,
    complete: model.complete,
    failed: model.failed,
    missing: model.missing,
    comparable: model.comparable,
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runChild(script, options) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [script, ...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

async function mutatedCoverage(mutator, label) {
  const original = await readFile(resolve('scripts/lib/query-coverage.mjs'), 'utf8');
  const changed = mutator(original);
  assert.notEqual(changed, original, `${label} mutation target missing`);
  const withDependency = changed.replace(
    "from './capture-manifest.mjs'",
    `from '${pathToFileURL(resolve('scripts/lib/capture-manifest.mjs')).href}'`,
  );
  return import(`data:text/javascript,${encodeURIComponent(withDependency)}#${label}-${Date.now()}`);
}

async function mutatedReportOutput(mutator, label) {
  const root = await mkdtemp(join(tmpdir(), 'query-status-report-mutant-'));
  try {
    const original = await readFile(resolve('scripts/report.mjs'), 'utf8');
    const changed = mutator(original);
    assert.notEqual(changed, original, `${label} mutation target missing`);
    const withDependency = changed.replace(
      "from './lib/raw-capture-discovery.mjs'",
      `from '${pathToFileURL(resolve('scripts/lib/raw-capture-discovery.mjs')).href}'`,
    );
    const script = join(root, 'mutant-report.mjs');
    await writeFile(script, withDependency, 'utf8');
    await writeJson(join(root, 'raw', 'adzuna', 'nz', `${partition}.json`), { count: 0, records: [] });
    return await runChild(script, { cwd: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mutatedStatusOutput(root, mutator, label, args = []) {
  const original = await readFile(resolve('scripts/query-census-status.mjs'), 'utf8');
  const changed = mutator(original);
  assert.notEqual(changed, original, `${label} mutation target missing`);
  const withDependencies = changed
    .replace(
      "from './lib/capture-manifest.mjs'",
      `from '${pathToFileURL(resolve('scripts/lib/capture-manifest.mjs')).href}'`,
    )
    .replace(
      "from './lib/query-set.mjs'",
      `from '${pathToFileURL(resolve('scripts/lib/query-set.mjs')).href}'`,
    )
    .replace(
      "from './lib/query-coverage.mjs'",
      `from '${pathToFileURL(resolve('scripts/lib/query-coverage.mjs')).href}'`,
    );
  const script = join(root, `mutant-status-${label}.mjs`);
  await writeFile(script, withDependencies, 'utf8');
  return runChild(script, { cwd: root, args });
}

function coverageForRecords(build, records) {
  const query = querySet.queries[0];
  return build({
    querySet: { ...querySet, queries: [query] },
    partition,
    captures: [capture(query, records)],
    manifests: [manifest([[query, 'written', records.length]])],
  });
}

const completeQueries = querySet.queries.slice(0, 7);
const validZeroQuery = querySet.queries[7];
const failedQuery = querySet.queries[8];

await test('coverage distinguishes complete, failed, and absent expected queries', () => {
  const captures = completeQueries.map((query) => capture(query, [{ id: query.id }]))
    .concat(capture(validZeroQuery, [], { validZero: true }));
  const model = buildCoverage({
    querySet,
    partition,
    captures,
    manifests: [manifest([
      ...completeQueries.map((query) => [query, 'written', 1]),
      [validZeroQuery, 'valid_zero', 0],
      [failedQuery, 'failed'],
    ])],
  });
  assert.deepEqual(summary(model), {
    expected: 10,
    complete: 8,
    failed: 1,
    missing: 1,
    comparable: false,
  });
});

await test('coverage counts records and deduplicates Adzuna ids across complete queries', () => {
  const queries = querySet.queries.slice(0, 4);
  const model = buildCoverage({
    querySet: { ...querySet, queries },
    partition,
    captures: [
      capture(queries[0], [{ id: 'a' }, { id: 'b' }]),
      capture(queries[1], [{ id: 'b' }]),
      capture(queries[2], [{ id: 'c' }]),
      capture(queries[3], [], { validZero: true }),
    ],
    manifests: [manifest([
      [queries[0], 'written', 2],
      [queries[1], 'written', 1],
      [queries[2], 'written', 1],
      [queries[3], 'valid_zero', 0],
    ])],
  });
  assert.deepEqual({
    observations: model.observations,
    distinct_ads: model.distinct_ads,
    overlap_rate: model.overlap_rate,
    complete: model.complete,
    missing: model.missing,
  }, {
    observations: 4,
    distinct_ads: 3,
    overlap_rate: 0.25,
    complete: 4,
    missing: 0,
  });
});

await test('a manifest-only valid zero stays missing rather than becoming zero observations', () => {
  const query = querySet.queries[0];
  const model = buildCoverage({
    querySet: { ...querySet, queries: [query] },
    partition,
    captures: [],
    manifests: [manifest([[query, 'valid_zero', 0]])],
  });
  assert.deepEqual(summary(model), {
    expected: 1,
    complete: 0,
    failed: 0,
    missing: 1,
    comparable: false,
  });
});

await test('a failed manifest entry is failed and not missing', () => {
  const query = querySet.queries[0];
  const model = buildCoverage({
    querySet: { ...querySet, queries: [query] },
    partition,
    captures: [],
    manifests: [manifest([[query, 'failed']])],
  });
  assert.deepEqual(summary(model), {
    expected: 1,
    complete: 0,
    failed: 1,
    missing: 0,
    comparable: false,
  });
});

await test('a fully evidenced query set is comparable with zero-safe overlap', () => {
  const queries = querySet.queries.slice(0, 2);
  const model = buildCoverage({
    querySet: { ...querySet, queries },
    partition,
    captures: queries.map((query) => capture(query, [], { validZero: true })),
    manifests: [manifest(queries.map((query) => [query, 'valid_zero', 0]))],
  });
  assert.deepEqual({ ...summary(model), observations: model.observations, overlap_rate: model.overlap_rate }, {
    expected: 2,
    complete: 2,
    failed: 0,
    missing: 0,
    comparable: true,
    observations: 0,
    overlap_rate: 0,
  });
});

await test('a final valid capture wins over an earlier failed manifest without double-counting', () => {
  const query = querySet.queries[0];
  const model = buildCoverage({
    querySet: { ...querySet, queries: [query] },
    partition,
    captures: [capture(query, [{ id: 'one' }], { runId: 'final', runAttempt: 2 })],
    manifests: [
      manifest([[query, 'failed']], { runId: 'first', runAttempt: 1 }),
      manifest([[query, 'written', 1]], { runId: 'final', runAttempt: 2 }),
    ],
  });
  assert.deepEqual({ ...summary(model), observations: model.observations }, {
    expected: 1,
    complete: 1,
    failed: 0,
    missing: 0,
    comparable: true,
    observations: 1,
  });
});

await test('mismatched capture evidence fails closed instead of completing the query', () => {
  const query = querySet.queries[0];
  const model = buildCoverage({
    querySet: { ...querySet, queries: [query] },
    partition,
    captures: [capture(query, [{ id: 'one' }], { partition: '2026-08-09' })],
    manifests: [manifest([[query, 'written', 1]])],
  });
  assert.deepEqual(summary(model), {
    expected: 1,
    complete: 0,
    failed: 1,
    missing: 0,
    comparable: false,
  });
});

await test('a capture whose payload query disagrees with its active path fails closed', () => {
  const [expected, claimed] = querySet.queries;
  const model = buildCoverage({
    querySet: { ...querySet, queries: [expected] },
    partition,
    captures: [{ expectedQueryId: expected.id, data: capture(claimed, [{ id: 'one' }]) }],
    manifests: [manifest([[expected, 'written', 1]])],
  });
  assert.deepEqual(summary(model), {
    expected: 1,
    complete: 0,
    failed: 1,
    missing: 0,
    comparable: false,
  });
});

await test('a non-empty capture claiming valid-zero evidence fails closed', () => {
  const query = querySet.queries[0];
  const malformed = capture(query, [{ id: 'one' }], { validZero: true });
  const model = buildCoverage({
    querySet: { ...querySet, queries: [query] },
    partition,
    captures: [malformed],
    manifests: [manifest([[query, 'written', 1]])],
  });
  assert.deepEqual(summary(model), {
    expected: 1,
    complete: 0,
    failed: 1,
    missing: 0,
    comparable: false,
  });
});

await test('a manifest with malformed final metadata fails closed despite a capture', () => {
  const query = querySet.queries[0];
  const malformed = manifest([[query, 'written', 1]]);
  malformed.finished_at = 'not-a-timestamp';
  const model = buildCoverage({
    querySet: { ...querySet, queries: [query] },
    partition,
    captures: [capture(query, [{ id: 'one' }])],
    manifests: [malformed],
  });
  assert.deepEqual(summary(model), {
    expected: 1,
    complete: 0,
    failed: 1,
    missing: 0,
    comparable: false,
  });
});

await test('multiple attempted captures resolve to one deterministic final observation', () => {
  const query = querySet.queries[0];
  const model = buildCoverage({
    querySet: { ...querySet, queries: [query] },
    partition,
    captures: [
      capture(query, [{ id: 'first' }], { runId: 'first', runAttempt: 1 }),
      capture(query, [{ id: 'final' }], { runId: 'final', runAttempt: 2 }),
    ],
    manifests: [manifest([[query, 'written', 1]], { runId: 'final', runAttempt: 2 })],
  });
  assert.deepEqual({ ...summary(model), observations: model.observations, distinct_ads: model.distinct_ads }, {
    expected: 1,
    complete: 1,
    failed: 0,
    missing: 0,
    comparable: true,
    observations: 1,
    distinct_ads: 1,
  });
});

await test('broad discovery includes only exact source/country/partition JSON files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-discovery-'));
  try {
    await writeJson(join(root, 'raw', 'adzuna', 'nz', `${partition}.json`), { count: 0, records: [] });
    await writeJson(join(root, 'raw', 'adzuna-query', 'nz', 'data-analyst', `${partition}.json`), capture(querySet.queries[0], []));
    await writeJson(join(root, 'raw', 'adzuna-query', 'nz', `${partition}.json`), { count: 0, records: [] });
    await writeJson(join(root, 'raw', '_manifests', partition, 'run-a-1.json'), manifest([]));
    await writeJson(join(root, 'raw', 'adzuna', 'nz', 'nested', `${partition}.json`), { count: 0 });
    await writeJson(join(root, 'raw', 'adzuna', 'nz', 'not-json.txt'), { count: 0 });
    assert.deepEqual(await listBroadCaptures(root), [{
      source: 'adzuna',
      country: 'nz',
      partition,
      path: join(root, 'raw', 'adzuna', 'nz', `${partition}.json`),
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeCensusFixture(root, { complete = false } = {}) {
  await writeJson(join(root, 'config', 'query-sets', `${querySet.id}.json`), querySet);
  const captures = completeQueries.map((query) => capture(query, [{ id: query.id }]))
    .concat(capture(validZeroQuery, [], { validZero: true }));
  for (const value of captures) {
    await writeJson(join(root, 'raw', 'adzuna-query', 'nz', value.query.id, `${partition}.json`), value);
  }
  const entries = complete
    ? querySet.queries.map((query) => [query, query === validZeroQuery ? 'valid_zero' : 'written', query === validZeroQuery ? 0 : 1])
    : [
      ...completeQueries.map((query) => [query, 'written', 1]),
      [validZeroQuery, 'valid_zero', 0],
      [failedQuery, 'failed'],
    ];
  if (complete) {
    for (const query of querySet.queries.filter((query) => !captures.some((value) => value.query.id === query.id))) {
      await writeJson(join(root, 'raw', 'adzuna-query', 'nz', query.id, `${partition}.json`), capture(query, [{ id: query.id }]));
    }
  }
  await writeJson(join(root, 'raw', '_manifests', partition, 'run-a-1.json'), manifest(entries));
}

await test('CLI reports the active denominator and exits one for failed or missing data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-'));
  try {
    await writeCensusFixture(root);
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.deepEqual(result, {
      code: 1,
      stdout: 'NZ AI/data query census — 2026-08-10 — nz-ai-data-v1\nqueries: 10 expected, 8 complete, 1 failed, 1 missing\nrecords: 7 observations, 7 distinct Adzuna ids, 0.0% overlap\nstatus: INCOMPLETE — not eligible for comparison\n',
      stderr: '',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI defaults to the latest real partition and exits zero only when complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-complete-'));
  try {
    await writeCensusFixture(root, { complete: true });
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root });
    assert.deepEqual(result, {
      code: 0,
      stdout: 'NZ AI/data query census — 2026-08-10 — nz-ai-data-v1\nqueries: 10 expected, 10 complete, 0 failed, 0 missing\nrecords: 9 observations, 9 distinct Adzuna ids, 0.0% overlap\nstatus: COMPLETE — eligible for comparison\n',
      stderr: '',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI fails closed on malformed capture evidence outside active query paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-active-paths-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeFile(join(root, 'raw', 'adzuna-query', 'nz', 'not-active', `${partition}.json`), '{', 'utf8').catch(async () => {
      await mkdir(join(root, 'raw', 'adzuna-query', 'nz', 'not-active'), { recursive: true });
      await writeFile(join(root, 'raw', 'adzuna-query', 'nz', 'not-active', `${partition}.json`), '{', 'utf8');
    });
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI fails closed on schema-invalid capture evidence outside active query paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-semantic-invalid-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeJson(join(root, 'raw', 'adzuna-query', 'nz', 'not-active', `${partition}.json`), {
      source: 'adzuna',
      coverage_mode: 'query_census',
      country: 'nz',
      partition,
      query_set: querySet.id,
      query: { id: 'not-active', text: 'not active', role_family: 'other' },
      records: [],
    });
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI fails closed on capture evidence stored under the wrong query path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-path-mismatch-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeJson(
      join(root, 'raw', 'adzuna-query', 'nz', 'not-active', `${partition}.json`),
      capture(querySet.queries[0], [{ id: 'path-mismatch-ad' }]),
    );
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI fails closed on a date-shaped non-file census artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-non-file-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await mkdir(join(root, 'raw', 'adzuna-query', 'nz', 'not-active', `${partition}.json`), { recursive: true });
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI attributes a malformed copy-prefixed artifact to its filename partition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-copy-date-'));
  try {
    await writeCensusFixture(root, { complete: true });
    const directory = join(root, 'raw', 'adzuna-query', 'nz', 'not-active');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `copy-${partition}.json`), '{', 'utf8');
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI attributes a bad-prefixed directory to its path partition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-bad-date-directory-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await mkdir(join(root, 'raw', 'adzuna-query', 'nz', 'not-active', `bad-${partition}`), { recursive: true });
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI does not let a copy-prefixed artifact from another date poison the selected partition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-copy-other-date-'));
  try {
    await writeCensusFixture(root, { complete: true });
    const directory = join(root, 'raw', 'adzuna-query', 'nz', 'not-active');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'copy-2026-08-09.json'), '{', 'utf8');
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /status: COMPLETE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI fails closed for every distinct date token in one artifact path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-multiple-date-tokens-'));
  try {
    await writeCensusFixture(root, { complete: true });
    const directory = join(root, 'raw', 'adzuna-query', 'nz', 'copy-2026-08-12');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `bad-${partition}.json`), '{', 'utf8');
    for (const selected of ['2026-08-12', partition]) {
      const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [selected] });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /invalid query-census evidence/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI cannot attribute unreadable undated artifacts and leaves dated evidence isolated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-undated-boundary-'));
  try {
    await writeCensusFixture(root, { complete: true });
    const directory = join(root, 'raw', 'adzuna-query', 'nz', 'not-active');
    await mkdir(join(directory, 'bad-copy'), { recursive: true });
    await writeFile(join(directory, 'copy.json'), '{', 'utf8');
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /status: COMPLETE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('mutation guard kills restoring basename-leading date discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-date-token-mutant-'));
  try {
    await writeCensusFixture(root, { complete: true });
    const directory = join(root, 'raw', 'adzuna-query', 'nz', 'not-active');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `copy-${partition}.json`), '{', 'utf8');
    const result = await mutatedStatusOutput(root, (source) => {
      const target = 'for (const partition of partitions) {';
      const replacement = "for (const partition of new Set([/^(\\d{4}-\\d{2}-\\d{2})(?:\\..*)?$/.exec(entry.name)?.[1], embeddedPartition].filter(Boolean))) {";
      const changed = source.replace(target, replacement);
      assert.notEqual(changed, source, 'relative-path date-token mutation target missing');
      return changed;
    }, 'restore-leading-date-discovery', [partition]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /queries: 10 expected, 10 complete, 0 failed, 0 missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI ignores invalid extra census evidence from an unrelated partition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-unrelated-invalid-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeJson(join(root, 'raw', 'adzuna-query', 'nz', 'not-active', '2026-08-09.json'), {
      partition: '2026-08-09',
      query_set: querySet.id,
    });
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /status: COMPLETE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('mutation guard kills removal of capture semantic and path validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-semantic-mutant-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeJson(
      join(root, 'raw', 'adzuna-query', 'nz', 'not-active', `${partition}.json`),
      capture(querySet.queries[0], [{ id: 'path-mismatch-ad' }]),
    );
    const result = await mutatedStatusOutput(root, (source) => {
      const target = 'if (!validCaptureAtPath(parsed.data, querySetsById, country, queryId, partition)) {';
      const changed = source.replace(target, 'if (!parsed.data || typeof parsed.data.query_set !== \'string\') {');
      assert.notEqual(changed, source, 'capture semantic/path validation mutation target missing');
      return changed;
    }, 'ignore-capture-semantics', [partition]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /queries: 10 expected, 10 complete, 0 failed, 0 missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('mutation guard kills removal of the malformed-evidence fail-closed check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-cli-invalid-mutant-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await mkdir(join(root, 'raw', 'adzuna-query', 'nz', 'not-active'), { recursive: true });
    await writeFile(join(root, 'raw', 'adzuna-query', 'nz', 'not-active', `${partition}.json`), '{', 'utf8');
    const result = await mutatedStatusOutput(root, (source) => {
      const target = 'if (state.invalid) throw new Error(`invalid query-census evidence for ${partition}`);';
      const changed = source.replace(target, '');
      assert.notEqual(changed, source, 'invalid evidence mutation target missing');
      return changed;
    }, 'ignore-invalid-evidence', [partition]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /queries: 10 expected, 10 complete, 0 failed, 0 missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI does not invent a partition or zero counts when no query captures exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-empty-'));
  try {
    await writeJson(join(root, 'config', 'query-sets', `${querySet.id}.json`), querySet);
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root });
    assert.deepEqual(result, { code: 1, stdout: '', stderr: 'no query-census partition found\n' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('legacy report ignores nested census captures and uses the mandated disclaimer heading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-report-'));
  try {
    await writeJson(join(root, 'raw', 'adzuna', 'nz', `${partition}.json`), { count: 0, records: [] });
    await writeJson(join(root, 'raw', 'adzuna-query', 'nz', 'data-analyst', `${partition}.json`), capture(querySet.queries[0], []));
    const result = await runChild(resolve('scripts/report.mjs'), { cwd: root });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], 'BROAD RANKED WINDOW — exploratory composition only; not a market census; no churn or lifespan claims');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const literal of ['undefined', 'null']) {
  await test(`coverage rejects literal ${literal} Adzuna ids`, () => {
    const model = coverageForRecords(buildCoverage, [{ id: literal }]);
    assert.deepEqual(summary(model), {
      expected: 1,
      complete: 0,
      failed: 1,
      missing: 0,
      comparable: false,
    });
  });
}

await test('coverage rejects a ten-record Adzuna identity collapse', () => {
  const model = coverageForRecords(buildCoverage, Array.from({ length: 10 }, () => ({ id: 'same-ad' })));
  assert.equal(model.failed, 1);
  assert.equal(model.complete, 0);
});

await test('coverage tolerates ten records with six distinct Adzuna ids', () => {
  const ids = ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd', 'e', 'f'];
  const model = coverageForRecords(buildCoverage, ids.map((id) => ({ id })));
  assert.deepEqual({ complete: model.complete, failed: model.failed, distinct_ads: model.distinct_ads }, {
    complete: 1,
    failed: 0,
    distinct_ads: 6,
  });
});

for (const literal of ['undefined', 'null']) {
  await test(`mutation guard kills removal of the ${literal} literal-id check`, async () => {
    const mutant = await mutatedCoverage(
      (source) => source.replace(` && normalized !== '${literal}'`, ''),
      `remove-${literal}`,
    );
    const model = coverageForRecords(mutant.buildCoverage, [{ id: literal }]);
    assert.equal(model.complete, 1);
  });
}

await test('mutation guard kills weakening the identity-collapse threshold', async () => {
  const mutant = await mutatedCoverage(
    (source) => source.replace('value.records.length >= 10 && distinct <= value.records.length / 2', 'value.records.length >= 11 && distinct <= value.records.length / 2'),
    'weaken-collapse',
  );
  const model = coverageForRecords(mutant.buildCoverage, Array.from({ length: 10 }, () => ({ id: 'same-ad' })));
  assert.equal(model.complete, 1);
});

for (const [label, mutation] of [
  ['leading newline', (source) => source.replace("console.log('BROAD RANKED WINDOW", "console.log('\\nBROAD RANKED WINDOW")],
  ['indent', (source) => source.replace("console.log('BROAD RANKED WINDOW", "console.log('  BROAD RANKED WINDOW")],
]) {
  await test(`mutation guard kills legacy report ${label}`, async () => {
    const result = await mutatedReportOutput(mutation, label.replaceAll(' ', '-'));
    assert.equal(result.code, 0, result.stderr);
    assert.notEqual(result.stdout.split('\n')[0], 'BROAD RANKED WINDOW — exploratory composition only; not a market census; no churn or lifespan claims');
  });
}

await test('canonical manifest evidence export preserves validated run, status, page, and record fields', () => {
  const evidence = manifest([[querySet.queries[0], 'written', 1]]);
  assert.deepEqual(validateManifestEvidence(evidence), evidence);
});

for (const [label, mutate] of [
  ['wrong results_per_page', (value) => { value.meta.results_per_page = 25; }],
  ['unsupported successful termination', (value) => { value.meta.termination = 'budget_limit'; }],
  ['nonzero capture with reported_total below count', (value) => { value.meta.reported_total = 0; }],
  ['nonzero capture with reported_total above count', (value) => { value.meta.reported_total = 2; }],
  ['short_page with a full final page', (value) => {
    value.records = Array.from({ length: 50 }, (_, index) => ({ id: `full-${index}` }));
    value.count = 50;
    value.meta.reported_total = 50;
    value.meta.pages_fetched = 1;
  }],
  ['empty_page with an implausible page count', (value) => {
    value.records = Array.from({ length: 50 }, (_, index) => ({ id: `empty-${index}` }));
    value.count = 50;
    value.meta.reported_total = 50;
    value.meta.termination = 'empty_page';
    value.meta.pages_fetched = 1;
  }],
  ['unsafe event_name provenance', (value) => { value.event_name = ' '; }],
  ['unsafe run_id provenance', (value) => { value.run_id = ' '; }],
  ['invalid run_attempt provenance', (value) => { value.run_attempt = 0; }],
  ['unsafe sha provenance', (value) => { value.sha = 'NOT-A-SHA'; }],
  ['non-finite numeric Adzuna id', (value) => { value.records[0].id = Number.NaN; }],
  ['blank string Adzuna id', (value) => { value.records[0].id = '   '; }],
]) {
  await test(`producer contract rejects ${label}`, () => {
    const query = querySet.queries[0];
    const value = capture(query, [{ id: 'one' }]);
    mutate(value);
    const matching = manifest([[query, 'written', value.count]], { runId: value.run_id, runAttempt: value.run_attempt });
    const model = buildCoverage({
      querySet: { ...querySet, queries: [query] },
      partition,
      captures: [value],
      manifests: [matching],
    });
    assert.deepEqual(summary(model), {
      expected: 1,
      complete: 0,
      failed: 1,
      missing: 0,
      comparable: false,
    });
  });
}

for (const [label, mutate] of [
  ['valid-zero with pages_fetched other than one', (value) => { value.meta.pages_fetched = 2; }],
  ['valid-zero with non-empty records', (value) => {
    value.records = [{ id: 'one' }];
    value.count = 1;
  }],
  ['valid-zero with nonzero reported_total', (value) => { value.meta.reported_total = 1; }],
]) {
  await test(`producer contract rejects ${label}`, () => {
    const query = querySet.queries[0];
    const value = capture(query, [], { validZero: true });
    mutate(value);
    const matching = manifest([[query, 'valid_zero', 0]]);
    const model = buildCoverage({
      querySet: { ...querySet, queries: [query] },
      partition,
      captures: [value],
      manifests: [matching],
    });
    assert.equal(model.failed, 1);
    assert.equal(model.complete, 0);
  });
}

for (const [label, makeManifest] of [
  ['empty matching run', (query) => manifest([])],
  ['mismatched matching-run record_count', (query) => manifest([[query, 'written', 2]])],
  ['mismatched matching-run status', (query) => manifest([[query, 'valid_zero', 0]])],
  ['mismatched matching-run provenance', (query) => manifest([[query, 'written', 1]], { runId: 'other' })],
]) {
  await test(`capture correlation rejects ${label}`, () => {
    const query = querySet.queries[0];
    const model = buildCoverage({
      querySet: { ...querySet, queries: [query] },
      partition,
      captures: [capture(query, [{ id: 'one' }])],
      manifests: [makeManifest(query)],
    });
    assert.deepEqual(summary(model), {
      expected: 1,
      complete: 0,
      failed: 1,
      missing: 0,
      comparable: false,
    });
  });
}

await test('capture correlation requires manifest page_requests to agree with successful pages', () => {
  const query = querySet.queries[0];
  const value = capture(query, Array.from({ length: 51 }, (_, index) => ({ id: `page-${index}` })));
  value.count = 51;
  value.meta.reported_total = 51;
  value.meta.pages_fetched = 2;
  const evidence = manifest([[query, 'written', 51]]);
  evidence.queries[0].page_requests = 1;
  const model = buildCoverage({
    querySet: { ...querySet, queries: [query] },
    partition,
    captures: [value],
    manifests: [evidence],
  });
  assert.equal(model.failed, 1);
});

for (const label of ['unknown query id', 'duplicate query entries']) {
  await test(`active manifest rejects ${label}`, () => {
    const query = querySet.queries[0];
    const evidence = manifest([[query, 'written', 1]]);
    if (label === 'unknown query id') evidence.queries[0].query_id = 'not-active';
    else {
      evidence.queries.push(structuredClone(evidence.queries[0]));
      evidence.page_requests += 1;
    }
    const model = buildCoverage({
      querySet: { ...querySet, queries: [query] },
      partition,
      captures: [capture(query, [{ id: 'one' }])],
      manifests: [evidence],
    });
    assert.equal(model.failed, 1);
    assert.equal(model.complete, 0);
  });
}

await test('latest evidence uses its recorded query-set version across a transition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-transition-'));
  try {
    const oldQuery = { id: 'old-query', text: 'old query', role_family: 'test' };
    const newQuery = { id: 'new-query', text: 'new query', role_family: 'test' };
    const oldSet = { ...querySet, id: 'nz-ai-data-v1', effective_from: '2026-08-10', queries: [oldQuery] };
    const newSet = { ...querySet, id: 'nz-ai-data-v2', effective_from: '2026-08-11', queries: [newQuery] };
    await writeJson(join(root, 'config', 'query-sets', 'old.json'), oldSet);
    await writeJson(join(root, 'config', 'query-sets', 'new.json'), newSet);
    await writeJson(join(root, 'raw', 'adzuna-query', 'nz', oldQuery.id, '2026-08-12.json'), capture(oldQuery, [{ id: 'old' }], {
      partition: '2026-08-12', querySet: oldSet.id,
    }));
    await writeJson(join(root, 'raw', '_manifests', '2026-08-12', 'run-a-1.json'), manifest([[oldQuery, 'written', 1]], {
      partition: '2026-08-12', querySet: oldSet.id,
    }));
    await writeJson(join(root, 'raw', '_manifests', '2026-08-11', 'run-a-1.json'), manifest([[newQuery, 'failed']], {
      partition: '2026-08-11', querySet: newSet.id,
    }));
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^NZ AI\/data query census — 2026-08-12 — nz-ai-data-v1/m);
    assert.match(result.stdout, /queries: 1 expected, 1 complete, 0 failed, 0 missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI rejects conflicting query-set ids recorded on one evidence date', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-inactive-manifest-'));
  try {
    await writeCensusFixture(root, { complete: true });
    const inactiveQuery = { id: 'future-query', text: 'future query', role_family: 'test' };
    const inactiveSet = { ...querySet, id: 'nz-ai-data-v2', effective_from: '2026-08-11', queries: [inactiveQuery] };
    await writeJson(join(root, 'config', 'query-sets', 'future.json'), inactiveSet);
    await writeJson(join(root, 'raw', '_manifests', partition, 'inactive-1.json'), manifest([[inactiveQuery, 'failed']], {
      querySet: inactiveSet.id,
      runId: 'inactive',
    }));
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ambiguous query-set evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('backdated config cannot rewrite a historical evidence denominator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-backdated-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeJson(join(root, 'config', 'query-sets', `${querySet.id}.json`), {
      ...querySet,
      effective_from: '2026-08-01',
    });
    await writeJson(join(root, 'config', 'query-sets', 'backdated.json'), {
      ...querySet,
      id: 'nz-ai-data-v2',
      effective_from: '2026-08-05',
      queries: [{ id: 'replacement', text: 'replacement', role_family: 'test' }],
    });
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^NZ AI\/data query census — 2026-08-10 — nz-ai-data-v1/m);
    assert.match(result.stdout, /queries: 10 expected, 10 complete, 0 failed, 0 missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('mutation guard kills chronology-first selection on evidence-bearing dates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-backdated-mutant-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeJson(join(root, 'config', 'query-sets', `${querySet.id}.json`), {
      ...querySet,
      effective_from: '2026-08-01',
    });
    await writeJson(join(root, 'config', 'query-sets', 'backdated.json'), {
      ...querySet,
      id: 'nz-ai-data-v2',
      effective_from: '2026-08-05',
      queries: [{ id: 'replacement', text: 'replacement', role_family: 'test' }],
    });
    const result = await mutatedStatusOutput(
      root,
      (source) => source.replace(
        'const querySet = querySetForEvidence(querySets, partition, evidenceIndex.get(partition));',
        'const querySet = activeQuerySet(querySets, partition);',
      ),
      'chronology-first',
      [partition],
    );
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^NZ AI\/data query census — 2026-08-10 — nz-ai-data-v2/m);
    assert.match(result.stdout, /queries: 1 expected, 0 complete, 0 failed, 1 missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, conflicting] of [
  ['duplicate query-set ids', { ...querySet, effective_from: '2026-08-11' }],
  ['duplicate effective_from dates', { ...querySet, id: 'nz-ai-data-v2' }],
]) {
  await test(`CLI rejects ${label} across config files`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'query-status-duplicate-config-'));
    try {
      await writeCensusFixture(root, { complete: true });
      await writeJson(join(root, 'config', 'query-sets', 'conflicting.json'), conflicting);
      const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /duplicate (query-set id|effective_from)/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test('CLI fails closed on an attributed manifest from a foreign collector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-foreign-manifest-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeJson(join(root, 'raw', '_manifests', partition, 'foreign-1.json'), {
      collector: 'other-collector',
      query_set: querySet.id,
      partition,
      detail: 'not query-census evidence',
    });
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI rejects a canonical manifest filename that disagrees with embedded run identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-manifest-filename-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeJson(
      join(root, 'raw', '_manifests', partition, 'path-run-1.json'),
      manifest([], { runId: 'embedded-run' }),
    );
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI attributes a malformed noncanonical manifest path by its date token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-manifest-path-date-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await mkdir(join(root, 'raw', '_manifests'), { recursive: true });
    await writeFile(join(root, 'raw', '_manifests', `copy-${partition}.json`), '{', 'utf8');
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI attributes embedded manifest partition evidence outside the canonical layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-manifest-embedded-partition-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await writeJson(
      join(root, 'raw', '_manifests', 'archive', 'outside-1.json'),
      manifest([], { runId: 'outside' }),
    );
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI attributes a non-file manifest artifact by its path date token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-manifest-non-file-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await mkdir(join(root, 'raw', '_manifests', `bad-${partition}`), { recursive: true });
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI isolates a malformed manifest artifact containing only another date', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-manifest-other-date-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await mkdir(join(root, 'raw', '_manifests'), { recursive: true });
    await writeFile(join(root, 'raw', '_manifests', 'copy-2026-08-09.json'), '{', 'utf8');
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /status: COMPLETE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI fails closed for every distinct date token in one manifest path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-manifest-multiple-dates-'));
  try {
    await writeCensusFixture(root, { complete: true });
    const directory = join(root, 'raw', '_manifests', 'copy-2026-08-12');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `bad-${partition}.json`), '{', 'utf8');
    for (const selected of ['2026-08-12', partition]) {
      const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [selected] });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /invalid query-census evidence/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI cannot attribute unreadable undated manifest artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-manifest-undated-boundary-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await mkdir(join(root, 'raw', '_manifests', 'bad-copy'), { recursive: true });
    await writeFile(join(root, 'raw', '_manifests', 'copy.json'), '{', 'utf8');
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root, args: [partition] });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /status: COMPLETE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('mutation guard kills removal of recursive manifest indexing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-manifest-index-mutant-'));
  try {
    await writeCensusFixture(root, { complete: true });
    await mkdir(join(root, 'raw', '_manifests'), { recursive: true });
    await writeFile(join(root, 'raw', '_manifests', `copy-${partition}.json`), '{', 'utf8');
    const result = await mutatedStatusOutput(root, (source) => {
      const target = 'await indexManifestEvidence(root, index);';
      const changed = source.replace(target, '');
      assert.notEqual(changed, source, 'recursive manifest index mutation target missing');
      return changed;
    }, 'remove-manifest-index', [partition]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /queries: 10 expected, 10 complete, 0 failed, 0 missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('malformed evidence without a query-set identity is rejected before coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'query-status-malformed-manifest-'));
  try {
    await writeJson(join(root, 'config', 'query-sets', `${querySet.id}.json`), querySet);
    await mkdir(join(root, 'raw', '_manifests', '2026-08-11'), { recursive: true });
    await writeFile(join(root, 'raw', '_manifests', '2026-08-11', 'bad.json'), '{', 'utf8');
    const result = await runChild(resolve('scripts/query-census-status.mjs'), { cwd: root });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid query-census evidence/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('coverage module stays pure: importing it declares no filesystem dependency', async () => {
  const source = await readFile(resolve('scripts/lib/query-coverage.mjs'), 'utf8');
  assert.doesNotMatch(source, /node:fs|readFile|readdir|opendir/);
});

finish();

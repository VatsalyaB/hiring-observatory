import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createChecker } from './lib/verify.mjs';
import {
  CODES,
  CaptureError,
  collectAdzunaQuery,
  createAdzunaFetchPage,
} from './lib/adzuna-query.mjs';
import {
  manifestPath,
  readSpentBudget,
  writeManifestAtomic,
} from './lib/capture-manifest.mjs';
import adaptAdzuna, { REQUIRED_FIELDS as ADZUNA_REQUIRED_FIELDS } from '../adapters/adzuna.mjs';
import { validateCapture as validateAdzunaCapture } from '../adapters/validate.mjs';
import { runQueryCensus } from './lib/query-census.mjs';
import { buildCoverage, validCaptureEvidence } from './lib/query-coverage.mjs';

const { check, finish } = createChecker('verify-query-census');

const fakePages = (pages, count) => async ({ page }) => ({
  count,
  results: structuredClone(pages[page - 1] ?? []),
});
const records = (n, start = 1) => Array.from({ length: n }, (_, i) => ({ id: String(start + i) }));

const response = ({ ok = true, status = 200, body = '{}' } = {}) => ({
  ok,
  status,
  text: async () => body,
});

async function rejected(action) {
  let error;
  try {
    await action();
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof CaptureError, 'expected CaptureError');
  return error;
}

async function test(name, action) {
  try {
    await action();
    check(name, true);
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : String(error));
  }
}

async function runChild(script, options) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [script], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function mutatedRunner(mutator, label) {
  const original = await readFile(resolve('scripts/lib/query-census.mjs'), 'utf8');
  const changed = mutator(original);
  assert.notEqual(changed, original, `${label} mutation target missing`);
  const withDependencies = changed
    .replace("from './adzuna-query.mjs'", `from '${pathToFileURL(resolve('scripts/lib/adzuna-query.mjs')).href}'`)
    .replace("from './capture-manifest.mjs'", `from '${pathToFileURL(resolve('scripts/lib/capture-manifest.mjs')).href}'`)
    .replace("from './query-set.mjs'", `from '${pathToFileURL(resolve('scripts/lib/query-set.mjs')).href}'`)
    .replace("from './query-coverage.mjs'", `from '${pathToFileURL(resolve('scripts/lib/query-coverage.mjs')).href}'`);
  return import(`data:text/javascript,${encodeURIComponent(withDependencies)}#${label}-${Date.now()}`);
}

const collect = (fetchPage, budgetRemaining = 10) => collectAdzunaQuery({
  country: 'nz',
  query: 'data analyst',
  resultsPerPage: 50,
  budgetRemaining,
  fetchPage,
});

async function assertPreflightBudgetRejection(budgetRemaining) {
  let requests = 0;
  const error = await rejected(() => collect(async () => {
    requests += 1;
    return { count: 0, results: [] };
  }, budgetRemaining));
  assert.equal(error.code, CODES.BUDGET);
  assert.equal(error.pageRequests, 0);
  assert.equal(requests, 0);
}

await test('46 results stop after one short page', async () => {
  const result = await collect(fakePages([records(46)], 46));
  assert.deepEqual(result, {
    records: records(46),
    reportedTotal: 46,
    pagesFetched: 1,
    pageRequests: 1,
    termination: 'short_page',
  });
});

await test('146 results collect three pages through the short terminal page', async () => {
  const result = await collect(fakePages([records(50), records(50, 51), records(46, 101)], 146));
  assert.equal(result.records.length, 146);
  assert.deepEqual(result.records.map((record) => record.id), records(146).map((record) => record.id));
  assert.equal(result.pagesFetched, 3);
  assert.equal(result.pageRequests, 3);
  assert.equal(result.termination, 'short_page');
});

await test('exactly 100 results request the empty third page', async () => {
  const result = await collect(fakePages([records(50), records(50, 51)], 100));
  assert.equal(result.records.length, 100);
  assert.equal(result.pagesFetched, 3);
  assert.equal(result.pageRequests, 3);
  assert.equal(result.termination, 'empty_page');
});

await test('duplicate records remain unchanged across pages', async () => {
  const duplicate = { id: 'duplicate', title: 'same raw record' };
  const firstPage = [duplicate, ...records(49)];
  const result = await collect(fakePages([firstPage, [duplicate]], 51));
  assert.deepEqual(result.records, [...firstPage, duplicate]);
  assert.equal(result.termination, 'short_page');
});

await test('a depleted budget fails before an unattempted third page', async () => {
  const error = await rejected(() => collect(
    fakePages([records(50), records(50, 51), records(46, 101)], 146),
    2,
  ));
  assert.equal(error.code, CODES.BUDGET);
  assert.equal(error.pageRequests, 2);
});

await test('a zero budget exhausts before any fetch', async () => {
  await assertPreflightBudgetRejection(0);
});

await test('a negative budget fails safely before any fetch', async () => {
  await assertPreflightBudgetRejection(-1);
});

await test('a fractional budget fails safely before any fetch', async () => {
  await assertPreflightBudgetRejection(1.5);
});

await test('a NaN budget fails safely before any fetch', async () => {
  await assertPreflightBudgetRejection(Number.NaN);
});

await test('a positive infinite budget fails safely before any fetch', async () => {
  await assertPreflightBudgetRejection(Infinity);
});

await test('a negative infinite budget fails safely before any fetch', async () => {
  await assertPreflightBudgetRejection(-Infinity);
});

await test('a failed second page returns no capture and charges that request', async () => {
  let capture;
  const error = await rejected(async () => {
    capture = await collect(async ({ page }) => {
      if (page === 2) throw new CaptureError(CODES.HTTP, 'safe HTTP failure');
      return { count: 146, results: records(50) };
    });
  });
  assert.equal(capture, undefined);
  assert.equal(error.code, CODES.HTTP);
  assert.equal(error.pageRequests, 2);
});

await test('negative counts are rejected as invalid page shape', async () => {
  const error = await rejected(() => collect(async () => ({ count: -1, results: [] })));
  assert.equal(error.code, CODES.SHAPE);
  assert.equal(error.pageRequests, 1);
});

await test('non-finite counts are rejected as invalid page shape', async () => {
  const error = await rejected(() => collect(async () => ({ count: Number.NaN, results: [] })));
  assert.equal(error.code, CODES.SHAPE);
  assert.equal(error.pageRequests, 1);
});

await test('fractional counts are rejected as invalid page shape', async () => {
  const error = await rejected(() => collect(async () => ({ count: 1.5, results: [{ id: 'one' }] })));
  assert.equal(error.code, CODES.SHAPE);
  assert.equal(error.pageRequests, 1);
});

await test('non-array results are rejected as invalid page shape', async () => {
  const error = await rejected(() => collect(async () => ({ count: 1, results: {} })));
  assert.equal(error.code, CODES.SHAPE);
  assert.equal(error.pageRequests, 1);
});

await test('a page larger than results_per_page is rejected as invalid page shape', async () => {
  const error = await rejected(() => collect(async ({ page }) => (
    page === 1
      ? { count: 51, results: records(51) }
      : { count: 51, results: [] }
  )));
  assert.equal(error.code, CODES.SHAPE);
  assert.equal(error.pageRequests, 1);
});

await test('a reported total changing across pages is rejected as invalid page shape', async () => {
  const error = await rejected(() => collect(async ({ page }) => (
    page === 1
      ? { count: 51, results: records(50) }
      : { count: 50, results: records(1, 51) }
  )));
  assert.equal(error.code, CODES.SHAPE);
  assert.equal(error.pageRequests, 2);
});

await test('records accumulating beyond the first reported total are rejected', async () => {
  const error = await rejected(() => collect(async ({ page }) => (
    page === 1
      ? { count: 50, results: records(50) }
      : { count: 50, results: [{ id: 'overflow' }] }
  )));
  assert.equal(error.code, CODES.SHAPE);
  assert.equal(error.pageRequests, 2);
});

await test('a terminal short page must complete the first reported total', async () => {
  const error = await rejected(() => collect(async () => ({ count: 3, results: [{ id: 'only-one' }] })));
  assert.equal(error.code, CODES.SHAPE);
  assert.equal(error.pageRequests, 1);
});

await test('a valid zero count has a successful valid_zero termination', async () => {
  const result = await collect(fakePages([[]], 0));
  assert.deepEqual(result, {
    records: [],
    reportedTotal: 0,
    pagesFetched: 1,
    pageRequests: 1,
    termination: 'valid_zero',
  });
});

await test('the fetch boundary constructs the documented query request', async () => {
  const calls = [];
  const fetchPage = createAdzunaFetchPage({
    appId: 'id1',
    appKey: 'key1',
    userAgent: 'query-census-test',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return response({ body: JSON.stringify({ count: 1, results: [{ id: 'a' }] }) });
    },
  });
  const result = await fetchPage({ country: 'nz', query: 'data analyst', page: 2, resultsPerPage: 50 });
  const url = new URL(calls[0].url);
  assert.deepEqual(result, { count: 1, results: [{ id: 'a' }] });
  assert.equal(url.pathname, '/v1/api/jobs/nz/search/2');
  assert.equal(url.searchParams.get('app_id'), 'id1');
  assert.equal(url.searchParams.get('app_key'), 'key1');
  assert.equal(url.searchParams.get('what'), 'data analyst');
  assert.equal(url.searchParams.get('results_per_page'), '50');
  assert.equal(url.searchParams.get('content-type'), 'application/json');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(calls[0].init.headers['User-Agent'], 'query-census-test');
});

await test('credential-echoing authentication failures expose neither credential nor response body', async () => {
  const fetchPage = createAdzunaFetchPage({
    appId: 'id1',
    appKey: 'key1',
    fetchImpl: async () => response({ ok: false, status: 401, body: 'request echoed id1 and key1' }),
  });
  const error = await rejected(() => fetchPage({ country: 'nz', query: 'data analyst', page: 1, resultsPerPage: 50 }));
  assert.equal(error.code, CODES.AUTH);
  assert.match(error.message, /HTTP 401 \(27B body, not shown\)/);
  assert.ok(!error.message.includes('id1'));
  assert.ok(!error.message.includes('key1'));
  assert.ok(!error.message.includes('request echoed'));
});

await test('an injected CaptureError cannot expose credentials, URL, or response body', async () => {
  const appId = 'id1';
  const appKey = 'key1';
  const unsafeUrl = 'https://api.adzuna.com/v1/api/jobs/nz/search/1?app_id=id1&app_key=key1';
  const unsafeBody = 'response body from the rejecting fake';
  const fetchPage = createAdzunaFetchPage({
    appId,
    appKey,
    fetchImpl: async () => {
      throw new CaptureError(CODES.AUTH, `injected ${unsafeUrl} ${unsafeBody}`);
    },
  });
  const error = await rejected(() => fetchPage({ country: 'nz', query: 'data analyst', page: 1, resultsPerPage: 50 }));
  assert.equal(error.code, CODES.HTTP);
  assert.ok(!error.message.includes(appId));
  assert.ok(!error.message.includes(appKey));
  assert.ok(!error.message.includes(unsafeUrl));
  assert.ok(!error.message.includes(unsafeBody));
});

await test('an injected response accessor cannot expose credentials, URL, or response body', async () => {
  const appId = 'id1';
  const appKey = 'key1';
  const unsafeUrl = 'https://api.adzuna.com/v1/api/jobs/nz/search/1?app_id=id1&app_key=key1';
  const unsafeBody = 'response body from the rejecting accessor';
  const fetchPage = createAdzunaFetchPage({
    appId,
    appKey,
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => ({
        get length() {
          throw new CaptureError(CODES.AUTH, `injected ${unsafeUrl} ${unsafeBody}`);
        },
      }),
    }),
  });
  const error = await rejected(() => fetchPage({ country: 'nz', query: 'data analyst', page: 1, resultsPerPage: 50 }));
  assert.equal(error.code, CODES.HTTP);
  assert.ok(!error.message.includes(appId));
  assert.ok(!error.message.includes(appKey));
  assert.ok(!error.message.includes(unsafeUrl));
  assert.ok(!error.message.includes(unsafeBody));
});

await test('non-auth HTTP failures use the controlled HTTP code', async () => {
  const fetchPage = createAdzunaFetchPage({
    appId: 'id1',
    appKey: 'key1',
    fetchImpl: async () => response({ ok: false, status: 503, body: 'id1 key1 unavailable' }),
  });
  const error = await rejected(() => fetchPage({ country: 'nz', query: 'data analyst', page: 1, resultsPerPage: 50 }));
  assert.equal(error.code, CODES.HTTP);
  assert.match(error.message, /HTTP 503 \(20B body, not shown\)/);
  assert.ok(!error.message.includes('id1'));
  assert.ok(!error.message.includes('key1'));
});

await test('parse failures use a credential-safe controlled code', async () => {
  const fetchPage = createAdzunaFetchPage({
    appId: 'id1',
    appKey: 'key1',
    fetchImpl: async () => response({ body: 'not JSON: id1 key1' }),
  });
  const error = await rejected(() => fetchPage({ country: 'nz', query: 'data analyst', page: 1, resultsPerPage: 50 }));
  assert.equal(error.code, CODES.PARSE);
  assert.ok(!error.message.includes('id1'));
  assert.ok(!error.message.includes('key1'));
});

await test('timeouts use a credential-safe controlled code', async () => {
  const fetchPage = createAdzunaFetchPage({
    appId: 'id1',
    appKey: 'key1',
    timeoutMs: 1,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timed out with id1 key1')));
    }),
  });
  const error = await rejected(() => fetchPage({ country: 'nz', query: 'data analyst', page: 1, resultsPerPage: 50 }));
  assert.equal(error.code, CODES.TIMEOUT);
  assert.ok(!error.message.includes('id1'));
  assert.ok(!error.message.includes('key1'));
});

async function assertChargedBoundaryFailure(code, fetchImpl) {
  let calls = 0;
  const fetchPage = createAdzunaFetchPage({ appId: 'id1', appKey: 'key1', timeoutMs: 1, fetchImpl });
  const error = await rejected(() => collect(async (input) => {
    calls += 1;
    if (calls === 1) return { count: 100, results: records(50) };
    return fetchPage(input);
  }));
  assert.equal(error.code, code);
  assert.equal(error.pageRequests, 2);
}

const manifest = ({
  collector = 'adzuna-query-census',
  partition = '2026-08-10',
  pageRequests = 1,
  errorCode = null,
  dailyPageBudget = 60,
} = {}) => ({
  schema_version: 1,
  collector,
  partition,
  query_set: 'nz-ai-data-v1',
  run: {
    event_name: 'schedule',
    run_id: '123456',
    run_attempt: 1,
    sha: '0000000000000000000000000000000000000000',
  },
  started_at: '2026-08-10T00:00:00.000Z',
  finished_at: '2026-08-10T00:01:00.000Z',
  page_requests: pageRequests,
  daily_page_budget: dailyPageBudget,
  queries: [{
    query_id: 'data-analyst',
    status: errorCode ? 'failed' : 'written',
    page_requests: pageRequests,
    record_count: 0,
    error_code: errorCode,
  }],
});

async function writeCommittedManifest(root, partition, runId, attempt, data) {
  const path = join(root, 'raw', '_manifests', partition, `${runId}-${attempt}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));
}

async function assertNoPartialFiles(path) {
  assert.deepEqual((await readdir(dirname(path))).filter((name) => name.endsWith('.partial')), []);
}

async function openThenRejectWrite(path, flags) {
  const handle = await open(path, flags);
  return {
    writeFile: async () => { throw new Error('injected post-create write failure'); },
    close: () => handle.close(),
  };
}

await test('a failed HTTP fetch is charged to its attempted second page', async () => {
  await assertChargedBoundaryFailure(CODES.HTTP, async () => response({ ok: false, status: 500 }));
});

await test('a failed parse is charged to its attempted second page', async () => {
  await assertChargedBoundaryFailure(CODES.PARSE, async () => response({ body: 'not JSON' }));
});

await test('a failed timeout is charged to its attempted second page', async () => {
  await assertChargedBoundaryFailure(CODES.TIMEOUT, async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timed out')));
  }));
});

await test('budget sums both scheduled attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    await writeCommittedManifest(root, '2026-08-10', 'scheduled', 1, manifest({ pageRequests: 12 }));
    await writeCommittedManifest(root, '2026-08-10', 'scheduled', 2, manifest({ pageRequests: 7 }));
    assert.equal(await readSpentBudget(root, '2026-08-10', 'adzuna-query-census'), 19);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('another collector does not spend narrow budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    await writeCommittedManifest(root, '2026-08-10', 'scheduled', 1, manifest({ pageRequests: 12 }));
    assert.equal(await readSpentBudget(root, '2026-08-10', 'other'), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('malformed committed manifest evidence fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    await writeCommittedManifest(root, '2026-08-10', 'scheduled', 1, '{not json');
    await assert.rejects(
      readSpentBudget(root, '2026-08-10', 'adzuna-query-census'),
      /manifest evidence invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('negative manifest page requests fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    await writeCommittedManifest(root, '2026-08-10', 'scheduled', 1, manifest({ pageRequests: -1 }));
    await assert.rejects(
      readSpentBudget(root, '2026-08-10', 'adzuna-query-census'),
      /manifest evidence invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('fractional manifest page requests fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    await writeCommittedManifest(root, '2026-08-10', 'scheduled', 1, manifest({ pageRequests: 1.5 }));
    await assert.rejects(
      readSpentBudget(root, '2026-08-10', 'adzuna-query-census'),
      /manifest evidence invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('manifest request totals cannot exceed the declared daily budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-manifest-total-budget-'));
  try {
    const path = manifestPath(root, '2026-08-10', 'over-budget', 1);
    const value = manifest();
    value.page_requests = 61;
    value.queries = [
      { ...value.queries[0], query_id: 'data-analyst', page_requests: 30 },
      { ...value.queries[0], query_id: 'data-engineer', page_requests: 31 },
    ];
    await assert.rejects(writeManifestAtomic(path, value), /manifest evidence invalid/);
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, mutate] of [
  ['record count', (value) => { value.queries[0].record_count = Number.MAX_SAFE_INTEGER + 1; }],
  ['run attempt', (value) => { value.run.run_attempt = Number.MAX_SAFE_INTEGER + 1; }],
]) {
  await test(`manifest rejects unsafe integer ${label}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'census-manifest-unsafe-integer-'));
    try {
      const path = manifestPath(root, '2026-08-10', `unsafe-${label.replace(' ', '-')}`, 1);
      const value = manifest();
      mutate(value);
      await assert.rejects(writeManifestAtomic(path, value), /manifest evidence invalid/);
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const invalidBudget of [0, 61, 1.5]) {
  await test(`manifest daily budget ${invalidBudget} fails closed without a final`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'census-manifest-budget-'));
    try {
      const path = manifestPath(root, '2026-08-10', `budget-${String(invalidBudget).replace('.', '-')}`, 1);
      await assert.rejects(
        writeManifestAtomic(path, manifest({ dailyPageBudget: invalidBudget })),
        /manifest evidence invalid/,
      );
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test('uncontrolled query status and error codes fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    await writeCommittedManifest(root, '2026-08-10', 'status', 1, {
      ...manifest(),
      queries: [{ ...manifest().queries[0], status: 'source_error' }],
    });
    await assert.rejects(
      readSpentBudget(root, '2026-08-10', 'adzuna-query-census'),
      /manifest evidence invalid/,
    );
    await rm(join(root, 'raw', '_manifests', '2026-08-10'), { recursive: true, force: true });
    await writeCommittedManifest(root, '2026-08-10', 'error', 1, manifest({ errorCode: 'source_error' }));
    await assert.rejects(
      readSpentBudget(root, '2026-08-10', 'adzuna-query-census'),
      /manifest evidence invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('manifest path uses the committed partition layout', async () => {
  assert.equal(
    manifestPath('/tmp/census', '2026-08-10', 'scheduled', 2),
    '/tmp/census/raw/_manifests/2026-08-10/scheduled-2.json',
  );
});

await test('atomic manifest writes whitelist safe evidence and reject a second final', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    const path = manifestPath(root, '2026-08-10', 'scheduled', 1);
    const unsafeUrl = 'https://api.adzuna.com/?app_id=id1&app_key=key1';
    await writeManifestAtomic(path, {
      ...manifest({ errorCode: CODES.HTTP }),
      upstream_error: `response body at ${unsafeUrl}`,
      queries: [{
        ...manifest({ errorCode: CODES.HTTP }).queries[0],
        response_body: `response body at ${unsafeUrl}`,
      }],
    });
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(Object.keys(written).sort(), [
      'collector',
      'daily_page_budget',
      'finished_at',
      'page_requests',
      'partition',
      'queries',
      'query_set',
      'run',
      'schema_version',
      'started_at',
    ]);
    assert.ok(!JSON.stringify(written).includes(unsafeUrl));
    await assert.rejects(writeManifestAtomic(path, manifest()), /already exists/);
    await assertNoPartialFiles(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('concurrent manifest writers publish exactly one intact final', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    const path = manifestPath(root, '2026-08-10', 'scheduled', 1);
    const first = manifest();
    first.run = { ...first.run, run_id: 'writer-a' };
    const second = manifest();
    second.run = { ...second.run, run_id: 'writer-b' };
    const attempts = await Promise.allSettled([
      writeManifestAtomic(path, first),
      writeManifestAtomic(path, second),
    ]);
    assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(({ status }) => status === 'rejected').length, 1);
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(['writer-a', 'writer-b'].includes(written.run.run_id));
    await assertNoPartialFiles(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a losing writer preserves another writer partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    const path = manifestPath(root, '2026-08-10', 'scheduled', 1);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.partial`, 'owned by another writer');
    await writeManifestAtomic(path, manifest());
    assert.equal(await readFile(`${path}.partial`, 'utf8'), 'owned by another writer');
    assert.deepEqual((await readdir(dirname(path))).filter((name) => name.endsWith('.partial')), ['scheduled-1.json.partial']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('manifest partition must match its evidence directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    await writeCommittedManifest(root, '2026-08-10', 'scheduled', 1, manifest({ partition: '2026-08-11' }));
    await assert.rejects(
      readSpentBudget(root, '2026-08-10', 'adzuna-query-census'),
      /manifest evidence invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('manifest serialization copies run data before an inherited toJSON can alter it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    const path = manifestPath(root, '2026-08-10', 'scheduled', 1);
    const run = Object.assign(Object.create({
      toJSON() {
        return { ...manifest().run, run_id: 'altered', injected: 'unsafe source data' };
      },
    }), manifest().run);
    await writeManifestAtomic(path, { ...manifest(), run });
    const written = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(written.run, manifest().run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('manifest post-create write failure removes its owned UUID partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-'));
  try {
    const path = manifestPath(root, '2026-08-10', 'post-create', 1);
    await assert.rejects(
      writeManifestAtomic(path, manifest(), { openFile: openThenRejectWrite }),
      /injected post-create write failure/,
    );
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await assertNoPartialFiles(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const censusPartition = '2026-08-10';
const censusProvenance = {
  event_name: 'schedule',
  run_id: 'task-4-test',
  run_attempt: 1,
  sha: '0000000000000000000000000000000000000000',
};
const censusQueries = [
  { id: 'data-analyst', text: 'data analyst', role_family: 'data_analysis_bi' },
  { id: 'data-engineer', text: 'data engineer', role_family: 'data_engineering_architecture' },
];

const censusQuerySet = ({ queries = censusQueries, resultsPerPage = 2, dailyPageBudget = 60 } = {}) => ({
  id: 'nz-ai-data-v1',
  country: 'nz',
  effective_from: censusPartition,
  results_per_page: resultsPerPage,
  daily_page_budget: dailyPageBudget,
  queries,
});

const censusFile = (root, queryId) => join(
  root,
  'raw',
  'adzuna-query',
  'nz',
  queryId,
  `${censusPartition}.json`,
);

const runCensus = (rawRoot, fetchPage, overrides = {}) => runQueryCensus({
  rawRoot,
  querySet: censusQuerySet(),
  partition: censusPartition,
  provenance: censusProvenance,
  fetchPage,
  adapt: adaptAdzuna,
  requiredFields: ADZUNA_REQUIRED_FIELDS,
  validateCapture: validateAdzunaCapture,
  now: () => new Date('2026-08-10T00:00:00.000Z'),
  ...overrides,
});

async function partialFiles(root) {
  const raw = join(root, 'raw');
  const files = await readdir(raw, { recursive: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  return files.filter((name) => name.endsWith('.partial'));
}

await test('two complete queries write two final partitions and one manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-'));
  try {
    const result = await runCensus(root, async ({ query }) => ({
      count: 1,
      results: [{ id: query.replaceAll(' ', '-'), adref: `token-${query}` }],
    }));
    assert.deepEqual({ wrote: result.wrote, skipped: result.skipped, failed: result.failed }, {
      wrote: 2,
      skipped: 0,
      failed: 0,
    });
    assert.equal(result.pageRequests, 2);
    for (const query of censusQueries) {
      const partition = JSON.parse(await readFile(censusFile(root, query.id), 'utf8'));
      assert.equal(partition.query.id, query.id);
      assert.equal(partition.count, 1);
    }
    assert.deepEqual(
      await readdir(join(root, 'raw', '_manifests', censusPartition)),
      ['task-4-test-1.json'],
    );
    assert.equal(result.manifestPath, manifestPath(root, censusPartition, 'task-4-test', 1));
    assert.deepEqual(await partialFiles(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('budget 30 flows producer to manifest to coverage without stranding a final', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-budget-30-'));
  try {
    const querySet = censusQuerySet({ queries: [censusQueries[0]], dailyPageBudget: 30 });
    const result = await runCensus(root, async () => ({
      count: 1,
      results: [{ id: 'budget-30-record' }],
    }), { querySet });
    const capture = JSON.parse(await readFile(censusFile(root, 'data-analyst'), 'utf8'));
    const writtenManifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(writtenManifest.daily_page_budget, 30);
    const coverage = buildCoverage({
      querySet,
      partition: censusPartition,
      captures: [capture],
      manifests: [writtenManifest],
    });
    assert.deepEqual({ wrote: result.wrote, complete: coverage.complete, comparable: coverage.comparable }, {
      wrote: 1,
      complete: 1,
      comparable: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('one failed query writes neither its partition nor blocks another query or the manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-'));
  try {
    const result = await runCensus(root, async ({ query }) => {
      if (query === 'data analyst') throw new Error('unsafe upstream detail');
      return { count: 1, results: [{ id: 'engineer-1' }] };
    });
    assert.deepEqual({ wrote: result.wrote, failed: result.failed }, { wrote: 1, failed: 1 });
    await assert.rejects(readFile(censusFile(root, 'data-analyst')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(censusFile(root, 'data-engineer'), 'utf8')).count, 1);
    const writtenManifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.deepEqual(writtenManifest.queries.map(({ query_id, status, error_code }) => ({
      query_id,
      status,
      error_code,
    })), [
      { query_id: 'data-analyst', status: 'failed', error_code: CODES.HTTP },
      { query_id: 'data-engineer', status: 'written', error_code: null },
    ]);
    assert.ok(!JSON.stringify(writtenManifest).includes('unsafe upstream detail'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a true zero writes a final zero partition with valid_zero status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-'));
  try {
    const querySet = censusQuerySet({ queries: [censusQueries[0]] });
    const result = await runCensus(root, async () => ({ count: 0, results: [] }), { querySet });
    const partition = JSON.parse(await readFile(censusFile(root, 'data-analyst'), 'utf8'));
    assert.equal(result.wrote, 1);
    assert.equal(result.statuses[0].status, 'valid_zero');
    assert.equal(partition.count, 0);
    assert.deepEqual(partition.records, []);
    assert.equal(partition.meta.reported_total, 0);
    assert.equal(partition.meta.termination, 'valid_zero');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('an empty page with a non-zero reported total is failure, never valid_zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-'));
  try {
    const querySet = censusQuerySet({ queries: [censusQueries[0]] });
    const result = await runCensus(root, async () => ({ count: 3, results: [] }), { querySet });
    assert.equal(result.failed, 1);
    assert.equal(result.statuses[0].status, 'failed');
    assert.equal(result.statuses[0].error_code, CODES.SHAPE);
    await assert.rejects(readFile(censusFile(root, 'data-analyst')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, fetchPage, expectedRequests] of [
  ['negative count', async () => ({ count: -1, results: [] }), 1],
  ['fractional count', async () => ({ count: 1.5, results: [{ id: 'fractional' }] }), 1],
  ['non-array results', async () => ({ count: 1, results: {} }), 1],
  ['oversized page', async ({ page }) => (page === 1
    ? { count: 3, results: records(3) }
    : { count: 3, results: [] }), 1],
  ['changing total', async ({ page }) => (page === 1
    ? { count: 3, results: records(2) }
    : { count: 2, results: [{ id: 'third' }] }), 2],
  ['accumulated records beyond total', async ({ page }) => (page === 1
    ? { count: 2, results: records(2) }
    : { count: 2, results: [{ id: 'overflow' }] }), 2],
  ['inconsistent terminal completion', async () => ({ count: 3, results: [{ id: 'incomplete' }] }), 1],
]) {
  await test(`runner rejects paginator ${label} evidence without writing a final`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'census-runner-page-shape-'));
    try {
      const querySet = censusQuerySet({ queries: [censusQueries[0]] });
      const result = await runCensus(root, fetchPage, { querySet });
      assert.equal(result.failed, 1);
      assert.equal(result.statuses[0].error_code, CODES.SHAPE);
      assert.equal(result.statuses[0].page_requests, expectedRequests);
      await assert.rejects(readFile(censusFile(root, 'data-analyst')), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test('runner validates the exact assembled payload even when adapter validation is bypassed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-evidence-'));
  try {
    const querySet = censusQuerySet({ queries: [censusQueries[0]] });
    const result = await runCensus(root, async () => ({
      count: 1,
      results: [{ id: 'undefined' }],
    }), {
      querySet,
      validateCapture: async () => ({ ok: true, problems: [], notes: [] }),
    });
    assert.equal(result.failed, 1);
    assert.equal(result.statuses[0].error_code, CODES.SHAPE);
    await assert.rejects(readFile(censusFile(root, 'data-analyst')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('mutation guard kills removal of exact assembled-payload validation', async () => {
  const mutant = await mutatedRunner((source) => source.replace(
    `    if (!validCaptureEvidence(payload, querySet, partition, query)) {\n      failed += 1;\n      statuses.push(failedStatus(query.id, capture.pageRequests, CODES.SHAPE));\n      continue;\n    }\n\n`,
    '',
  ), 'remove-assembled-evidence-validation');
  const root = await mkdtemp(join(tmpdir(), 'census-runner-mutant-'));
  try {
    const querySet = censusQuerySet({ queries: [censusQueries[0]] });
    const result = await mutant.runQueryCensus({
      rawRoot: root,
      querySet,
      partition: censusPartition,
      provenance: censusProvenance,
      fetchPage: async () => ({ count: 1, results: [{ id: 'undefined' }] }),
      adapt: adaptAdzuna,
      requiredFields: ADZUNA_REQUIRED_FIELDS,
      validateCapture: async () => ({ ok: true, problems: [], notes: [] }),
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    });
    const written = JSON.parse(await readFile(censusFile(root, 'data-analyst'), 'utf8'));
    assert.equal(result.wrote, 1);
    assert.equal(validCaptureEvidence(written, querySet, censusPartition, censusQueries[0]), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a second run skips an existing final partition without fetching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-'));
  try {
    const path = censusFile(root, 'data-analyst');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ immutable: true }));
    let requests = 0;
    const querySet = censusQuerySet({ queries: [censusQueries[0]] });
    const result = await runCensus(root, async () => {
      requests += 1;
      return { count: 1, results: [{ id: 'must-not-fetch' }] };
    }, { querySet });
    assert.deepEqual({ wrote: result.wrote, skipped: result.skipped, failed: result.failed }, {
      wrote: 0,
      skipped: 1,
      failed: 0,
    });
    assert.equal(requests, 0);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { immutable: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('validated earlier manifests reduce the remaining daily budget across attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-'));
  try {
    await writeCommittedManifest(root, censusPartition, 'earlier', 1, manifest({ pageRequests: 59 }));
    let requests = 0;
    const result = await runCensus(root, async ({ query }) => {
      requests += 1;
      return { count: 1, results: [{ id: query.replaceAll(' ', '-') }] };
    });
    assert.equal(requests, 1);
    assert.equal(result.pageRequests, 1);
    assert.deepEqual({ wrote: result.wrote, failed: result.failed }, { wrote: 1, failed: 1 });
    assert.equal(result.statuses[1].error_code, CODES.BUDGET);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('validation and write failures leave no owned partial file', async () => {
  const validationRoot = await mkdtemp(join(tmpdir(), 'census-runner-'));
  const writeRoot = await mkdtemp(join(tmpdir(), 'census-runner-'));
  const querySet = censusQuerySet({ queries: [censusQueries[0]] });
  try {
    const validationResult = await runCensus(validationRoot, async () => ({
      count: 1,
      results: [{ id: 'invalid-1' }],
    }), {
      querySet,
      validateCapture: async () => ({ ok: false, problems: ['controlled validation failure'], notes: [] }),
    });
    assert.equal(validationResult.statuses[0].error_code, 'validation_failed');
    assert.deepEqual(await partialFiles(validationRoot), []);

    const cyclic = { id: 'cyclic-1' };
    cyclic.self = cyclic;
    const writeResult = await runCensus(writeRoot, async () => ({ count: 1, results: [cyclic] }), { querySet });
    assert.equal(writeResult.statuses[0].error_code, 'write_failed');
    assert.deepEqual(await partialFiles(writeRoot), []);
  } finally {
    await rm(validationRoot, { recursive: true, force: true });
    await rm(writeRoot, { recursive: true, force: true });
  }
});

await test('raw Adzuna records retain adref while the adapter is used only for validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-'));
  try {
    const querySet = censusQuerySet({ queries: [censusQueries[0]] });
    const rawRecord = { id: 'raw-1', adref: 'signed-token', title: 'Data Analyst' };
    await runCensus(root, async () => ({ count: 1, results: [rawRecord] }), { querySet });
    const written = JSON.parse(await readFile(censusFile(root, 'data-analyst'), 'utf8'));
    assert.deepEqual(written.records, [rawRecord]);
    assert.equal(written.records[0].adref, 'signed-token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('one run attempts at most 30 pages even with a larger daily remainder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-'));
  try {
    let requests = 0;
    const querySet = censusQuerySet({ queries: [censusQueries[0]], resultsPerPage: 1 });
    const result = await runCensus(root, async () => {
      requests += 1;
      return { count: 100, results: [{ id: `record-${requests}` }] };
    }, { querySet });
    assert.equal(requests, 30);
    assert.equal(result.pageRequests, 30);
    assert.equal(result.failed, 1);
    assert.equal(result.statuses[0].error_code, CODES.BUDGET);
    await assert.rejects(readFile(censusFile(root, 'data-analyst')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('runner passes adapter requiredFields through capture validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-runner-'));
  try {
    const calls = [];
    const querySet = censusQuerySet({ queries: [censusQueries[0]] });
    const result = await runCensus(root, async () => ({ count: 1, results: [{ id: 'required-1' }] }), {
      querySet,
      validateCapture: async (input) => {
        calls.push(input);
        return { ok: true, problems: [], notes: [] };
      },
    });
    assert.equal(result.wrote, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].adapt, adaptAdzuna);
    assert.deepEqual(calls[0].requiredFields, ['id']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('path-traversing query ids are rejected before fetch or filesystem writes', async () => {
  const container = await mkdtemp(join(tmpdir(), 'census-path-'));
  const rawRoot = join(container, 'work', 'root');
  const escapedPath = join(container, 'work', 'outside', `${censusPartition}.json`);
  try {
    await mkdir(rawRoot, { recursive: true });
    const querySet = censusQuerySet({ queries: [{
      ...censusQueries[0],
      id: '../../../../outside',
    }] });
    let requests = 0;
    let rejected = false;
    try {
      await runCensus(rawRoot, async () => {
        requests += 1;
        return { count: 1, results: [{ id: 'escaped-1' }] };
      }, { querySet });
    } catch {
      rejected = true;
    }
    const escaped = await access(escapedPath).then(() => true, () => false);
    const rawEntries = await readdir(rawRoot, { recursive: true });
    assert.deepEqual({ rejected, requests, escaped, rawEntries }, {
      rejected: true,
      requests: 0,
      escaped: false,
      rawEntries: [],
    });
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

await test('a symlinked partition parent is rejected before fetch or archive writes', async () => {
  const container = await mkdtemp(join(tmpdir(), 'census-partition-symlink-'));
  const rawRoot = join(container, 'root');
  const outside = join(container, 'outside');
  const captureRoot = join(rawRoot, 'raw', 'adzuna-query');
  const outsideFinal = join(outside, 'data-analyst', `${censusPartition}.json`);
  const expectedManifest = manifestPath(rawRoot, censusPartition, censusProvenance.run_id, 1);
  try {
    await mkdir(captureRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(captureRoot, 'nz'), 'dir');
    let requests = 0;
    let rejection = null;
    try {
      await runCensus(rawRoot, async () => {
        requests += 1;
        return { count: 1, results: [{ id: 'escaped-partition' }] };
      }, { querySet: censusQuerySet({ queries: [censusQueries[0]] }) });
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    assert.deepEqual({
      rejection,
      requests,
      outsideFinal: await access(outsideFinal).then(() => true, () => false),
      manifest: await access(expectedManifest).then(() => true, () => false),
      outsideEntries: await readdir(outside, { recursive: true }),
    }, {
      rejection: 'invalid capture path',
      requests: 0,
      outsideFinal: false,
      manifest: false,
      outsideEntries: [],
    });
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

await test('a symlinked manifest parent is rejected before fetch or archive writes', async () => {
  const container = await mkdtemp(join(tmpdir(), 'census-manifest-symlink-'));
  const rawRoot = join(container, 'root');
  const outside = join(container, 'outside');
  const manifestRoot = join(rawRoot, 'raw', '_manifests');
  const outsideManifest = join(outside, `${censusProvenance.run_id}-1.json`);
  const partitionFinal = censusFile(rawRoot, 'data-analyst');
  try {
    await mkdir(manifestRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(manifestRoot, censusPartition), 'dir');
    let requests = 0;
    let rejection = null;
    try {
      await runCensus(rawRoot, async () => {
        requests += 1;
        return { count: 1, results: [{ id: 'escaped-manifest' }] };
      }, { querySet: censusQuerySet({ queries: [censusQueries[0]] }) });
    } catch (error) {
      rejection = error instanceof Error ? error.message : String(error);
    }
    assert.deepEqual({
      rejection,
      requests,
      partitionFinal: await access(partitionFinal).then(() => true, () => false),
      outsideManifest: await access(outsideManifest).then(() => true, () => false),
      outsideEntries: await readdir(outside, { recursive: true }),
    }, {
      rejection: 'invalid capture path',
      requests: 0,
      partitionFinal: false,
      outsideManifest: false,
      outsideEntries: [],
    });
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

for (const [label, provenance] of [
  ['run_id', { ...censusProvenance, run_id: '../escape' }],
  ['event_name', { ...censusProvenance, event_name: '../schedule' }],
  ['run_attempt', { ...censusProvenance, run_attempt: 0 }],
  ['sha', { ...censusProvenance, sha: 'not-a-sha' }],
]) {
  await test(`invalid provenance ${label} is rejected before fetch or filesystem writes`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'census-provenance-'));
    try {
      let requests = 0;
      let rejected = false;
      try {
        await runCensus(root, async () => {
          requests += 1;
          return { count: 1, results: [{ id: 'unsafe-provenance' }] };
        }, {
          querySet: censusQuerySet({ queries: [censusQueries[0]] }),
          provenance,
        });
      } catch {
        rejected = true;
      }
      assert.deepEqual({
        rejected,
        requests,
        entries: await readdir(root, { recursive: true }),
      }, {
        rejected: true,
        requests: 0,
        entries: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test('missing credentials write a durable zero-request auth failure manifest for every query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-cli-auth-'));
  const outputPath = join(root, 'github-output.txt');
  const script = resolve('scripts/ingest-query-census.mjs');
  const runId = 'missing-credentials';
  const runAttempt = 1;
  const querySet = censusQuerySet();
  const partition = new Date().toISOString().slice(0, 10);
  try {
    await mkdir(join(root, 'config', 'query-sets'), { recursive: true });
    await writeFile(
      join(root, 'config', 'query-sets', 'nz-ai-data-v1.json'),
      `${JSON.stringify(querySet, null, 2)}\n`,
      'utf8',
    );
    const result = await runChild(script, {
      cwd: root,
      env: {
        ...process.env,
        ADZUNA_APP_ID: '',
        ADZUNA_APP_KEY: '',
        GITHUB_EVENT_NAME: 'schedule',
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: String(runAttempt),
        GITHUB_SHA: censusProvenance.sha,
        GITHUB_OUTPUT: outputPath,
      },
    });
    const output = await readFile(outputPath, 'utf8');
    const written = JSON.parse(await readFile(
      manifestPath(root, partition, runId, runAttempt),
      'utf8',
    ));
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'auth_failed\n');
    assert.equal(output, `failed=${querySet.queries.length}\nwrote=0\npage_requests=0\n`);
    assert.equal(written.page_requests, 0);
    assert.equal(written.queries.length, querySet.queries.length);
    assert.deepEqual(written.queries, querySet.queries.map((query) => ({
      query_id: query.id,
      status: 'failed',
      page_requests: 0,
      record_count: null,
      error_code: CODES.AUTH,
    })));
    assert.equal(await access(join(root, 'raw', 'adzuna-query')).then(() => true, () => false), false);
    assert.ok(!JSON.stringify(written).includes('ADZUNA_APP'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('CLI writes controlled zero-result counts when main throws before a result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-cli-'));
  const outputPath = join(root, 'github-output.txt');
  const script = resolve('scripts/ingest-query-census.mjs');
  const unsafe = 'https://example.invalid/?app_id=secret-app-id&app_key=secret-app-key response body';
  try {
    const result = await runChild(script, {
      cwd: root,
      env: {
        ...process.env,
        ADZUNA_APP_ID: 'secret-app-id',
        ADZUNA_APP_KEY: 'secret-app-key',
        GITHUB_OUTPUT: outputPath,
        UPSTREAM_ERROR_FOR_TEST: unsafe,
      },
    });
    const output = await readFile(outputPath, 'utf8').catch(() => null);
    assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr, output }, {
      code: 1,
      stdout: '',
      stderr: 'write_failed\n',
      output: 'failed=1\nwrote=0\npage_requests=0\n',
    });
    assert.ok(!`${result.stdout}${result.stderr}${output}`.includes(unsafe));
    assert.ok(!`${result.stdout}${result.stderr}${output}`.includes('secret-app-key'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('partition post-create write failure removes its owned UUID partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-partial-'));
  try {
    const querySet = censusQuerySet({ queries: [censusQueries[0]] });
    const result = await runCensus(root, async () => ({
      count: 1,
      results: [{ id: 'post-create-1' }],
    }), {
      querySet,
      partitionOpen: openThenRejectWrite,
    });
    assert.equal(result.statuses[0].error_code, 'write_failed');
    await assert.rejects(readFile(censusFile(root, 'data-analyst')), { code: 'ENOENT' });
    assert.deepEqual(await partialFiles(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('concurrent runs publish one immutable final and two controlled manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'census-race-'));
  try {
    const querySet = censusQuerySet({ queries: [censusQueries[0]] });
    let arrivals = 0;
    let release;
    const bothFetching = new Promise((resolveGate) => { release = resolveGate; });
    const fetchFor = (label) => async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothFetching;
      return { count: 1, results: [{ id: `record-${label}`, capture: label }] };
    };
    const provenances = [
      { ...censusProvenance, run_id: 'race-a' },
      { ...censusProvenance, run_id: 'race-b' },
    ];
    const results = await Promise.all([
      runCensus(root, fetchFor('a'), { querySet, provenance: provenances[0] }),
      runCensus(root, fetchFor('b'), { querySet, provenance: provenances[1] }),
    ]);

    assert.equal(results.filter(({ wrote }) => wrote === 1).length, 1);
    assert.equal(results.filter(({ skipped }) => skipped === 1).length, 1);
    assert.ok(results.every(({ failed, pageRequests }) => failed === 0 && pageRequests === 1));

    const final = JSON.parse(await readFile(censusFile(root, 'data-analyst'), 'utf8'));
    assert.ok([
      JSON.stringify({ run_id: 'race-a', record: { id: 'record-a', capture: 'a' } }),
      JSON.stringify({ run_id: 'race-b', record: { id: 'record-b', capture: 'b' } }),
    ].includes(JSON.stringify({ run_id: final.run_id, record: final.records[0] })));

    for (let index = 0; index < provenances.length; index += 1) {
      const result = results[index];
      const path = manifestPath(root, censusPartition, provenances[index].run_id, 1);
      const written = JSON.parse(await readFile(path, 'utf8'));
      assert.deepEqual(written.queries[0], {
        query_id: 'data-analyst',
        status: result.statuses[0].status,
        page_requests: 1,
        record_count: result.statuses[0].record_count,
        error_code: null,
      });
    }
    assert.deepEqual(await partialFiles(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

finish();

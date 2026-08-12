import { access, link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CODES, collectAdzunaQuery } from './adzuna-query.mjs';
import {
  manifestPath,
  readSpentBudget,
  validateProvenance,
  writeManifestAtomic,
} from './capture-manifest.mjs';
import { validateQuerySet } from './query-set.mjs';
import { validCaptureEvidence } from './query-coverage.mjs';

const COLLECTOR = 'adzuna-query-census';
const VALIDATION_FAILED = 'validation_failed';
const WRITE_FAILED = 'write_failed';
const CAPTURE_CODES = new Set(Object.values(CODES));
const PARTITION = /^\d{4}-\d{2}-\d{2}$/;

function safeCapturePaths(rawRoot, querySet, partition) {
  const validation = validateQuerySet(querySet);
  if (!validation.ok) throw new Error('invalid query set');
  if (typeof rawRoot !== 'string' || rawRoot.length === 0 || !PARTITION.test(partition)) {
    throw new Error('invalid capture path');
  }

  const captureRoot = resolve(rawRoot, 'raw', 'adzuna-query');
  const paths = new Map();
  for (const query of querySet.queries) {
    const path = resolve(captureRoot, querySet.country, query.id, `${partition}.json`);
    const fromRoot = relative(captureRoot, path);
    if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new Error('invalid capture path');
    }
    paths.set(query.id, path);
  }
  return { captureRoot, paths };
}

function containedBy(base, path) {
  const fromBase = relative(base, path);
  return fromBase === '' || (!fromBase.startsWith('..') && !isAbsolute(fromBase));
}

function invalidCapturePath() {
  throw new Error('invalid capture path');
}

async function assertPhysicalCaptureParent(rawRoot, expectedBase, parent, { create = false } = {}) {
  const lexicalRoot = resolve(rawRoot);
  const lexicalBase = resolve(expectedBase);
  const lexicalParent = resolve(parent);
  const baseFromRoot = relative(lexicalRoot, lexicalBase);
  const parentFromBase = relative(lexicalBase, lexicalParent);
  if (baseFromRoot === '' || baseFromRoot.startsWith('..') || isAbsolute(baseFromRoot)
    || parentFromBase === '' || parentFromBase.startsWith('..') || isAbsolute(parentFromBase)) {
    invalidCapturePath();
  }

  let realRoot;
  try {
    realRoot = await realpath(lexicalRoot);
    if (!(await lstat(realRoot)).isDirectory()) invalidCapturePath();
  } catch {
    invalidCapturePath();
  }

  let current = lexicalRoot;
  let nearestExisting = lexicalRoot;
  let complete = true;
  for (const component of relative(lexicalRoot, lexicalParent).split(sep).filter(Boolean)) {
    current = join(current, component);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') invalidCapturePath();
      if (!create) {
        complete = false;
        break;
      }
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') invalidCapturePath();
      }
      try {
        stats = await lstat(current);
      } catch {
        invalidCapturePath();
      }
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) invalidCapturePath();
    nearestExisting = current;
  }

  try {
    const realExisting = await realpath(complete ? lexicalParent : nearestExisting);
    if (!containedBy(realRoot, realExisting)) invalidCapturePath();
    if (complete) {
      const realBase = await realpath(lexicalBase);
      const realParent = await realpath(lexicalParent);
      if (!containedBy(realRoot, realBase) || !containedBy(realBase, realParent)) {
        invalidCapturePath();
      }
    }
  } catch {
    invalidCapturePath();
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writePartitionAtomic(path, payload, openFile = open, parentGuard) {
  const partialPath = `${path}.${randomUUID()}.partial`;
  await parentGuard();
  if (await exists(path)) return false;

  let handle;
  let ownsPartial = false;
  try {
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    await parentGuard();
    handle = await openFile(partialPath, 'wx');
    ownsPartial = true;
    await handle.writeFile(body, { encoding: 'utf8' });
    await handle.close();
    handle = null;
    try {
      // A hard-link publish is atomic like rename but cannot replace a final created by a racing
      // writer. Removing our sibling afterwards leaves the final inode intact and write-once.
      await parentGuard();
      await link(partialPath, path);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (ownsPartial) await rm(partialPath, { force: true });
  }
}

function timestamp(now) {
  const value = now();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function failedStatus(queryId, pageRequests, errorCode) {
  return {
    query_id: queryId,
    status: 'failed',
    page_requests: pageRequests,
    record_count: null,
    error_code: errorCode,
  };
}

export async function runQueryCensus({
  rawRoot,
  querySet,
  partition,
  provenance,
  fetchPage,
  adapt,
  requiredFields,
  validateCapture,
  partitionOpen = open,
  manifestOpen = open,
  now = () => new Date(),
}) {
  const { captureRoot, paths: capturePaths } = safeCapturePaths(rawRoot, querySet, partition);
  const safeProvenance = validateProvenance(provenance);
  const manifestFile = manifestPath(
    rawRoot,
    partition,
    safeProvenance.run_id,
    safeProvenance.run_attempt,
  );
  const manifestRoot = resolve(rawRoot, 'raw', '_manifests');
  const manifestParent = dirname(resolve(manifestFile));
  for (const path of capturePaths.values()) {
    await assertPhysicalCaptureParent(rawRoot, captureRoot, dirname(path));
  }
  await assertPhysicalCaptureParent(rawRoot, manifestRoot, manifestParent);
  const startedAt = timestamp(now);
  const spent = await readSpentBudget(rawRoot, partition, COLLECTOR);
  let budgetRemaining = Math.min(30, Math.max(0, querySet.daily_page_budget - spent));
  let wrote = 0;
  let skipped = 0;
  let failed = 0;
  let pageRequests = 0;
  const statuses = [];

  for (const query of querySet.queries) {
    const path = capturePaths.get(query.id);
    const partitionParentGuard = () => assertPhysicalCaptureParent(
      rawRoot,
      captureRoot,
      dirname(path),
      { create: true },
    );

    await assertPhysicalCaptureParent(rawRoot, captureRoot, dirname(path));
    if (await exists(path)) {
      skipped += 1;
      statuses.push({
        query_id: query.id,
        status: 'skipped',
        page_requests: 0,
        record_count: null,
        error_code: null,
      });
      continue;
    }

    let capture;
    try {
      capture = await collectAdzunaQuery({
        country: querySet.country,
        query: query.text,
        resultsPerPage: querySet.results_per_page,
        budgetRemaining,
        fetchPage,
      });
    } catch (error) {
      const attempted = Number.isInteger(error?.pageRequests) ? error.pageRequests : 0;
      pageRequests += attempted;
      budgetRemaining -= attempted;
      failed += 1;
      statuses.push(failedStatus(
        query.id,
        attempted,
        CAPTURE_CODES.has(error?.code) ? error.code : CODES.HTTP,
      ));
      continue;
    }

    pageRequests += capture.pageRequests;
    budgetRemaining -= capture.pageRequests;

    const validZero = capture.termination === 'valid_zero'
      && capture.reportedTotal === 0
      && capture.records.length === 0;
    if (!validZero && (capture.records.length === 0 || capture.reportedTotal === 0)) {
      failed += 1;
      statuses.push(failedStatus(query.id, capture.pageRequests, CODES.SHAPE));
      continue;
    }

    if (!validZero) {
      let validation;
      try {
        validation = await validateCapture({
          sourceId: 'adzuna',
          country: querySet.country,
          records: capture.records,
          adapt,
          requiredFields,
        });
      } catch {
        validation = { ok: false };
      }
      if (!validation?.ok) {
        failed += 1;
        statuses.push(failedStatus(query.id, capture.pageRequests, VALIDATION_FAILED));
        continue;
      }
    }

    const payload = {
      source: 'adzuna',
      coverage_mode: 'query_census',
      country: querySet.country,
      partition,
      fetched_at: timestamp(now),
      event_name: safeProvenance.event_name,
      run_id: safeProvenance.run_id,
      run_attempt: safeProvenance.run_attempt,
      sha: safeProvenance.sha,
      query_set: querySet.id,
      query: {
        id: query.id,
        text: query.text,
        role_family: query.role_family,
      },
      count: capture.records.length,
      meta: {
        reported_total: capture.reportedTotal,
        pages_fetched: capture.pagesFetched,
        results_per_page: querySet.results_per_page,
        termination: capture.termination,
      },
      records: capture.records,
    };

    if (!validCaptureEvidence(payload, querySet, partition, query)) {
      failed += 1;
      statuses.push(failedStatus(query.id, capture.pageRequests, CODES.SHAPE));
      continue;
    }

    let published;
    try {
      published = await writePartitionAtomic(path, payload, partitionOpen, partitionParentGuard);
    } catch {
      failed += 1;
      statuses.push(failedStatus(query.id, capture.pageRequests, WRITE_FAILED));
      continue;
    }

    if (!published) {
      skipped += 1;
      statuses.push({
        query_id: query.id,
        status: 'skipped',
        page_requests: capture.pageRequests,
        record_count: null,
        error_code: null,
      });
      continue;
    }

    wrote += 1;
    statuses.push({
      query_id: query.id,
      status: validZero ? 'valid_zero' : 'written',
      page_requests: capture.pageRequests,
      record_count: capture.records.length,
      error_code: null,
    });
  }

  await writeManifestAtomic(manifestFile, {
    schema_version: 1,
    collector: COLLECTOR,
    partition,
    query_set: querySet.id,
    run: safeProvenance,
    started_at: startedAt,
    finished_at: timestamp(now),
    page_requests: pageRequests,
    daily_page_budget: querySet.daily_page_budget,
    queries: statuses,
  }, {
    openFile: manifestOpen,
    parentGuard: () => assertPhysicalCaptureParent(
      rawRoot,
      manifestRoot,
      manifestParent,
      { create: true },
    ),
  });

  return { wrote, skipped, failed, pageRequests, manifestPath: manifestFile, statuses };
}

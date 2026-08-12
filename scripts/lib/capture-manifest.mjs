import { link, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CODES } from './adzuna-query.mjs';

const COLLECTOR = 'adzuna-query-census';
const MANIFEST_KEYS = [
  'schema_version',
  'collector',
  'partition',
  'query_set',
  'run',
  'started_at',
  'finished_at',
  'page_requests',
  'daily_page_budget',
  'queries',
];
const RUN_KEYS = ['event_name', 'run_id', 'run_attempt', 'sha'];
const QUERY_KEYS = ['query_id', 'status', 'page_requests', 'record_count', 'error_code'];
const STATUSES = new Set(['written', 'valid_zero', 'skipped', 'failed']);
const ERROR_CODES = new Set([...Object.values(CODES), 'validation_failed', 'write_failed']);
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_RUN_VALUE = /^[A-Za-z0-9._-]+$/;
const PARTITION = /^\d{4}-\d{2}-\d{2}$/;

function invalidEvidence() {
  throw new Error('manifest evidence invalid');
}

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidEvidence();
  return value;
}

function exactKeys(value, keys) {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalidEvidence();
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value);
}

function safeRunValue(value) {
  return typeof value === 'string' && SAFE_RUN_VALUE.test(value);
}

function isoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function validateProvenance(value) {
  const source = object(value);
  exactKeys(source, RUN_KEYS);
  const safe = {
    event_name: source.event_name,
    run_id: source.run_id,
    run_attempt: source.run_attempt,
    sha: source.sha,
  };
  if (!safeRunValue(safe.event_name)
    || !safeRunValue(safe.run_id)
    || !Number.isSafeInteger(safe.run_attempt) || safe.run_attempt < 1
    || typeof safe.sha !== 'string' || !/^[a-f0-9]{7,64}$/.test(safe.sha)) invalidEvidence();
  return safe;
}

function safeManifest(manifest) {
  const source = object(manifest);
  const safe = {
    schema_version: source.schema_version,
    collector: source.collector,
    partition: source.partition,
    query_set: source.query_set,
    run: validateProvenance(source.run),
    started_at: source.started_at,
    finished_at: source.finished_at,
    page_requests: source.page_requests,
    daily_page_budget: source.daily_page_budget,
    queries: Array.isArray(source.queries) ? source.queries.map((query) => {
      const item = object(query);
      return {
        query_id: item.query_id,
        status: item.status,
        page_requests: item.page_requests,
        record_count: item.record_count,
        error_code: item.error_code,
      };
    }) : source.queries,
  };
  return validateManifest(safe);
}

function validateManifest(manifest) {
  const value = object(manifest);
  exactKeys(value, MANIFEST_KEYS);
  if (value.schema_version !== 1
    || value.collector !== COLLECTOR
    || typeof value.partition !== 'string' || !PARTITION.test(value.partition)
    || !safeId(value.query_set)
    || !nonNegativeInteger(value.page_requests)
    || !Number.isSafeInteger(value.daily_page_budget)
    || value.daily_page_budget < 1
    || value.daily_page_budget > 60
    || !Array.isArray(value.queries)) invalidEvidence();

  validateProvenance(value.run);
  if (!isoTimestamp(value.started_at)
    || !isoTimestamp(value.finished_at)) invalidEvidence();

  let requests = 0;
  for (const query of value.queries) {
    const item = object(query);
    exactKeys(item, QUERY_KEYS);
    if (!safeId(item.query_id)
      || !STATUSES.has(item.status)
      || !nonNegativeInteger(item.page_requests)
      || item.page_requests > value.daily_page_budget
      || !(item.record_count === null || nonNegativeInteger(item.record_count))
      || !(item.error_code === null || ERROR_CODES.has(item.error_code))) invalidEvidence();
    if ((item.status === 'failed') !== (item.error_code !== null)) invalidEvidence();
    requests += item.page_requests;
    if (!Number.isSafeInteger(requests)) invalidEvidence();
  }
  if (requests !== value.page_requests || requests > value.daily_page_budget) invalidEvidence();
  return value;
}

// Pure read-side contract for consumers that must evaluate captured evidence without filesystem I/O.
export function validateManifestEvidence(manifest) {
  return validateManifest(manifest);
}

export function manifestPath(rawRoot, partition, runId, attempt) {
  if (typeof rawRoot !== 'string' || !PARTITION.test(partition)
    || !safeRunValue(runId) || !Number.isSafeInteger(attempt) || attempt < 1) invalidEvidence();
  return join(rawRoot, 'raw', '_manifests', partition, `${runId}-${attempt}.json`);
}

export async function readSpentBudget(rawRoot, partition, collector) {
  if (typeof rawRoot !== 'string' || !PARTITION.test(partition) || typeof collector !== 'string') invalidEvidence();
  const directory = join(rawRoot, 'raw', '_manifests', partition);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    invalidEvidence();
  }

  let spent = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) invalidEvidence();
    let parsed;
    try {
      parsed = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
    } catch {
      invalidEvidence();
    }
    const manifest = validateManifest(parsed);
    if (manifest.partition !== partition) invalidEvidence();
    if (manifest.collector === collector) {
      spent += manifest.page_requests;
      if (!Number.isSafeInteger(spent)) invalidEvidence();
    }
  }
  return spent;
}

export async function writeManifestAtomic(path, manifest, { openFile = open, parentGuard } = {}) {
  if (typeof path !== 'string' || !path.endsWith('.json')) invalidEvidence();
  const safe = safeManifest(manifest);
  const partialPath = `${path}.${randomUUID()}.partial`;
  if (parentGuard) await parentGuard();
  else await mkdir(dirname(path), { recursive: true });
  try {
    await readFile(path);
    throw new Error('manifest final already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let handle;
  let ownsPartial = false;
  try {
    if (parentGuard) await parentGuard();
    handle = await openFile(partialPath, 'wx');
    ownsPartial = true;
    await handle.writeFile(JSON.stringify(safe), { encoding: 'utf8' });
    await handle.close();
    handle = null;
    if (parentGuard) await parentGuard();
    await link(partialPath, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (ownsPartial) await rm(partialPath, { force: true });
  }
}

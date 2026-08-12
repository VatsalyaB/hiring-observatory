import { validateManifestEvidence, validateProvenance } from './capture-manifest.mjs';

const SUCCESS_TERMINATIONS = new Set(['valid_zero', 'short_page', 'empty_page']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validProvenance(value) {
  try {
    validateProvenance(value);
    return true;
  } catch {
    return false;
  }
}

function validAdzunaId(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized.length > 0 && normalized !== 'undefined' && normalized !== 'null';
}

function plausibleSuccessfulPages(value) {
  const { count, meta } = value;
  const { results_per_page: pageSize, pages_fetched: pages, termination } = meta;
  if (termination === 'short_page') return count % pageSize !== 0 && pages === Math.ceil(count / pageSize);
  return termination === 'empty_page' && count % pageSize === 0 && pages === (count / pageSize) + 1;
}

export function validCaptureEvidence(value, querySet, partition, expectedQuery) {
  if (!isObject(value)
    || !isObject(querySet)
    || !isObject(expectedQuery)
    || value.source !== 'adzuna'
    || value.coverage_mode !== 'query_census'
    || value.country !== querySet.country
    || value.partition !== partition
    || value.query_set !== querySet.id
    || !isObject(value.query)
    || value.query.id !== expectedQuery.id
    || value.query.text !== expectedQuery.text
    || value.query.role_family !== expectedQuery.role_family
    || !Array.isArray(value.records)
    || !nonNegativeInteger(value.count)
    || value.count !== value.records.length
    || !isObject(value.meta)
    || !isoTimestamp(value.fetched_at)
    || typeof value.event_name !== 'string'
    || typeof value.run_id !== 'string'
    || !Number.isInteger(value.run_attempt) || value.run_attempt < 1
    || typeof value.sha !== 'string'
    || !nonNegativeInteger(value.meta.reported_total)
    || !Number.isInteger(value.meta.pages_fetched) || value.meta.pages_fetched < 1
    || !Number.isInteger(value.meta.results_per_page) || value.meta.results_per_page < 1
    || value.meta.results_per_page !== querySet.results_per_page
    || !SUCCESS_TERMINATIONS.has(value.meta.termination)
    || !validProvenance({
      event_name: value.event_name,
      run_id: value.run_id,
      run_attempt: value.run_attempt,
      sha: value.sha,
    })) return false;

  if (value.count === 0) {
    return value.records.length === 0
      && value.meta.reported_total === 0
      && value.meta.pages_fetched === 1
      && value.meta.termination === 'valid_zero';
  }
  if (value.meta.reported_total !== value.count || value.meta.termination === 'valid_zero'
    || !plausibleSuccessfulPages(value)) return false;
  if (!value.records.every((record) => isObject(record) && validAdzunaId(record.id))) return false;
  const distinct = new Set(value.records.map((record) => String(record.id))).size;
  if (value.records.length >= 10 && distinct <= value.records.length / 2) return false;
  return true;
}

function captureCandidate(value) {
  if (!isObject(value)) return { invalid: true, expectedQueryId: undefined };
  if ('data' in value || 'expectedQueryId' in value || 'invalid' in value) {
    return {
      data: value.data,
      expectedQueryId: value.expectedQueryId,
      invalid: value.invalid === true,
    };
  }
  return { data: value, expectedQueryId: value.query?.id, invalid: false };
}

function provenanceKey(value) {
  return JSON.stringify([
    value.event_name,
    value.run_id,
    value.run_attempt,
    value.sha,
  ]);
}

// This model is deliberately I/O-free. The CLI supplies only files belonging to its active query set.
export function buildCoverage({ querySet, partition, captures = [], manifests = [] }) {
  const expectedIds = new Set(querySet?.queries?.map((query) => query?.id));
  if (!isObject(querySet) || typeof querySet.id !== 'string' || typeof querySet.country !== 'string'
    || expectedIds.size !== querySet.queries.length || expectedIds.has(undefined)) {
    throw new Error('invalid query set');
  }
  const queryById = new Map(querySet.queries.map((query) => [query.id, query]));

  let invalidManifest = false;
  const failedByManifest = new Set();
  const entriesByRun = new Map();
  for (const item of manifests) {
    if (isObject(item) && item.invalid === true) {
      invalidManifest = true;
      continue;
    }
    let evidence;
    try {
      evidence = validateManifestEvidence(item);
    } catch {
      invalidManifest = true;
      continue;
    }
    if (evidence.partition !== partition || evidence.query_set !== querySet.id
      || evidence.daily_page_budget !== querySet.daily_page_budget) {
      invalidManifest = true;
      continue;
    }
    const runKey = provenanceKey(evidence.run);
    const entries = entriesByRun.get(runKey) ?? new Map();
    entriesByRun.set(runKey, entries);
    for (const entry of evidence.queries) {
      if (!expectedIds.has(entry.query_id) || entries.has(entry.query_id)) {
        invalidManifest = true;
        continue;
      }
      entries.set(entry.query_id, entry);
      if (entry.status === 'failed') failedByManifest.add(entry.query_id);
    }
  }

  const captureByQuery = new Map();
  const invalidQueries = new Set();
  for (const item of captures) {
    const candidate = captureCandidate(item);
    const expectedQueryId = candidate.expectedQueryId;
    if (!expectedIds.has(expectedQueryId)) continue;
    if (candidate.invalid || !validCaptureEvidence(candidate.data, querySet, partition, queryById.get(expectedQueryId))) {
      invalidQueries.add(expectedQueryId);
      continue;
    }
    const current = captureByQuery.get(expectedQueryId);
    const currentAttempt = current?.run_attempt ?? -1;
    const nextAttempt = candidate.data.run_attempt ?? -1;
    const currentRun = current?.run_id ?? '';
    const nextRun = candidate.data.run_id ?? '';
    if (!current || nextAttempt > currentAttempt || (nextAttempt === currentAttempt && nextRun.localeCompare(currentRun) > 0)) {
      captureByQuery.set(expectedQueryId, candidate.data);
    }
  }

  for (const [queryId, value] of captureByQuery) {
    const entry = entriesByRun.get(provenanceKey(value))?.get(queryId);
    const expectedStatus = value.count === 0 ? 'valid_zero' : 'written';
    if (!entry || entry.status !== expectedStatus || entry.record_count !== value.count
      || entry.page_requests !== value.meta.pages_fetched) {
      invalidQueries.add(queryId);
      captureByQuery.delete(queryId);
    }
  }

  const completeCaptures = [];
  let complete = 0;
  let failed = 0;
  let missing = 0;
  for (const queryId of expectedIds) {
    if (invalidManifest || invalidQueries.has(queryId)) {
      failed += 1;
    } else if (captureByQuery.has(queryId)) {
      complete += 1;
      completeCaptures.push(captureByQuery.get(queryId));
    } else if (failedByManifest.has(queryId)) {
      failed += 1;
    } else {
      missing += 1;
    }
  }

  const records = completeCaptures.flatMap((item) => item.records);
  const ids = new Set(records.map((record) => String(record.id)));
  const observations = records.length;
  const distinct_ads = ids.size;
  return {
    expected: expectedIds.size,
    complete,
    failed,
    missing,
    comparable: failed === 0 && missing === 0,
    observations,
    distinct_ads,
    overlap_rate: observations === 0 ? 0 : (observations - distinct_ads) / observations,
  };
}

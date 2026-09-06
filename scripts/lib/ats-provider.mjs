const CAPTURE_KEYS = [
  'provider',
  'board_id',
  'complete',
  'valid_zero',
  'reported_total',
  'vacancy_ids',
  'pages',
  'attempts',
  'page_requests',
];
export const ATS_PROVIDERS = Object.freeze(['greenhouse', 'ashby', 'smartrecruiters']);
const PROVIDERS = new Set(ATS_PROVIDERS);
const SAFE_BOARD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const ATS_COHORT_TARGET = 45;
export const ATS_PROVIDER_FLOOR = 8;
export const ATS_PROVIDER_CAP = 19;
const ATS_PROVIDER_IDEAL = ATS_COHORT_TARGET / ATS_PROVIDERS.length;

function lexicographicCounts(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function selectAtsProviderAllocation(qualifiedCounts) {
  const available = ATS_PROVIDERS.map((provider) => {
    const value = qualifiedCounts?.[provider];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid qualified provider counts');
    return value;
  });
  let best = null;
  for (let greenhouse = ATS_PROVIDER_FLOOR; greenhouse <= ATS_PROVIDER_CAP; greenhouse += 1) {
    for (let ashby = ATS_PROVIDER_FLOOR; ashby <= ATS_PROVIDER_CAP; ashby += 1) {
      const smartrecruiters = ATS_COHORT_TARGET - greenhouse - ashby;
      if (smartrecruiters < ATS_PROVIDER_FLOOR || smartrecruiters > ATS_PROVIDER_CAP) continue;
      const vector = [greenhouse, ashby, smartrecruiters];
      const shortfall = vector.reduce(
        (sum, count, index) => sum + Math.max(0, count - available[index]),
        0,
      );
      const squaredDeviation = vector.reduce(
        (sum, count) => sum + ((count - ATS_PROVIDER_IDEAL) ** 2),
        0,
      );
      const candidate = { vector, shortfall, squaredDeviation };
      if (
        best === null
        || candidate.shortfall < best.shortfall
        || (candidate.shortfall === best.shortfall && candidate.squaredDeviation < best.squaredDeviation)
        || (
          candidate.shortfall === best.shortfall
          && candidate.squaredDeviation === best.squaredDeviation
          && lexicographicCounts(candidate.vector, best.vector) < 0
        )
      ) best = candidate;
    }
  }
  return {
    counts: Object.fromEntries(ATS_PROVIDERS.map((provider, index) => [provider, best.vector[index]])),
    shortfall: best.shortfall,
  };
}

export const ATS_CODES = Object.freeze({
  HTTP: 'http_failure',
  JSON: 'malformed_json',
  TIMEOUT: 'timeout',
  NETWORK: 'network_failure',
  BINDING: 'board_binding',
  SHAPE: 'schema_drift',
  DUPLICATE: 'duplicate_vacancy',
  EMPTY_QUALIFICATION: 'empty_during_qualification',
  EMPTY_UNQUALIFIED: 'empty_unqualified_employer',
  TOTAL_CHANGED: 'pagination_total_changed',
  OFFSET: 'pagination_offset_mismatch',
  INCOMPLETE: 'pagination_incomplete',
  PAGE_LIMIT: 'pagination_page_limit',
});

export class AtsProviderError extends Error {
  constructor(code, pageRequests = 0, attempts = 1, diagnostic = null) {
    super(`ATS provider capture failed: ${code}`);
    this.name = 'AtsProviderError';
    this.code = code;
    this.pageRequests = pageRequests;
    this.attempts = attempts;
    if (diagnostic !== null) this.diagnostic = diagnostic;
  }
}

export function failAts(code, pageRequests = 0, diagnostic = null) {
  throw new AtsProviderError(code, pageRequests, 1, diagnostic);
}

export function assertAtsEmployer(employer, provider) {
  if (employer === null || typeof employer !== 'object' || Array.isArray(employer)
    || employer.provider !== provider
    || typeof employer.board_id !== 'string' || !SAFE_BOARD.test(employer.board_id)
    || !['candidate', 'qualified', 'rejected', 'retired'].includes(employer.status)) {
    failAts(ATS_CODES.BINDING);
  }
  return employer;
}

export async function readAtsJsonPage(fetchPage, url, pageRequests) {
  let response;
  try {
    response = await fetchPage(url);
  } catch (error) {
    if (error instanceof AtsProviderError) throw error;
    failAts(error?.name === 'AbortError' ? ATS_CODES.TIMEOUT : ATS_CODES.NETWORK, pageRequests);
  }
  if (response === null || typeof response !== 'object' || Array.isArray(response)
    || response.url !== url) failAts(ATS_CODES.BINDING, pageRequests);
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    failAts(ATS_CODES.HTTP, pageRequests);
  }
  if (typeof response.body !== 'string') failAts(ATS_CODES.SHAPE, pageRequests);
  try {
    const parsed = JSON.parse(response.body);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      failAts(ATS_CODES.SHAPE, pageRequests);
    }
    return parsed;
  } catch (error) {
    if (error instanceof AtsProviderError) throw error;
    failAts(ATS_CODES.JSON, pageRequests);
  }
}

export function stableVacancyIds(rows, field, pageRequests) {
  if (!Array.isArray(rows)) failAts(ATS_CODES.SHAPE, pageRequests);
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      failAts(ATS_CODES.SHAPE, pageRequests);
    }
    const raw = row[field];
    if ((typeof raw !== 'string' && typeof raw !== 'number') || String(raw).length === 0) {
      failAts(ATS_CODES.SHAPE, pageRequests);
    }
    const id = String(raw);
    if (seen.has(id)) failAts(ATS_CODES.DUPLICATE, pageRequests);
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function buildBoardCapture({ provider, employer, ids, pages, qualification }) {
  if (ids.length === 0) {
    if (qualification) failAts(ATS_CODES.EMPTY_QUALIFICATION, pages.length);
    if (employer.status !== 'qualified') failAts(ATS_CODES.EMPTY_UNQUALIFIED, pages.length);
  }
  return validateBoardCapture({
    provider,
    board_id: employer.board_id,
    complete: true,
    valid_zero: ids.length === 0,
    reported_total: ids.length,
    vacancy_ids: ids,
    pages,
    attempts: 1,
    page_requests: pages.length,
  });
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

export function validateBoardCapture(value) {
  const invalid = () => {
    throw new Error('invalid ATS capture envelope');
  };
  if (!exactKeys(value, CAPTURE_KEYS)
    || !PROVIDERS.has(value.provider)
    || typeof value.board_id !== 'string' || !SAFE_BOARD.test(value.board_id)
    || value.complete !== true
    || typeof value.valid_zero !== 'boolean'
    || !Number.isSafeInteger(value.reported_total) || value.reported_total < 0
    || !Array.isArray(value.vacancy_ids)
    || value.vacancy_ids.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(value.vacancy_ids).size !== value.vacancy_ids.length
    || value.reported_total !== value.vacancy_ids.length
    || value.valid_zero !== (value.reported_total === 0)
    || !Array.isArray(value.pages) || value.pages.length === 0
    || value.pages.some((page) => page === null || typeof page !== 'object' || Array.isArray(page))
    || !Number.isSafeInteger(value.attempts) || value.attempts < 1 || value.attempts > 3
    || !Number.isSafeInteger(value.page_requests) || value.page_requests < value.pages.length) invalid();
  return value;
}

export function createAtsFetchPage({
  fetchImpl = fetch,
  timeoutMs = 20_000,
  userAgent = 'hiring-observatory/0.1 (portfolio research; contact via github.com/VatsalyaB)',
  redirect = 'follow',
} = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1
    || !['follow', 'manual'].includes(redirect)) {
    throw new Error('invalid ATS fetch configuration');
  }
  return async function fetchAtsPage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
        redirect,
        signal: controller.signal,
      });
      return {
        url: response.url || url,
        status: response.status,
        body: await response.text(),
      };
    } catch (error) {
      failAts(error?.name === 'AbortError' ? ATS_CODES.TIMEOUT : ATS_CODES.NETWORK, 1);
    } finally {
      clearTimeout(timer);
    }
  };
}

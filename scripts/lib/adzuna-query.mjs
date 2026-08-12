export const CODES = Object.freeze({
  AUTH: 'auth_failed',
  BUDGET: 'budget_exhausted',
  HTTP: 'http_error',
  PARSE: 'parse_failed',
  SHAPE: 'shape_invalid',
  TIMEOUT: 'timeout',
});

export class CaptureError extends Error {
  constructor(code, safeMessage, pageRequests = 0) {
    super(safeMessage);
    this.name = 'CaptureError';
    this.code = code;
    this.pageRequests = pageRequests;
  }
}

export function createAdzunaFetchPage({
  appId,
  appKey,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  userAgent,
}) {
  return async ({ country, query, page, resultsPerPage }) => {
    const url = new URL(`https://api.adzuna.com/v1/api/jobs/${encodeURIComponent(country)}/search/${encodeURIComponent(page)}`);
    url.searchParams.set('app_id', appId);
    url.searchParams.set('app_key', appKey);
    url.searchParams.set('results_per_page', String(resultsPerPage));
    url.searchParams.set('what', query);
    url.searchParams.set('content-type', 'application/json');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          headers: {
            Accept: 'application/json',
            ...(userAgent ? { 'User-Agent': userAgent } : {}),
          },
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new CaptureError(CODES.TIMEOUT, 'Adzuna request timed out');
        throw new CaptureError(CODES.HTTP, 'Adzuna request failed');
      }

      let body;
      let ok;
      let status;
      try {
        body = await response.text();
        ok = response.ok;
        status = response.status;
      } catch {
        if (controller.signal.aborted) throw new CaptureError(CODES.TIMEOUT, 'Adzuna request timed out');
        throw new CaptureError(CODES.HTTP, 'Adzuna request failed');
      }

      if (typeof body !== 'string' || typeof ok !== 'boolean' || !Number.isInteger(status)) {
        throw new CaptureError(CODES.HTTP, 'Adzuna request failed');
      }

      if (!ok) {
        const code = [401, 403].includes(status) ? CODES.AUTH : CODES.HTTP;
        throw new CaptureError(code, `Adzuna request failed: HTTP ${status} (${body.length}B body, not shown)`);
      }

      try {
        return JSON.parse(body);
      } catch {
        throw new CaptureError(CODES.PARSE, 'Adzuna response could not be parsed');
      }
    } finally {
      clearTimeout(timeout);
    }
  };
}

export async function collectAdzunaQuery({
  country,
  query,
  resultsPerPage,
  budgetRemaining,
  fetchPage,
}) {
  if (!Number.isInteger(budgetRemaining) || budgetRemaining < 0) {
    throw new CaptureError(CODES.BUDGET, 'Adzuna page budget invalid');
  }

  const records = [];
  let page = 1;
  let pageRequests = 0;
  let pagesFetched = 0;
  let reportedTotal;

  while (true) {
    if (pageRequests >= budgetRemaining) {
      throw new CaptureError(CODES.BUDGET, 'Adzuna page budget exhausted', pageRequests);
    }

    pageRequests += 1;
    let data;
    try {
      data = await fetchPage({ country, query, page, resultsPerPage });
    } catch (error) {
      const code = error instanceof CaptureError ? error.code : CODES.HTTP;
      throw new CaptureError(code, 'Adzuna page request failed', pageRequests);
    }

    if (!Number.isInteger(data?.count) || data.count < 0 || !Array.isArray(data.results)
      || data.results.length > resultsPerPage) {
      throw new CaptureError(CODES.SHAPE, 'Adzuna page shape invalid', pageRequests);
    }

    if (reportedTotal !== undefined && data.count !== reportedTotal) {
      throw new CaptureError(CODES.SHAPE, 'Adzuna page shape invalid', pageRequests);
    }
    reportedTotal ??= data.count;
    pagesFetched += 1;
    records.push(...data.results);
    if (records.length > reportedTotal) {
      throw new CaptureError(CODES.SHAPE, 'Adzuna page shape invalid', pageRequests);
    }

    if (page === 1 && data.count === 0 && data.results.length === 0) {
      return { records, reportedTotal, pagesFetched, pageRequests, termination: 'valid_zero' };
    }
    if (data.results.length === 0) {
      if (records.length !== reportedTotal) {
        throw new CaptureError(CODES.SHAPE, 'Adzuna page shape invalid', pageRequests);
      }
      return { records, reportedTotal, pagesFetched, pageRequests, termination: 'empty_page' };
    }
    if (data.results.length < resultsPerPage) {
      if (records.length !== reportedTotal) {
        throw new CaptureError(CODES.SHAPE, 'Adzuna page shape invalid', pageRequests);
      }
      return { records, reportedTotal, pagesFetched, pageRequests, termination: 'short_page' };
    }
    page += 1;
  }
}

import {
  ATS_CODES,
  AtsProviderError,
  assertAtsEmployer,
  buildBoardCapture,
  failAts,
  readAtsJsonPage,
  stableVacancyIds,
  validateBoardCapture,
} from '../scripts/lib/ats-provider.mjs';

export const SMARTRECRUITERS_LIMIT = 100;
const MAX_PAGES = 500;
const MAX_SNAPSHOT_ATTEMPTS = 3;

export function smartRecruitersUrl(boardId, offset, limit = SMARTRECRUITERS_LIMIT) {
  const url = new URL(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(boardId)}/postings`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  return url.toString();
}

async function collectSmartRecruitersAttempt({
  employer,
  fetchPage,
  qualification = false,
  limit = SMARTRECRUITERS_LIMIT,
  maxPages = MAX_PAGES,
}) {
  assertAtsEmployer(employer, 'smartrecruiters');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SMARTRECRUITERS_LIMIT) {
    failAts(ATS_CODES.SHAPE);
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) failAts(ATS_CODES.SHAPE);

  const pages = [];
  const ids = [];
  const seen = new Set();
  let offset = 0;
  let reportedTotal = null;

  while (reportedTotal === null || ids.length < reportedTotal) {
    if (pages.length >= maxPages) failAts(ATS_CODES.PAGE_LIMIT, pages.length);
    const pageRequests = pages.length + 1;
    const page = await readAtsJsonPage(
      fetchPage,
      smartRecruitersUrl(employer.board_id, offset, limit),
      pageRequests,
    );
    if (!Number.isSafeInteger(page.offset) || page.offset !== offset
      || !Number.isSafeInteger(page.limit) || page.limit !== limit) {
      failAts(ATS_CODES.OFFSET, pageRequests);
    }
    if (!Number.isSafeInteger(page.totalFound) || page.totalFound < 0 || !Array.isArray(page.content)
      || page.content.length > limit) failAts(ATS_CODES.SHAPE, pageRequests);
    if (reportedTotal === null) reportedTotal = page.totalFound;
    else if (page.totalFound !== reportedTotal) {
      failAts(ATS_CODES.TOTAL_CHANGED, pageRequests, {
        offset, initial_total: reportedTotal, changed_total: page.totalFound,
      });
    }

    const pageIds = stableVacancyIds(page.content, 'id', pageRequests);
    for (const row of page.content) {
      if (row.company === null || typeof row.company !== 'object' || Array.isArray(row.company)
        || typeof row.company.identifier !== 'string'
        || row.company.identifier.toLowerCase() !== employer.board_id.toLowerCase()) {
        failAts(ATS_CODES.BINDING, pageRequests);
      }
    }
    for (const id of pageIds) {
      if (seen.has(id)) failAts(ATS_CODES.DUPLICATE, pageRequests);
      seen.add(id);
      ids.push(id);
    }
    pages.push(page);

    if (ids.length > reportedTotal) failAts(ATS_CODES.SHAPE, pageRequests);
    if (ids.length === reportedTotal) break;
    if (page.content.length === 0) failAts(ATS_CODES.INCOMPLETE, pageRequests);
    offset += page.content.length;
  }

  return buildBoardCapture({ provider: 'smartrecruiters', employer, ids, pages, qualification });
}

export default async function collectSmartRecruiters(options) {
  let pageRequests = 0;
  const totalChanges = [];
  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const capture = await collectSmartRecruitersAttempt(options);
      pageRequests += capture.page_requests;
      return validateBoardCapture({
        ...capture,
        attempts: attempt,
        page_requests: pageRequests,
      });
    } catch (error) {
      if (!(error instanceof AtsProviderError)) throw error;
      pageRequests += error.pageRequests;
      if (error.code === ATS_CODES.TOTAL_CHANGED && error.diagnostic) {
        totalChanges.push({
          attempt,
          page_requests: error.pageRequests,
          offset: error.diagnostic.offset,
          initial_total: error.diagnostic.initial_total,
          changed_total: error.diagnostic.changed_total,
        });
      }
      if (error.code !== ATS_CODES.TOTAL_CHANGED || attempt === MAX_SNAPSHOT_ATTEMPTS) {
        throw new AtsProviderError(error.code, pageRequests, attempt,
          error.code === ATS_CODES.TOTAL_CHANGED ? {
            attempts: attempt,
            page_requests: pageRequests,
            total_changes: totalChanges,
          } : null);
      }
    }
  }
  throw new AtsProviderError(ATS_CODES.TOTAL_CHANGED, pageRequests, MAX_SNAPSHOT_ATTEMPTS, {
    attempts: MAX_SNAPSHOT_ATTEMPTS,
    page_requests: pageRequests,
    total_changes: totalChanges,
  });
}

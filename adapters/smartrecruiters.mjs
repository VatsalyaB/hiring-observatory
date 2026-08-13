import {
  ATS_CODES,
  assertAtsEmployer,
  buildBoardCapture,
  failAts,
  readAtsJsonPage,
  stableVacancyIds,
} from '../scripts/lib/ats-provider.mjs';

export const SMARTRECRUITERS_LIMIT = 100;
const MAX_PAGES = 500;

export function smartRecruitersUrl(boardId, offset, limit = SMARTRECRUITERS_LIMIT) {
  const url = new URL(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(boardId)}/postings`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  return url.toString();
}

export default async function collectSmartRecruiters({
  employer,
  fetchPage,
  qualification = false,
  limit = SMARTRECRUITERS_LIMIT,
}) {
  assertAtsEmployer(employer, 'smartrecruiters');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SMARTRECRUITERS_LIMIT) {
    failAts(ATS_CODES.SHAPE);
  }

  const pages = [];
  const ids = [];
  const seen = new Set();
  let offset = 0;
  let reportedTotal = null;

  while (reportedTotal === null || ids.length < reportedTotal) {
    if (pages.length >= MAX_PAGES) failAts(ATS_CODES.PAGE_LIMIT, pages.length);
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
    else if (page.totalFound !== reportedTotal) failAts(ATS_CODES.TOTAL_CHANGED, pageRequests);

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

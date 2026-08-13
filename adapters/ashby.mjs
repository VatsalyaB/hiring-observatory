import {
  ATS_CODES,
  assertAtsEmployer,
  buildBoardCapture,
  failAts,
  readAtsJsonPage,
  stableVacancyIds,
} from '../scripts/lib/ats-provider.mjs';

export function ashbyUrl(boardId) {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardId)}?includeCompensation=true`;
}

export default async function collectAshby({ employer, fetchPage, qualification = false }) {
  assertAtsEmployer(employer, 'ashby');
  const page = await readAtsJsonPage(fetchPage, ashbyUrl(employer.board_id), 1);
  if (page.apiVersion !== '1' || !Array.isArray(page.jobs)) failAts(ATS_CODES.SHAPE, 1);
  const ids = stableVacancyIds(page.jobs, 'id', 1);
  return buildBoardCapture({ provider: 'ashby', employer, ids, pages: [page], qualification });
}

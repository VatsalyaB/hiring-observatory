import {
  ATS_CODES,
  assertAtsEmployer,
  buildBoardCapture,
  failAts,
  readAtsJsonPage,
  stableVacancyIds,
} from '../scripts/lib/ats-provider.mjs';

export function greenhouseUrl(boardId) {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardId)}/jobs?content=true`;
}

export default async function collectGreenhouse({ employer, fetchPage, qualification = false }) {
  assertAtsEmployer(employer, 'greenhouse');
  const page = await readAtsJsonPage(fetchPage, greenhouseUrl(employer.board_id), 1);
  if (!Array.isArray(page.jobs)
    || page.meta === null || typeof page.meta !== 'object' || Array.isArray(page.meta)
    || !Number.isSafeInteger(page.meta.total) || page.meta.total < 0
    || page.meta.total !== page.jobs.length) failAts(ATS_CODES.SHAPE, 1);
  const ids = stableVacancyIds(page.jobs, 'id', 1);
  return buildBoardCapture({ provider: 'greenhouse', employer, ids, pages: [page], qualification });
}

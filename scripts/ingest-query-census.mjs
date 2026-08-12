import { appendFile } from 'node:fs/promises';
import adaptAdzuna, { REQUIRED_FIELDS } from '../adapters/adzuna.mjs';
import { validateCapture } from '../adapters/validate.mjs';
import { CODES, createAdzunaFetchPage } from './lib/adzuna-query.mjs';
import { manifestPath, writeManifestAtomic } from './lib/capture-manifest.mjs';
import { runQueryCensus } from './lib/query-census.mjs';
import { loadQuerySet } from './lib/query-set.mjs';
import { utcPartition } from './lib/verify.mjs';

const USER_AGENT = 'hiring-observatory/0.1 (portfolio research; github.com/VatsalyaB)';

function provenance(now = new Date()) {
  const localRunId = `local-${now.toISOString().replace(/[^0-9]/g, '')}-${process.pid}`;
  return {
    event_name: process.env.GITHUB_EVENT_NAME ?? 'local',
    run_id: process.env.GITHUB_RUN_ID ?? localRunId,
    run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    sha: process.env.GITHUB_SHA ?? '0000000',
  };
}

async function writeOutputs({ failed, wrote, pageRequests }) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `failed=${failed}\nwrote=${wrote}\npage_requests=${pageRequests}\n`,
    'utf8',
  );
}

async function main() {
  const now = new Date();
  const querySet = await loadQuerySet('config/query-sets/nz-ai-data-v1.json');
  const partition = utcPartition(now);
  const run = provenance(now);
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    const statuses = querySet.queries.map((query) => ({
      query_id: query.id,
      status: 'failed',
      page_requests: 0,
      record_count: null,
      error_code: CODES.AUTH,
    }));
    await writeManifestAtomic(
      manifestPath('.', partition, run.run_id, run.run_attempt),
      {
        schema_version: 1,
        collector: 'adzuna-query-census',
        partition,
        query_set: querySet.id,
        run,
        started_at: now.toISOString(),
        finished_at: now.toISOString(),
        page_requests: 0,
        daily_page_budget: querySet.daily_page_budget,
        queries: statuses,
      },
    );
    console.error(CODES.AUTH);
    await writeOutputs({ failed: statuses.length, wrote: 0, pageRequests: 0 });
    process.exitCode = 1;
    return;
  }

  const result = await runQueryCensus({
    rawRoot: '.',
    querySet,
    partition,
    provenance: run,
    fetchPage: createAdzunaFetchPage({ appId, appKey, userAgent: USER_AGENT }),
    adapt: adaptAdzuna,
    requiredFields: REQUIRED_FIELDS,
    validateCapture,
    now: () => new Date(),
  });

  for (const status of result.statuses) {
    console.log([status.query_id, status.status, status.error_code].filter(Boolean).join(' '));
  }
  await writeOutputs(result);
  process.exitCode = result.failed > 0 ? 1 : 0;
}

try {
  await main();
} catch {
  await writeOutputs({ failed: 1, wrote: 0, pageRequests: 0 }).catch(() => {});
  console.error('write_failed');
  process.exitCode = 1;
}

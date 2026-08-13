import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import collectGreenhouse, { greenhouseUrl } from '../adapters/greenhouse.mjs';
import collectAshby, { ashbyUrl } from '../adapters/ashby.mjs';
import collectSmartRecruiters, {
  SMARTRECRUITERS_LIMIT,
  smartRecruitersUrl,
} from '../adapters/smartrecruiters.mjs';
import { ATS_CODES, AtsProviderError, validateBoardCapture } from './lib/ats-provider.mjs';

async function json(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

function employer(provider, boardId) {
  return { id: `synthetic-${provider}`, provider, board_id: boardId, status: 'qualified' };
}

function page(url, body, overrides = {}) {
  return { url, status: 200, body: JSON.stringify(body), ...overrides };
}

function responder(expectedUrl, body) {
  return async (url) => {
    assert.equal(url, expectedUrl);
    return page(url, body);
  };
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => error instanceof AtsProviderError && error.code === code);
}

test('invented fixtures exercise complete captures for all supported providers', async () => {
  const greenhouse = await json('adapters/fixtures/ats/greenhouse.synthetic.json');
  const ashby = await json('adapters/fixtures/ats/ashby.synthetic.json');
  const smartRecruiters = [
    await json('adapters/fixtures/ats/smartrecruiters-page-1.synthetic.json'),
    await json('adapters/fixtures/ats/smartrecruiters-page-2.synthetic.json'),
  ];
  for (const fixture of [greenhouse, ashby, ...smartRecruiters]) {
    assert.equal(fixture.fixture_kind, 'synthetic');
  }

  const captures = [
    await collectGreenhouse({
      employer: employer('greenhouse', 'example-board'),
      qualification: true,
      fetchPage: responder(greenhouseUrl('example-board'), greenhouse.response),
    }),
    await collectAshby({
      employer: employer('ashby', 'example-board'),
      qualification: true,
      fetchPage: responder(ashbyUrl('example-board'), ashby.response),
    }),
    await collectSmartRecruiters({
      employer: employer('smartrecruiters', 'example-company'),
      qualification: true,
      limit: 2,
      fetchPage: async (url) => page(
        url,
        smartRecruiters[Number(new URL(url).searchParams.get('offset')) === 0 ? 0 : 1].response,
      ),
    }),
  ];

  assert.deepEqual(captures.map((capture) => capture.reported_total), [2, 2, 3]);
  for (const capture of captures) assert.equal(validateBoardCapture(capture), capture);
});

test('provider failures expose stable codes without source response detail', async () => {
  const target = greenhouseUrl('example-board');
  const sourceDetail = 'SOURCE-RESPONSE-MUST-NOT-ESCAPE';
  await rejectsCode(() => collectGreenhouse({
    employer: employer('greenhouse', 'example-board'),
    qualification: true,
    fetchPage: async () => ({ url: target, status: 503, body: sourceDetail }),
  }), ATS_CODES.HTTP);
  await rejectsCode(() => collectGreenhouse({
    employer: employer('greenhouse', 'example-board'),
    qualification: true,
    fetchPage: async () => ({ url: target, status: 200, body: '{broken' }),
  }), ATS_CODES.JSON);
  try {
    await collectGreenhouse({
      employer: employer('greenhouse', 'example-board'),
      qualification: true,
      fetchPage: async () => ({ url: target, status: 500, body: sourceDetail }),
    });
    assert.fail('expected provider failure');
  } catch (error) {
    assert.doesNotMatch(error.message, new RegExp(sourceDetail));
  }
});

test('SmartRecruiters defaults remain bounded and pagination-aware', () => {
  assert.equal(SMARTRECRUITERS_LIMIT, 100);
  assert.match(smartRecruitersUrl('example-company', 0), /limit=100/);
  assert.match(smartRecruitersUrl('example-company', 100), /offset=100/);
});

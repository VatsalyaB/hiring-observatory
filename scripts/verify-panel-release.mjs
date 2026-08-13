import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { buildPanelRelease, validatePanelRelease } from './lib/panel-release.mjs';

const providers = ['greenhouse', 'ashby', 'smartrecruiters'];
const employers = Array.from({ length: 3 }, (_, index) => ({
  id: `employer-${index + 1}`,
  provider: providers[index],
  sector: index === 1 ? 'finance' : 'technology',
  status: 'qualified',
}));
const registry = { employers };
const cohort = {
  id: 'nz-ats-2026q4-v1',
  country: 'nz',
  effective_from: '2026-10-01',
  effective_to: '2026-12-31',
  members: employers.map((item) => item.id),
};

function day(partition, counts = [4, 0, 2], overrides = {}) {
  return {
    partition,
    comparable: true,
    failed: 0,
    missing: 0,
    captures: employers.map((employer, index) => ({ employer_id: employer.id, reported_total: counts[index] })),
    ...overrides,
  };
}

function period(id, start, end, days, phase = 'measurement') {
  return { id, label: id.replaceAll('-', ' '), phase, start, end, days };
}

function build(overrides = {}) {
  return buildPanelRelease({
    releaseId: 'ats-panel-pilot-2026-08-13',
    generatedAt: '2026-08-13T02:00:00.000Z',
    registry,
    cohort,
    periods: [period('pilot-2026-08-13', '2026-08-13', '2026-08-13', [day('2026-08-13')], 'pilot')],
    now: new Date('2026-08-13T02:00:00.000Z'),
    ...overrides,
  });
}

test('builds deterministic aggregate-only pilot metrics', () => {
  const release = build();
  assert.equal(validatePanelRelease(release), release);
  assert.equal(release.readiness.state, 'pilot_only');
  assert.equal(release.readiness.qualified_employers, 3);
  assert.deepEqual(release.composition.providers.map((item) => item.id), providers.slice().sort());
  assert.equal(release.demand.find((item) => item.provider === 'all' && item.sector === 'all').listing_count, 6);
  assert.equal(release.employer_breadth.find((item) => item.provider === 'all' && item.sector === 'all').employers_with_openings, 2);
  assert.deepEqual(release.trend_gate, { eligible: false, reason: 'pilot_period' });
  assert.doesNotMatch(JSON.stringify(release), /employer-1|employer-2|employer-3/);
});

test('rejects incomplete days, wrong measurement dates, and duplicate captures', () => {
  assert.throws(() => build({ periods: [period('q4-october', '2026-10-01', '2026-10-01', [day('2026-10-01', [1, 2, 3], { comparable: false, missing: 1 })])] }), /complete/i);
  assert.throws(() => build({ periods: [period('q4-wrong', '2026-09-30', '2026-09-30', [day('2026-09-30')])] }), /effective/i);
  const duplicate = day('2026-10-01');
  duplicate.captures.push({ ...duplicate.captures[0] });
  assert.throws(() => build({ periods: [period('q4-duplicate', '2026-10-01', '2026-10-01', [duplicate])] }), /capture/i);
});

test('time and compatibility gates refuse early or mixed trend claims', () => {
  const periods = [
    period('q4-october', '2026-10-01', '2026-10-31', [day('2026-10-01')]),
    period('q4-november', '2026-11-01', '2026-11-30', [day('2026-11-01', [5, 1, 3])]),
  ];
  assert.deepEqual(build({ periods, now: new Date('2026-12-31T23:59:59.000Z') }).trend_gate, { eligible: false, reason: 'q4_time_lock' });
  assert.deepEqual(build({ periods, now: new Date('2027-01-01T00:00:00.000Z') }).trend_gate, { eligible: true, reason: null });
  assert.deepEqual(build({ periods: periods.slice(0, 1), now: new Date('2027-01-01T00:00:00.000Z') }).trend_gate, { eligible: false, reason: 'insufficient_periods' });
});

test('closed validator rejects listing-like and operational leakage recursively', () => {
  const cases = [
    ['vacancy_id', 'abc'],
    ['title', 'Data Engineer'],
    ['description', 'source body'],
    ['company_name', 'Specific Employer'],
    ['employer_vacancy_count', 2],
    ['advert_url', 'https://example.invalid/job'],
    ['source_payload', {}],
    ['run_id', '123'],
    ['manifest_path', 'raw/_manifests/x'],
    ['api_key', 'secret'],
    ['error_body', 'private'],
    ['repository_url', 'not-a-public-release-field'],
  ];
  for (const [key, value] of cases) {
    const release = structuredClone(build());
    release.insights[0][key] = value;
    assert.throws(() => validatePanelRelease(release), /invalid panel release/i, key);
  }
});

test('schema is closed and a planted forbidden-field mutation is detected', () => {
  const release = build();
  assert.throws(() => validatePanelRelease({ ...release, extra: true }), /invalid panel release/i);
  const planted = structuredClone(release);
  planted.insights[0].title = 'should never publish';
  assert.throws(() => validatePanelRelease(planted), /invalid panel release/i);
});

test('committed public pilot bundle passes the closed validator', async () => {
  const path = existsSync(resolve('public/docs/evidence/data/pilot.json'))
    ? resolve('public/docs/evidence/data/pilot.json')
    : resolve('docs/evidence/data/pilot.json');
  const value = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(validatePanelRelease(value), value);
  assert.equal(value.readiness.state, 'pilot_only');
  assert.equal(value.trend_gate.eligible, false);
});

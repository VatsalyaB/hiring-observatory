import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { test } from 'node:test';
import { buildPanelRelease, validatePanelRelease } from './lib/panel-release.mjs';

const operationalVerifierAvailable = existsSync(new URL('./build-panel-release.mjs', import.meta.url));
const { buildReleaseForPartition } = operationalVerifierAvailable ? await import('./build-panel-release.mjs') : {};
const { runAtsPanelCapture } = operationalVerifierAvailable ? await import('./lib/ats-capture.mjs') : {};
const operationalTest = operationalVerifierAvailable ? test : test.skip;

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
const roots = [];
const BEFORE_TREND_RELEASE = new Date('2026-12-31T23:59:59.000Z');
const AT_TREND_RELEASE = new Date('2027-01-01T00:00:00.000Z');
after(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));


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

function completeWeeks(start, counts) {
  const first = new Date(`${start}T00:00:00.000Z`);
  return Array.from({ length: 28 }, (_, index) => {
    const partition = new Date(first.valueOf() + index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return day(partition, counts);
  });
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

test('release insight wording is phase-neutral', () => {
  assert.match(build().insights[0].summary, /complete panel captures/);
  assert.doesNotMatch(build().insights[0].summary, /pilot captures/);
});

function allocationRelease(counts) {
  const rows = Object.entries(counts).flatMap(([provider, count]) => (
    Array.from({ length: count }, (_, index) => ({
      id: `${provider}-allocation-${index + 1}`,
      provider,
      sector: 'technology',
      status: 'qualified',
    }))
  ));
  const selectedCohort = {
    id: 'nz-ats-2026q4-v2',
    country: 'nz',
    effective_from: '2026-10-01',
    effective_to: '2026-12-31',
    members: rows.map((row) => row.id).sort(),
  };
  return buildPanelRelease({
    releaseId: 'allocation-policy-check',
    generatedAt: '2026-08-14T02:00:00.000Z',
    registry: { employers: rows },
    cohort: selectedCohort,
    periods: [period('allocation-pilot', '2026-08-14', '2026-08-14', [{
      partition: '2026-08-14',
      comparable: true,
      failed: 0,
      missing: 0,
      captures: rows.map((row) => ({ employer_id: row.id, reported_total: 1 })),
    }], 'pilot')],
  });
}

test('release readiness uses the exact supply-aware provider allocation policy', () => {
  assert.equal(allocationRelease({ greenhouse: 18, ashby: 8, smartrecruiters: 19 }).readiness.state, 'production_ready');
  assert.equal(allocationRelease({ greenhouse: 20, ashby: 8, smartrecruiters: 17 }).readiness.state, 'pilot_only');
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
    period('q4-october', '2026-10-01', '2026-10-28', completeWeeks('2026-10-01')),
    period('q4-november', '2026-11-01', '2026-11-28', completeWeeks('2026-11-01', [5, 1, 3])),
  ];
  assert.deepEqual(build({ periods, generatedAt: '2026-12-31T23:59:59.000Z', now: BEFORE_TREND_RELEASE }).trend_gate, { eligible: false, reason: 'q4_time_lock' });
  assert.throws(() => build({
    periods,
    generatedAt: '2027-01-01T00:00:00.000Z',
    now: BEFORE_TREND_RELEASE,
  }), /future/i);
  assert.deepEqual(build({ periods, generatedAt: '2027-01-01T00:00:00.000Z', now: AT_TREND_RELEASE }).trend_gate, { eligible: true, reason: null });
  assert.deepEqual(build({
    periods: periods.map((item) => ({ ...item, days: item.days.slice(0, 1), end: item.days[0].partition })),
    generatedAt: '2027-01-01T00:00:00.000Z',
    now: AT_TREND_RELEASE,
  }).trend_gate, { eligible: false, reason: 'insufficient_complete_weeks' });

  const mixedCohorts = build({ periods, generatedAt: '2027-01-01T00:00:00.000Z', now: AT_TREND_RELEASE });
  mixedCohorts.periods[1].cohort_id = 'nz-ats-2026q4-v2';
  mixedCohorts.trend_gate = { eligible: false, reason: 'incompatible_cohorts' };
  assert.throws(() => validatePanelRelease(mixedCohorts, { now: AT_TREND_RELEASE }), /invalid panel release/i);

  assert.deepEqual(build({ periods: periods.slice(0, 1), generatedAt: '2027-01-01T00:00:00.000Z', now: AT_TREND_RELEASE }).trend_gate, { eligible: false, reason: 'insufficient_periods' });
});

test('period construction rejects a missing middle date', () => {
  const missingMiddle = completeWeeks('2026-10-01');
  missingMiddle.splice(10, 1);
  assert.throws(() => build({
    periods: [period('q4-october-gap', '2026-10-01', '2026-10-28', missingMiddle)],
  }), /complete capture days/i);
});

test('period construction rejects a padded range', () => {
  assert.throws(() => build({
    periods: [period('q4-october-padded', '2026-10-01', '2026-10-29', completeWeeks('2026-10-01'))],
  }), /complete capture days/i);
});

test('validator reconciles serialized period spans and day counts', () => {
  const periods = [
    period('q4-october', '2026-10-01', '2026-10-28', completeWeeks('2026-10-01')),
    period('q4-november', '2026-11-01', '2026-11-28', completeWeeks('2026-11-01')),
  ];
  const release = build({ periods, generatedAt: '2027-01-01T00:00:00.000Z', now: AT_TREND_RELEASE });
  release.periods[0].end = '2026-10-29';
  assert.throws(() => validatePanelRelease(release, { now: AT_TREND_RELEASE }), /invalid panel release/i);
});

test('validator rejects mutated eligible trend claims without complete release evidence', () => {
  const periods = [
    period('q4-october', '2026-10-01', '2026-10-28', completeWeeks('2026-10-01')),
    period('q4-november', '2026-11-01', '2026-11-28', completeWeeks('2026-11-01', [5, 1, 3])),
  ];
  const release = build({ periods, generatedAt: '2027-01-01T00:00:00.000Z', now: AT_TREND_RELEASE });

  for (const mutate of [
    (value) => value.periods.pop(),
    (value) => { value.periods[0].phase = 'pilot'; },
    (value) => { value.periods[0].phase = 'unknown'; },
    (value) => { value.generated_at = '2026-12-31T23:59:59.000Z'; },
    (value) => { value.periods[1].cohort_id = 'nz-ats-2026q4-v2'; },
    (value) => { value.periods[1].id = value.periods[0].id; },
    (value) => { value.coverage[0] = { ...value.coverage[0], complete_capture_units: 83, coverage_rate: 0.99 }; },
    (value) => value.coverage.push({ ...value.coverage[0] }),
  ]) {
    const mutated = structuredClone(release);
    mutate(mutated);
    mutated.trend_gate = { eligible: true, reason: null };
    assert.throws(() => validatePanelRelease(mutated, { now: AT_TREND_RELEASE }), /invalid panel release/i);
  }
});

test('validator rejects missing or orphan coverage even with a locked trend gate', () => {
  const periods = [
    period('q4-october', '2026-10-01', '2026-10-28', completeWeeks('2026-10-01')),
    period('q4-november', '2026-11-01', '2026-11-28', completeWeeks('2026-11-01', [5, 1, 3])),
  ];
  const release = build({ periods, generatedAt: '2027-01-01T00:00:00.000Z', now: AT_TREND_RELEASE });
  for (const mutate of [
    (value) => value.coverage.pop(),
    (value) => value.coverage.push({ ...value.coverage[0], period_id: 'orphan-period' }),
  ]) {
    const mutated = structuredClone(release);
    mutate(mutated);
    mutated.trend_gate = { eligible: false, reason: 'incomplete_support' };
    assert.throws(() => validatePanelRelease(mutated, { now: AT_TREND_RELEASE }), /invalid panel release/i);
  }
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
function scheduledEmployer(id, provider) {
  return { id, name: id, sector: 'technology', provider, board_id: `${id}-board`, candidate_source: 'official-careers-page', discovered_on: '2026-08-01', endpoint_verified_at: '2026-08-12T00:00:00.000Z', verification_result: 'complete_nonempty', verification_record_count: 1, nz_evidence_date: '2026-08-11', nz_evidence_basis: 'explicit_nz_location', real_fixture: `${provider}/${id}.json`, status: 'qualified', reason: null };
}

async function scheduledReleaseRoot() {
  const root = await mkdtemp(join(tmpdir(), 'ats-release-schedule-'));
  roots.push(root);
  const rows = ['greenhouse', 'ashby', 'smartrecruiters'].map((provider, index) => scheduledEmployer(`scheduled-${index + 1}`, provider));
  const registryValue = { schema_version: 1, admission_policy: 'nz-ats-panel-v1', employers: rows };
  const v1Value = { schema_version: 1, id: 'nz-ats-2026q4-v1', country: 'nz', effective_from: '2026-10-01', effective_to: '2026-12-31', admission_policy: 'nz-ats-panel-v1', predecessor: null, change_reason: 'Initial release test cohort.', members: rows.map((row) => row.id) };
  const v2Value = { ...v1Value, id: 'nz-ats-2026q4-v2', predecessor: v1Value.id, change_reason: 'Activated release test cohort.' };
  const write = async (path, value) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, `${JSON.stringify(value)}\n`); };
  await write(join(root, 'config', 'ats-employers.json'), registryValue);
  await write(join(root, 'config', 'ats-panel.json'), { schema_version: 1, activations: [{ cohort_id: v1Value.id, active_from: '2026-08-13' }, { cohort_id: v2Value.id, active_from: '2026-08-15' }] });
  await write(join(root, 'config', 'cohorts', `${v1Value.id}.json`), v1Value);
  await write(join(root, 'config', 'cohorts', `${v2Value.id}.json`), v2Value);
  return { root, registryValue, v1Value, v2Value };
}

operationalTest('release consumer rejects a future generated timestamp using the system clock', async () => {
  const fixture = await scheduledReleaseRoot();
  await assert.rejects(() => buildReleaseForPartition({
    root: fixture.root,
    partition: '2026-08-14',
    phase: 'pilot',
    releaseId: 'future-generated-at',
    generatedAt: '2099-01-01T00:00:00.000Z',
    output: join(fixture.root, 'future.json'),
  }), /future/i);
});

function collector({ employer }) {
  const id = `${employer.id}-job`;
  const pages = employer.provider === 'greenhouse' ? [{ jobs: [{ id }], meta: { total: 1 } }] : employer.provider === 'ashby' ? [{ apiVersion: '1', jobs: [{ id }] }] : [{ offset: 0, limit: 100, totalFound: 1, content: [{ id }] }];
  return {
    provider: employer.provider,
    board_id: employer.board_id,
    complete: true,
    valid_zero: false,
    reported_total: 1,
    vacancy_ids: [id],
    pages,
    attempts: 1,
    page_requests: 1,
  };
}

operationalTest('release consumer resolves scheduled cohorts across activation', async () => {
  const fixture = await scheduledReleaseRoot();
  for (const [partition, cohort] of [['2026-08-14', fixture.v1Value], ['2026-08-15', fixture.v2Value]]) {
    await runAtsPanelCapture({ rawRoot: fixture.root, registry: fixture.registryValue, cohort, partition, provenance: { event_name: 'schedule', run_id: partition.replaceAll('-', ''), run_attempt: 1, sha: 'a'.repeat(40) }, collectors: Object.fromEntries(['greenhouse', 'ashby', 'smartrecruiters'].map((provider) => [provider, collector])), now: () => new Date(`${partition}T01:00:00.000Z`) });
    const release = await buildReleaseForPartition(
      { root: fixture.root, partition, phase: 'pilot', releaseId: `release-${partition.replaceAll('-', '')}`, generatedAt: `${partition}T02:00:00.000Z`, output: join(fixture.root, `${partition}.json`) },
      { clock: () => new Date(`${partition}T02:00:00.000Z`) },
    );
    assert.equal(release.study.cohort_id, cohort.id);
  }
});

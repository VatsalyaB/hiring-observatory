import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const evidenceRoot = existsSync(resolve('public/docs/evidence'))
  ? resolve('public/docs/evidence')
  : resolve('docs/evidence');
const { createDashboardModel, selectEvidence } = await import(
  pathToFileURL(resolve(evidenceRoot, 'model.mjs')).href
);
const committedRelease = JSON.parse(await readFile(resolve(evidenceRoot, 'data/pilot.json'), 'utf8'));
const release = {
  readiness: { state: 'pilot_only' },
  study: { id: 'fixture-study' },
  periods: [{ id: 'pilot-synthetic' }],
  coverage: [],
  composition: {
    providers: [{ id: 'ashby' }, { id: 'greenhouse' }, { id: 'smartrecruiters' }],
    sectors: [{ id: 'finance' }, { id: 'technology' }],
  },
  insights: [],
  demand: [{
    metric_id: 'demand-pilot-synthetic-greenhouse-technology',
    period_id: 'pilot-synthetic',
    provider: 'greenhouse',
    sector: 'technology',
    listing_count: 4,
  }],
  employer_breadth: [{
    metric_id: 'breadth-pilot-synthetic-greenhouse-technology',
    period_id: 'pilot-synthetic',
    provider: 'greenhouse',
    sector: 'technology',
    eligible_employers: 1,
    employers_with_openings: 1,
    rate: 1,
  }],
  trend_gate: { eligible: false, reason: 'pilot_period' },
};

test('dashboard model exposes safe filter choices and readiness', () => {
  const model = createDashboardModel(release);
  assert.equal(model.readiness.state, 'pilot_only');
  assert.deepEqual(model.filters.periods, ['pilot-synthetic']);
  assert.deepEqual(model.filters.providers, ['all', 'ashby', 'greenhouse', 'smartrecruiters']);
  assert.deepEqual(model.filters.sectors, ['all', 'finance', 'technology']);
});

test('listing and employer weighting select the correct aggregate cell', () => {
  const listing = selectEvidence(release, { period: 'pilot-synthetic', provider: 'greenhouse', sector: 'technology', weighting: 'listings' });
  const breadth = selectEvidence(release, { period: 'pilot-synthetic', provider: 'greenhouse', sector: 'technology', weighting: 'employers' });
  assert.equal(listing.value, 4);
  assert.equal(listing.denominator, 'complete board listings');
  assert.equal(breadth.value, 1);
  assert.equal(breadth.denominator, 'eligible cohort employers');
  assert.match(listing.tooltip, /demand-pilot-synthetic-greenhouse-technology/);
});

test('no filter can unlock a closed trend gate', () => {
  for (const provider of ['all', 'ashby', 'greenhouse', 'smartrecruiters']) {
    const selected = selectEvidence(release, { period: 'pilot-synthetic', provider, sector: 'all', weighting: 'listings' });
    assert.equal(selected.trend.eligible, false);
    assert.equal(selected.trend.reason, 'pilot_period');
  }
});

test('committed public release is selectable across every published aggregate cell', () => {
  const model = createDashboardModel(committedRelease);
  assert.equal(model.readiness.state, 'pilot_only');
  for (const metric of committedRelease.demand) {
    const selected = selectEvidence(committedRelease, {
      period: metric.period_id,
      provider: metric.provider,
      sector: metric.sector,
      weighting: 'listings',
    });
    assert.equal(selected.missing, false);
    assert.equal(selected.value, metric.listing_count);
  }
  for (const metric of committedRelease.employer_breadth) {
    const selected = selectEvidence(committedRelease, {
      period: metric.period_id,
      provider: metric.provider,
      sector: metric.sector,
      weighting: 'employers',
    });
    assert.equal(selected.missing, false);
    assert.equal(selected.value, metric.employers_with_openings);
  }
});

test('markup has semantic landmarks, labelled controls, live status, and methodology disclosure', async () => {
  const html = await readFile(resolve(evidenceRoot, 'index.html'), 'utf8');
  const css = await readFile(resolve(evidenceRoot, 'styles.css'), 'utf8');
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  for (const element of ['<header', '<main', '<footer', '<form', '<details']) assert.match(html, new RegExp(element));
  for (const control of ['period-filter', 'provider-filter', 'sector-filter', 'weighting-filter']) {
    assert.match(html, new RegExp(`<label[^>]+for=["']${control}`));
  }
  assert.match(html, /aria-live="polite"/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:|<link[^>]+href=["']https?:/i);
});

test('dashboard source has safe missing-data handling and no trend override', async () => {
  const source = await readFile(resolve(evidenceRoot, 'dashboard.mjs'), 'utf8');
  assert.match(source, /catch\s*\(/);
  assert.match(source, /trend\.eligible/);
  assert.doesNotMatch(source, /trend\.eligible\s*=|localStorage|document\.cookie|fetch\(["']https?:/);
});

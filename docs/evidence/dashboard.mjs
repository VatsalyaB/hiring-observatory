import { createDashboardModel, selectEvidence } from './model.mjs';

const $ = (selector) => document.querySelector(selector);
const pretty = (value) => value.replaceAll('_', ' ').replaceAll('-', ' ');
const option = (value) => `<option value="${value}">${pretty(value)}</option>`;

function bars(target, rows) {
  target.innerHTML = rows.map((row) => `<div class="bar-row"><span>${pretty(row.id)}</span><span class="bar-track"><span class="bar-fill" style="width:${row.share * 100}%"></span></span><strong>${row.employers}</strong></div>`).join('');
}

function renderStatic(release, model) {
  $('#instrument-state').innerHTML = `<span class="signal" aria-hidden="true"></span><span>${pretty(model.readiness.state)} / ${model.readiness.qualified_employers} qualified</span>`;
  const latest = model.periods.at(-1);
  const cover = model.coverage.find((item) => item.period_id === latest.id);
  $('#readout-grid').innerHTML = [
    [model.readiness.qualified_employers, 'qualified employers'],
    [model.readiness.providers.length, 'verified ATS providers'],
    [`${Math.round(cover.coverage_rate * 100)}%`, 'capture coverage'],
    [latest.complete_days, 'complete capture days'],
  ].map(([value, label]) => `<article class="readout-card"><strong>${value}</strong><span>${label}</span></article>`).join('');
  bars($('#provider-composition'), model.composition.providers);
  bars($('#sector-composition'), model.composition.sectors);
  $('#insight-grid').innerHTML = model.insights.map((insight) => `<article class="insight-card"><span class="kicker">${pretty(insight.kind)}</span><p>${insight.summary}</p><span class="metric-id">Evidence: ${insight.metric_id}</span></article>`).join('');
  const reasons = { pilot_period: 'Pilot capture: the measurement interval has not begun.', insufficient_periods: 'At least two complete compatible periods are required.', q4_time_lock: 'Q4 comparison remains locked until 1 January 2027.' };
  $('#trend-title').textContent = model.trend.eligible ? 'Comparison is eligible.' : 'Comparison is locked.';
  $('#trend-reason').textContent = model.trend.eligible ? 'The release contains complete compatible periods.' : reasons[model.trend.reason] ?? 'The evidence gate is closed.';
  $('#trend-seal').textContent = model.trend.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE';
  $('#release-footnote').textContent = `${release.release_id} / ${release.generated_at}`;
}

function installFilters(release, model) {
  const controls = { period: $('#period-filter'), provider: $('#provider-filter'), sector: $('#sector-filter'), weighting: $('#weighting-filter') };
  controls.period.innerHTML = model.filters.periods.map(option).join('');
  controls.provider.innerHTML = model.filters.providers.map(option).join('');
  controls.sector.innerHTML = model.filters.sectors.map(option).join('');
  const update = () => {
    const filters = Object.fromEntries(Object.entries(controls).map(([key, node]) => [key, node.value]));
    const selected = selectEvidence(release, filters);
    $('#scope-line').textContent = `${pretty(filters.period)} / ${pretty(filters.provider)} / ${pretty(filters.sector)} / weighted by ${filters.weighting}`;
    if (selected.missing) {
      $('#primary-gauge').innerHTML = '<p class="gauge-copy">No validated aggregate cell exists for this filter combination.</p>';
      return;
    }
    const ratio = selected.maximum ? selected.rate * 100 : 100;
    $('#primary-gauge').innerHTML = `<strong class="gauge-value">${selected.value}</strong><div class="gauge-copy"><p>${selected.denominator}</p><div class="gauge-meter" title="${selected.tooltip}"><span style="width:${ratio}%"></span></div><small class="metric-id">${selected.tooltip}</small></div>`;
  };
  $('#filters').addEventListener('change', update);
  update();
}

async function boot() {
  try {
    const response = await fetch('./data/pilot.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('release unavailable');
    const release = await response.json();
    const model = createDashboardModel(release);
    renderStatic(release, model);
    installFilters(release, model);
  } catch (error) {
    $('#error-panel').hidden = false;
    $('#instrument-state').textContent = 'Instrument unavailable';
  }
}

boot();

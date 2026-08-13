const RELEASE_KEYS = ['schema_version', 'release_id', 'generated_at', 'study', 'readiness', 'periods', 'coverage', 'composition', 'demand', 'employer_breadth', 'insights', 'trend_gate'];
const FORBIDDEN_KEYS = new Set(['vacancy_id', 'title', 'description', 'company_name', 'employer_vacancy_count', 'advert_url', 'apply_url', 'source_payload', 'run_id', 'manifest_path', 'raw_path', 'api_key', 'credentials', 'error_body', 'repository_url']);
const PROVIDERS = ['ashby', 'greenhouse', 'smartrecruiters'];
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function invalid() { throw new Error('invalid panel release'); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) { return object(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'); }
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }

function scan(value) {
  if (Array.isArray(value)) return value.forEach(scan);
  if (!object(value)) {
    if (typeof value === 'string' && (/https?:\/\//i.test(value) || /github\.com\/[\w.-]+\/[\w.-]*private/i.test(value))) invalid();
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key) || /credential|secret|token/i.test(key)) invalid();
    scan(child);
  }
}

function round(value) { return Number(value.toFixed(4)); }

export function buildPanelRelease({ releaseId, generatedAt, registry, cohort, periods, now = new Date() }) {
  if (typeof releaseId !== 'string' || !ID.test(releaseId) || !timestamp(generatedAt)
    || !Array.isArray(periods) || periods.length === 0) throw new Error('invalid panel release input');
  const byId = new Map(registry.employers.map((employer) => [employer.id, employer]));
  const memberRows = cohort.members.map((id) => byId.get(id));
  if (memberRows.some((row) => !row || row.status !== 'qualified')) throw new Error('invalid qualified cohort');
  const providerIds = [...new Set(memberRows.map((row) => row.provider))].sort();
  const sectorIds = [...new Set(memberRows.map((row) => row.sector))].sort();
  const readinessState = memberRows.length >= 30 && PROVIDERS.every((provider) => providerIds.includes(provider)) ? 'production_ready' : 'pilot_only';
  const demand = [];
  const employerBreadth = [];
  const periodRows = [];
  const coverage = [];
  const periodIds = new Set();

  for (const period of periods) {
    if (!object(period) || typeof period.id !== 'string' || !ID.test(period.id) || periodIds.has(period.id)
      || typeof period.label !== 'string' || !['pilot', 'measurement'].includes(period.phase)
      || !DATE.test(period.start) || !DATE.test(period.end) || period.start > period.end
      || !Array.isArray(period.days) || period.days.length === 0) throw new Error('invalid panel period');
    periodIds.add(period.id);
    if (period.phase === 'measurement' && (period.start < cohort.effective_from || period.end > cohort.effective_to)) throw new Error('measurement period outside cohort effective dates');
    if (period.phase === 'pilot' && period.end >= cohort.effective_from) throw new Error('pilot period overlaps cohort effective dates');
    const seenDays = new Set();
    const rows = [];
    for (const day of period.days) {
      if (!object(day) || !DATE.test(day.partition) || day.partition < period.start || day.partition > period.end
        || seenDays.has(day.partition) || day.comparable !== true || day.failed !== 0 || day.missing !== 0
        || !Array.isArray(day.captures)) throw new Error('period requires complete capture days');
      seenDays.add(day.partition);
      const seenEmployers = new Set();
      for (const capture of day.captures) {
        if (!object(capture) || !cohort.members.includes(capture.employer_id) || seenEmployers.has(capture.employer_id)
          || !Number.isSafeInteger(capture.reported_total) || capture.reported_total < 0) throw new Error('invalid period capture');
        seenEmployers.add(capture.employer_id);
        rows.push({ employer: byId.get(capture.employer_id), count: capture.reported_total });
      }
      if (seenEmployers.size !== cohort.members.length) throw new Error('period capture membership incomplete');
    }
    periodRows.push({ id: period.id, label: period.label, phase: period.phase, start: period.start, end: period.end, complete_days: period.days.length, total_days: period.days.length, cohort_id: cohort.id });
    const units = period.days.length * cohort.members.length;
    coverage.push({ period_id: period.id, expected_capture_units: units, complete_capture_units: units, coverage_rate: 1 });
    for (const provider of ['all', ...providerIds]) for (const sector of ['all', ...sectorIds]) {
      const eligibleRows = rows.filter((row) => (provider === 'all' || row.employer.provider === provider) && (sector === 'all' || row.employer.sector === sector));
      const eligibleIds = new Set(eligibleRows.map((row) => row.employer.id));
      const openIds = new Set(eligibleRows.filter((row) => row.count > 0).map((row) => row.employer.id));
      const cell = `${period.id}-${provider}-${sector}`;
      demand.push({ metric_id: `demand-${cell}`, period_id: period.id, provider, sector, listing_count: eligibleRows.reduce((sum, row) => sum + row.count, 0) });
      employerBreadth.push({ metric_id: `breadth-${cell}`, period_id: period.id, provider, sector, eligible_employers: eligibleIds.size, employers_with_openings: openIds.size, rate: eligibleIds.size === 0 ? 0 : round(openIds.size / eligibleIds.size) });
    }
  }

  let trendGate;
  if (periodRows.some((period) => period.phase === 'pilot')) trendGate = { eligible: false, reason: 'pilot_period' };
  else if (periodRows.length < 2) trendGate = { eligible: false, reason: 'insufficient_periods' };
  else if (now < new Date('2027-01-01T00:00:00.000Z')) trendGate = { eligible: false, reason: 'q4_time_lock' };
  else trendGate = { eligible: true, reason: null };

  const providerComposition = providerIds.map((id) => ({ id, employers: memberRows.filter((row) => row.provider === id).length, share: round(memberRows.filter((row) => row.provider === id).length / memberRows.length) }));
  const sectorComposition = sectorIds.map((id) => ({ id, employers: memberRows.filter((row) => row.sector === id).length, share: round(memberRows.filter((row) => row.sector === id).length / memberRows.length) }));
  const totalMetric = demand.find((item) => item.provider === 'all' && item.sector === 'all');
  const breadthMetric = employerBreadth.find((item) => item.provider === 'all' && item.sector === 'all');
  const release = {
    schema_version: 1,
    release_id: releaseId,
    generated_at: generatedAt,
    study: { id: 'nz-fixed-quarter-ats-panel', cohort_id: cohort.id, country: cohort.country, population: 'supported_ats_employer_census', measurement_start: cohort.effective_from, measurement_end: cohort.effective_to },
    readiness: { state: readinessState, qualified_employers: memberRows.length, target_min: 30, target_max: 50, providers: providerIds },
    periods: periodRows,
    coverage,
    composition: { providers: providerComposition, sectors: sectorComposition },
    demand,
    employer_breadth: employerBreadth,
    insights: [
      { id: 'observable-demand', kind: 'level', metric_id: totalMetric.metric_id, summary: `${totalMetric.listing_count} observable vacancies across complete pilot captures.` },
      { id: 'employer-breadth', kind: 'breadth', metric_id: breadthMetric.metric_id, summary: `${breadthMetric.employers_with_openings} of ${breadthMetric.eligible_employers} cohort employers had observable openings.` },
    ],
    trend_gate: trendGate,
  };
  validatePanelRelease(release);
  return release;
}

export function validatePanelRelease(value) {
  scan(value);
  if (!exact(value, RELEASE_KEYS) || value.schema_version !== 1 || typeof value.release_id !== 'string' || !ID.test(value.release_id) || !timestamp(value.generated_at)
    || !exact(value.study, ['id', 'cohort_id', 'country', 'population', 'measurement_start', 'measurement_end'])
    || !exact(value.readiness, ['state', 'qualified_employers', 'target_min', 'target_max', 'providers'])
    || !exact(value.composition, ['providers', 'sectors'])
    || !exact(value.trend_gate, ['eligible', 'reason'])
    || !Array.isArray(value.periods) || !Array.isArray(value.coverage) || !Array.isArray(value.demand)
    || !Array.isArray(value.employer_breadth) || !Array.isArray(value.insights)) invalid();
  if (!['pilot_only', 'production_ready'].includes(value.readiness.state)
    || !Number.isSafeInteger(value.readiness.qualified_employers) || value.readiness.qualified_employers < 0
    || value.readiness.target_min !== 30 || value.readiness.target_max !== 50
    || !Array.isArray(value.readiness.providers)) invalid();
  for (const row of value.periods) if (!exact(row, ['id', 'label', 'phase', 'start', 'end', 'complete_days', 'total_days', 'cohort_id'])) invalid();
  for (const row of value.coverage) if (!exact(row, ['period_id', 'expected_capture_units', 'complete_capture_units', 'coverage_rate'])) invalid();
  for (const row of [...value.composition.providers, ...value.composition.sectors]) if (!exact(row, ['id', 'employers', 'share'])) invalid();
  for (const row of value.demand) if (!exact(row, ['metric_id', 'period_id', 'provider', 'sector', 'listing_count'])) invalid();
  for (const row of value.employer_breadth) if (!exact(row, ['metric_id', 'period_id', 'provider', 'sector', 'eligible_employers', 'employers_with_openings', 'rate'])) invalid();
  for (const row of value.insights) if (!exact(row, ['id', 'kind', 'metric_id', 'summary'])) invalid();
  if (typeof value.trend_gate.eligible !== 'boolean' || (value.trend_gate.eligible ? value.trend_gate.reason !== null : typeof value.trend_gate.reason !== 'string')) invalid();
  return value;
}

export function createDashboardModel(release) {
  return {
    readiness: release.readiness,
    study: release.study,
    periods: release.periods,
    coverage: release.coverage,
    composition: release.composition,
    insights: release.insights.map((insight) => ({
      ...insight,
      metric: [...release.demand, ...release.employer_breadth].find((metric) => metric.metric_id === insight.metric_id),
    })),
    trend: { ...release.trend_gate },
    filters: {
      periods: release.periods.map((period) => period.id),
      providers: ['all', ...release.composition.providers.map((item) => item.id)],
      sectors: ['all', ...release.composition.sectors.map((item) => item.id)],
      weightings: ['listings', 'employers'],
    },
  };
}

export function selectEvidence(release, { period, provider, sector, weighting }) {
  const collection = weighting === 'employers' ? release.employer_breadth : release.demand;
  const metric = collection.find((item) => item.period_id === period && item.provider === provider && item.sector === sector);
  if (!metric) return { missing: true, trend: { ...release.trend_gate } };
  if (weighting === 'employers') {
    return {
      missing: false,
      value: metric.employers_with_openings,
      maximum: metric.eligible_employers,
      rate: metric.rate,
      denominator: 'eligible cohort employers',
      tooltip: `${metric.metric_id}: ${metric.employers_with_openings} of ${metric.eligible_employers} eligible cohort employers had observable openings.`,
      trend: { ...release.trend_gate },
    };
  }
  return {
    missing: false,
    value: metric.listing_count,
    maximum: null,
    rate: null,
    denominator: 'complete board listings',
    tooltip: `${metric.metric_id}: ${metric.listing_count} listings across complete board captures.`,
    trend: { ...release.trend_gate },
  };
}

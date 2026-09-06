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
    decision: release.readiness.state === 'pilot_only'
      ? {
          headline: 'Treat this as a source-health check, not a market read.',
          summary: 'The pilot proves the capture and denominator path; it is not yet a basis for workforce planning.',
          use_now: 'Verify source coverage and inspect observable openings inside this cohort.',
          do_not_use: 'Do not change a hiring plan, salary band, or market forecast from this pilot.',
          next_check: 'Check the selected denominator before sharing any number.',
        }
      : {
          headline: 'Use this complete release to compare observable demand.',
          summary: 'Read every result with its selected cohort, period, and denominator.',
          use_now: 'Compare observable demand inside the published cohort.',
          do_not_use: 'Do not treat cohort results as total market demand.',
          next_check: 'Check the selected denominator before sharing any number.',
        },
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

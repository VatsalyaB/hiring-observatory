import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { manifestPath, validateManifestEvidence } from './lib/capture-manifest.mjs';
import { loadQuerySets } from './lib/query-set.mjs';
import { buildCoverage, validCaptureEvidence } from './lib/query-coverage.mjs';

const PARTITION = /^\d{4}-\d{2}-\d{2}$/;
const PARTITION_TOKEN = /(?:^|[^0-9])(\d{4}-\d{2}-\d{2})(?=$|[^0-9])/g;
const COLLECTOR = 'adzuna-query-census';

function explicitlyForeignCollector(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.collector === 'string' && value.collector !== COLLECTOR;
}

async function entries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function activeQuerySet(querySets, partition) {
  return querySets
    .filter((querySet) => querySet.effective_from <= partition)
    .sort((left, right) => right.effective_from.localeCompare(left.effective_from) || left.id.localeCompare(right.id))[0] ?? null;
}

function evidenceState(index, partition) {
  const current = index.get(partition) ?? { ids: new Set(), invalid: false };
  index.set(partition, current);
  return current;
}

function artifactPartitions(path) {
  return new Set([...path.join('/').matchAll(PARTITION_TOKEN)].map((match) => match[1]));
}

function validCaptureAtPath(value, querySetsById, country, queryId, partition) {
  const querySet = querySetsById.get(value?.query_set);
  const expectedQuery = querySet?.queries.find((query) => query.id === queryId);
  return querySet?.country === country
    && validCaptureEvidence(value, querySet, partition, expectedQuery);
}

async function walkAttributedEvidence(evidenceRoot, visit) {
  async function walk(path, relativePath) {
    for (const entry of await entries(path)) {
      const entryPath = join(path, entry.name);
      const artifactPath = [...relativePath, entry.name];
      const pathPartitions = artifactPartitions(artifactPath);
      const parsed = entry.isFile() && entry.name.endsWith('.json') ? await loadJson(entryPath) : null;
      const embeddedPartition = typeof parsed?.data?.partition === 'string' && PARTITION.test(parsed.data.partition)
        ? parsed.data.partition
        : null;
      const partitions = new Set([...pathPartitions, embeddedPartition].filter(Boolean));

      // Unreadable artifacts without a date token cannot be attributed without poisoning unrelated partitions.
      await visit({ entry, entryPath, artifactPath, pathPartitions, parsed, embeddedPartition, partitions });

      if (entry.isDirectory()) await walk(entryPath, artifactPath);
    }
  }

  await walk(evidenceRoot, []);
}

async function indexCaptureEvidence(root, querySetsById, index) {
  await walkAttributedEvidence(join(root, 'raw', 'adzuna-query'), ({
    entry, artifactPath, pathPartitions, parsed, embeddedPartition, partitions,
  }) => {
    for (const partition of partitions) {
      const state = evidenceState(index, partition);
      const canonicalPath = entry.isFile()
        && artifactPath.length === 3
        && entry.name === `${partition}.json`
        && pathPartitions.size === 1
        && embeddedPartition === partition;
      if (!canonicalPath || !parsed || parsed.invalid) {
        state.invalid = true;
        continue;
      }
      const [country, queryId] = artifactPath;
      if (!validCaptureAtPath(parsed.data, querySetsById, country, queryId, partition)) {
        state.invalid = true;
        continue;
      }
      state.ids.add(parsed.data.query_set);
    }
  });
}

async function indexManifestEvidence(root, index) {
  await walkAttributedEvidence(join(root, 'raw', '_manifests'), ({
    entry, entryPath, artifactPath, pathPartitions, parsed, embeddedPartition, partitions,
  }) => {
    let evidence = null;
    if (parsed && !parsed.invalid) {
      try {
        evidence = validateManifestEvidence(parsed.data);
      } catch {
        // The attributed partitions below fail closed.
      }
    }

    for (const partition of partitions) {
      if (entry.isDirectory() && artifactPath.length === 1 && artifactPath[0] === partition) continue;
      const state = evidenceState(index, partition);
      const canonicalPath = entry.isFile()
        && artifactPath.length === 2
        && artifactPath[0] === partition
        && pathPartitions.size === 1
        && embeddedPartition === partition
        && evidence
        && entryPath === manifestPath(root, partition, evidence.run.run_id, evidence.run.run_attempt);
      if (!canonicalPath) {
        state.invalid = true;
        continue;
      }
      state.ids.add(evidence.query_set);
    }
  });
}

async function indexEvidence(root, querySets) {
  const index = new Map();
  await indexCaptureEvidence(root, new Map(querySets.map((querySet) => [querySet.id, querySet])), index);
  await indexManifestEvidence(root, index);
  return index;
}

function querySetForEvidence(querySets, partition, state) {
  if (!state) return activeQuerySet(querySets, partition);
  if (state.invalid) throw new Error(`invalid query-census evidence for ${partition}`);
  if (state.ids.size === 0) throw new Error(`query-census evidence does not identify a query set for ${partition}`);
  if (state.ids.size > 1) throw new Error(`ambiguous query-set evidence for ${partition}`);
  const id = [...state.ids][0];
  const querySet = querySets.find((candidate) => candidate.id === id);
  if (!querySet) throw new Error(`query-census evidence names unknown query set: ${id}`);
  return querySet;
}

async function loadJson(path) {
  try {
    return { data: JSON.parse(await readFile(path, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { invalid: true };
  }
}

async function loadActiveEvidence(root, querySet, partition) {
  const captures = [];
  for (const query of querySet.queries) {
    const path = join(root, 'raw', 'adzuna-query', querySet.country, query.id, `${partition}.json`);
    const parsed = await loadJson(path);
    if (parsed) captures.push({ ...parsed, expectedQueryId: query.id });
  }

  const manifests = [];
  for (const entry of await entries(join(root, 'raw', '_manifests', partition))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const parsed = await loadJson(join(root, 'raw', '_manifests', partition, entry.name));
    if (!parsed || parsed.invalid) {
      manifests.push({ invalid: true });
      continue;
    }
    if (explicitlyForeignCollector(parsed.data)) continue;
    try {
      const evidence = validateManifestEvidence(parsed.data);
      if (evidence.partition !== partition) {
        manifests.push({ invalid: true });
      } else if (evidence.collector === COLLECTOR && evidence.query_set === querySet.id) {
        manifests.push(evidence);
      }
    } catch {
      manifests.push({ invalid: true });
    }
  }
  return { captures, manifests };
}

function format(model, querySet, partition) {
  const status = model.comparable
    ? 'COMPLETE — eligible for comparison'
    : 'INCOMPLETE — not eligible for comparison';
  return [
    `${querySet.country.toUpperCase()} AI/data query census — ${partition} — ${querySet.id}`,
    `queries: ${model.expected} expected, ${model.complete} complete, ${model.failed} failed, ${model.missing} missing`,
    `records: ${model.observations} observations, ${model.distinct_ads} distinct Adzuna ids, ${(model.overlap_rate * 100).toFixed(1)}% overlap`,
    `status: ${status}`,
  ].join('\n');
}

async function main() {
  const root = process.cwd();
  const querySets = await loadQuerySets(join(root, 'config', 'query-sets'));
  const evidenceIndex = await indexEvidence(root, querySets);
  const requested = process.argv[2];
  if (requested && !PARTITION.test(requested)) throw new Error('invalid partition');
  const partition = requested ?? [...evidenceIndex.keys()].sort().at(-1) ?? null;
  if (!partition) {
    console.error('no query-census partition found');
    process.exitCode = 1;
    return;
  }
  const querySet = querySetForEvidence(querySets, partition, evidenceIndex.get(partition));
  if (!querySet) throw new Error('no active query set');
  const evidence = await loadActiveEvidence(root, querySet, partition);
  const model = buildCoverage({ querySet, partition, ...evidence });
  console.log(format(model, querySet, partition));
  process.exitCode = model.comparable ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'query-census status failed');
  process.exitCode = 1;
}

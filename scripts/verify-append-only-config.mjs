import { execFileSync } from 'node:child_process';

const ZERO_SHA = '0'.repeat(40);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA = /^[0-9a-f]{40}$/i;
const [baseArgument, head, ...extraArguments] = process.argv.slice(2);

function fail(message) {
  console.error(`append-only config guard: ${message}`);
  process.exit(1);
}

function git(args, context) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', shell: false });
  } catch (error) {
    fail(`${context}: ${error.stderr?.trim() || error.message}`);
  }
}

function lines(output) {
  return output.trim().split(/\r?\n/).filter(Boolean);
}

function requireCommit(sha, label) {
  const type = git(['cat-file', '-t', sha], `${label} must name an existing commit SHA`).trim();
  if (type !== 'commit') fail(`${label} must name an existing commit SHA`);
}

function requireShas(values, context) {
  if (!values.every((value) => SHA.test(value))) fail(`${context} returned an invalid commit SHA`);
}

function changedPaths(parent, commit) {
  const changed = git([
    'diff', '--name-status', '-z', '--no-renames', parent, commit, '--',
    'config/query-sets', 'config/cohorts'
  ], `could not inspect ${commit} against ${parent}`);
  const fields = changed.split('\0');
  fields.pop();
  if (fields.length % 2 !== 0) fail(`could not parse NUL-delimited change records for ${commit}`);

  return Array.from({ length: fields.length / 2 }, (_, index) => ({
    status: fields[index * 2],
    path: fields[(index * 2) + 1]
  }));
}

function treeEntries(commit, paths, context) {
  if (commit === EMPTY_TREE) return [];
  const records = git(['ls-tree', '-rz', '--full-tree', commit, '--', ...paths], context).split('\0');
  records.pop();
  return records.map((record) => {
    const tab = record.indexOf('\t');
    if (tab < 0) fail(`${context}: could not parse tree entry`);
    const [mode, type, object] = record.slice(0, tab).split(' ');
    if (!mode || !type || !object) fail(`${context}: could not parse tree entry`);
    return { mode, type, object, path: record.slice(tab + 1) };
  });
}

function parseBlob(entry, context) {
  try {
    return JSON.parse(git(['cat-file', 'blob', entry.object], context));
  } catch {
    return null;
  }
}

function querySetSnapshot(commit, violations) {
  const entries = treeEntries(commit, ['config/query-sets'], `could not inspect query sets at ${commit}`)
    .filter((entry) => entry.path.startsWith('config/query-sets/') && entry.path.endsWith('.json'));
  const values = [];
  const byPath = new Map(entries.map((entry) => {
    let value = null;
    if (entry.mode === '100644' && entry.type === 'blob') {
      value = parseBlob(entry, `could not parse ${entry.path} at ${commit}`);
      if (value === null) violations.push(`${commit}: invalid JSON ${JSON.stringify(entry.path)}`);
      else values.push(value);
    }
    return [entry.path, { ...entry, value }];
  }));

  const ids = new Set();
  const effectiveDates = new Set();
  for (const value of values) {
    if (typeof value?.id === 'string') {
      if (ids.has(value.id)) violations.push(`${commit}: duplicate query-set id ${JSON.stringify(value.id)}`);
      ids.add(value.id);
    }
    if (typeof value?.effective_from === 'string') {
      if (effectiveDates.has(value.effective_from)) {
        violations.push(`${commit}: duplicate effective_from ${JSON.stringify(value.effective_from)}`);
      }
      effectiveDates.add(value.effective_from);
    }
  }
  return { byPath, values };
}

function committedEvidence(commit, querySets) {
  if (commit === EMPTY_TREE) return [];
  const countryBySet = new Map(querySets
    .filter((value) => typeof value?.id === 'string' && typeof value?.country === 'string')
    .map((value) => [value.id, value.country]));
  const evidence = [];
  for (const entry of treeEntries(
    commit,
    ['raw/adzuna-query', 'raw/_manifests'],
    `could not inspect committed query evidence at ${commit}`,
  )) {
    if (entry.mode !== '100644' || entry.type !== 'blob' || !entry.path.endsWith('.json')) continue;
    const value = parseBlob(entry, `could not parse query evidence ${entry.path} at ${commit}`);
    if (!value || typeof value.query_set !== 'string') continue;
    const capture = /^raw\/adzuna-query\/([^/]+)\/[^/]+\/(\d{4}-\d{2}-\d{2})\.json$/.exec(entry.path);
    if (capture && value.coverage_mode === 'query_census') {
      evidence.push({ partition: capture[2], country: value.country ?? capture[1], querySet: value.query_set });
      continue;
    }
    const manifest = /^raw\/_manifests\/(\d{4}-\d{2}-\d{2})\/[^/]+\.json$/.exec(entry.path);
    if (manifest && value.collector === 'adzuna-query-census') {
      evidence.push({ partition: manifest[1], country: countryBySet.get(value.query_set), querySet: value.query_set });
    }
  }
  return evidence;
}

function rejectRetroactiveActivation({ commit, parent, added, current, previous, violations }) {
  const nextEffective = current.values
    .filter((value) => value !== added && value?.country === added?.country
      && typeof value.effective_from === 'string' && value.effective_from > added?.effective_from)
    .map((value) => value.effective_from)
    .sort()[0];
  if (typeof added?.country !== 'string' || typeof added?.effective_from !== 'string') return;
  const intersection = committedEvidence(parent, previous.values).find((item) => (item.querySet === added.id || item.country === added.country)
    && item.partition >= added.effective_from && (!nextEffective || item.partition < nextEffective));
  if (intersection) {
    violations.push(`${commit} ${parent}: retroactive query-set activation ${JSON.stringify(added.id)} at ${added.effective_from} intersects committed ${intersection.partition} evidence for ${intersection.querySet}`);
  }
}

if (extraArguments.length > 0 || !baseArgument || !head || !SHA.test(baseArgument) || !SHA.test(head)) {
  fail('expected exactly two full 40-character hexadecimal commit SHAs');
}

requireCommit(head, 'head');
if (baseArgument !== ZERO_SHA) requireCommit(baseArgument, 'base');
const roots = lines(git(['rev-list', '--max-parents=0', head], 'could not resolve root commits'));
requireShas(roots, 'root commit lookup');
if (roots.length !== 1) fail('head must have a single-root history');


let base = baseArgument;
let introduced;

if (base === ZERO_SHA) {
  base = roots[0];
  introduced = lines(git(['rev-list', '--reverse', head], 'could not enumerate introduced commits'));
} else {
  git(['merge-base', '--is-ancestor', base, head], 'base must be an ancestor of head; force-push comparisons are rejected');
  introduced = lines(git(['rev-list', '--reverse', `${base}..${head}`], 'could not enumerate introduced commits'));
}

requireShas(introduced, 'introduced commit lookup');

const violations = [];
for (const commit of introduced) {
  const parents = git(['show', '-s', '--format=%P', commit], `could not inspect parents of ${commit}`).trim().split(/\s+/).filter(Boolean);
  requireShas(parents, `parent lookup for ${commit}`);

  let currentQuerySets;
  for (const parent of parents.length === 0 ? [EMPTY_TREE] : parents) {
    const changes = changedPaths(parent, commit);
    for (const { status, path } of changes) {
      if (status !== 'A') violations.push(`${commit} ${parent}: ${status} ${JSON.stringify(path)}`);
    }
    const addedQuerySets = changes.filter(({ status, path }) => status === 'A'
      && path.startsWith('config/query-sets/') && path.endsWith('.json'));
    if (addedQuerySets.length === 0) continue;
    currentQuerySets ??= querySetSnapshot(commit, violations);
    const previousQuerySets = querySetSnapshot(parent, violations);
    for (const { path } of addedQuerySets) {
      const entry = currentQuerySets.byPath.get(path);
      if (!entry || entry.mode !== '100644' || entry.type !== 'blob') {
        violations.push(`${commit} ${parent}: added query set must be a non-executable JSON blob with Git mode 100644: ${JSON.stringify(path)}`);
        continue;
      }
      if (entry.value !== null) {
        rejectRetroactiveActivation({
          commit,
          parent,
          added: entry.value,
          current: currentQuerySets,
          previous: previousQuerySets,
          violations,
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('append-only config guard: protected version history is append-only; create a new version file instead:');
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log('append-only config guard: PASS');

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChecker } from './lib/verify.mjs';
import { loadQuerySet, loadQuerySets, validateQuerySet } from './lib/query-set.mjs';

const { check, finish } = createChecker('verify-query-set');
const committedQuerySets = await loadQuerySets('config/query-sets');
const value = JSON.parse(await readFile('config/query-sets/nz-ai-data-v1.json', 'utf8'));

const duplicateId = structuredClone(value);
duplicateId.queries[1].id = duplicateId.queries[0].id;

const duplicateText = structuredClone(value);
duplicateText.queries[1].text = duplicateText.queries[0].text.toUpperCase();

const badBudget = { ...structuredClone(value), daily_page_budget: 61 };
const badPageSize = { ...structuredClone(value), results_per_page: 0 };
const unknownRootKey = { ...structuredClone(value), unexpected: true };
const unknownQueryKey = structuredClone(value);
unknownQueryKey.queries[0].unexpected = true;
const malformedDate = { ...structuredClone(value), effective_from: '2026/08/10' };
const impossibleDate = { ...structuredClone(value), effective_from: '2026-02-30' };
const uppercaseCountry = { ...structuredClone(value), country: 'NZ' };
const emptySetId = { ...structuredClone(value), id: ' ' };
const unsafeSetId = { ...structuredClone(value), id: '../../../../outside' };
const emptyQueryId = structuredClone(value);
emptyQueryId.queries[0].id = '';
const unsafeQueryId = structuredClone(value);
unsafeQueryId.queries[0].id = '../../../../outside';
const emptyQueryText = structuredClone(value);
emptyQueryText.queries[0].text = ' ';
const emptyRoleFamily = structuredClone(value);
emptyRoleFamily.queries[0].role_family = '';
const emptyQueries = { ...structuredClone(value), queries: [] };
const lowPageSize = { ...structuredClone(value), results_per_page: 0 };
const highPageSize = { ...structuredClone(value), results_per_page: 51 };
const lowBudget = { ...structuredClone(value), daily_page_budget: 0 };
const highBudget = { ...structuredClone(value), daily_page_budget: 61 };

check('committed query set is valid', validateQuerySet(value).ok);
check('every committed query-set JSON file is valid', committedQuerySets.some((querySet) => querySet.id === value.id));
check('duplicate query ids are rejected', !validateQuerySet(duplicateId).ok);
check('case-insensitive duplicate query text is rejected', !validateQuerySet(duplicateText).ok);
check('budget above the approved ceiling is rejected', !validateQuerySet(badBudget).ok);
check('zero page size is rejected', !validateQuerySet(badPageSize).ok);
check('unknown root keys are rejected', !validateQuerySet(unknownRootKey).ok);
check('unknown query keys are rejected', !validateQuerySet(unknownQueryKey).ok);
check('syntactically malformed dates are rejected', !validateQuerySet(malformedDate).ok);
check('impossible dates are rejected', !validateQuerySet(impossibleDate).ok);
check('uppercase countries are rejected', !validateQuerySet(uppercaseCountry).ok);
check('empty query-set ids are rejected', !validateQuerySet(emptySetId).ok);
check('path-traversing query-set ids are rejected', !validateQuerySet(unsafeSetId).ok);
check('empty query ids are rejected', !validateQuerySet(emptyQueryId).ok);
check('path-traversing query ids are rejected', !validateQuerySet(unsafeQueryId).ok);
check('empty query text is rejected', !validateQuerySet(emptyQueryText).ok);
check('empty query role families are rejected', !validateQuerySet(emptyRoleFamily).ok);
check('empty query arrays are rejected', !validateQuerySet(emptyQueries).ok);
check('page sizes below the approved floor are rejected', !validateQuerySet(lowPageSize).ok);
check('page sizes above the approved ceiling are rejected', !validateQuerySet(highPageSize).ok);
check('budgets below the approved floor are rejected', !validateQuerySet(lowBudget).ok);
check('budgets above the approved ceiling are rejected', !validateQuerySet(highBudget).ok);

const malformedJsonPath = join(tmpdir(), `query-set-malformed-${process.pid}.json`);
await writeFile(malformedJsonPath, '{', 'utf8');
const malformedJsonRejected = await loadQuerySet(malformedJsonPath)
  .then(() => false, (error) => error.message.startsWith('invalid query set:'));
await rm(malformedJsonPath);
check('malformed JSON loader errors use the query-set prefix', malformedJsonRejected);

const loaderRoot = await mkdtemp(join(tmpdir(), 'query-set-loader-'));
try {
  const targetPath = join(loaderRoot, 'target.json');
  const symlinkPath = join(loaderRoot, 'linked.json');
  await writeFile(targetPath, `${JSON.stringify(value)}\n`, 'utf8');
  await symlink('target.json', symlinkPath);
  const symlinkRejected = await loadQuerySet(symlinkPath).then(
    () => false,
    (error) => error.message.startsWith('invalid query set:'),
  );
  check('loader rejects a symlink to valid query-set JSON', symlinkRejected);
} finally {
  await rm(loaderRoot, { recursive: true, force: true });
}

finish();

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, cp, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const guard = resolve(root, 'scripts/verify-append-only-config.mjs');
const workflowVerifier = resolve(root, 'scripts/verify-workflows.mjs');
const ZERO_SHA = '0'.repeat(40);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd, message) {
  git(cwd, ['add', '--all']);
  git(cwd, ['-c', 'user.name=append-only-selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function runGuard(cwd, ...args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [guard, ...args], { cwd, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function expectPass(cwd, label, ...args) {
  const result = runGuard(cwd, ...args);
  assert.equal(result.status, 0, `${label} should pass:\n${result.stderr || result.stdout}`);
}

function expectBlocked(cwd, label, ...args) {
  const result = runGuard(cwd, ...args);
  assert.notEqual(result.status, 0, `${label} should fail`);
  assert.match(`${result.stderr}${result.stdout}`, /create a new version file/i, `${label} should direct callers to create a new version file`);
}

function expectInvalid(cwd, label, ...args) {
  const result = runGuard(cwd, ...args);
  assert.notEqual(result.status, 0, `${label} should fail`);
  assert.match(`${result.stderr}${result.stdout}`, /full 40-character hexadecimal commit SHA/i, `${label} should reject invalid input before diffing`);
}

async function write(cwd, path, content) {
  await mkdir(resolve(cwd, dirname(path)), { recursive: true });
  await writeFile(resolve(cwd, path), content);
}

function querySetJson(id, effectiveFrom, queryId = 'query-one') {
  return `${JSON.stringify({
    id,
    country: 'nz',
    effective_from: effectiveFrom,
    results_per_page: 50,
    daily_page_budget: 60,
    queries: [{ id: queryId, text: queryId.replaceAll('-', ' '), role_family: 'test' }],
  })}\n`;
}

async function setupRepository() {
  const cwd = await mkdtemp(resolve(tmpdir(), 'append-only-config-'));
  git(cwd, ['init', '--initial-branch=main']);
  await write(cwd, 'README.md', 'temporary self-test repository\n');
  const rootCommit = commit(cwd, 'root');
  return { cwd, rootCommit };
}

async function verifyAppendOnlyHistory() {
  const { cwd, rootCommit } = await setupRepository();
  try {
    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    const v1 = commit(cwd, 'add query v1');
    expectPass(cwd, 'adding query v1', rootCommit, v1);
    expectPass(cwd, 'all-zero GitHub before SHA', ZERO_SHA, v1);

    await write(cwd, 'config/query-sets/v1.json', '{"version":"modified"}\n');
    const modified = commit(cwd, 'modify query v1');
    expectBlocked(cwd, 'modifying a committed query version', v1, modified);

    await rm(resolve(cwd, 'config/query-sets/v1.json'));
    const deleted = commit(cwd, 'delete query v1');
    expectBlocked(cwd, 'deleting a committed query version', v1, deleted);

    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    const restored = commit(cwd, 'restore query v1 for isolated mutations');
    await rename(resolve(cwd, 'config/query-sets/v1.json'), resolve(cwd, 'config/query-sets/v3.json'));
    const renamed = commit(cwd, 'rename query v1 to v3');
    expectBlocked(cwd, 'renaming a committed query version', restored, renamed);

    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    const regularFile = commit(cwd, 'restore regular query v1');
    await rm(resolve(cwd, 'config/query-sets/v1.json'));
    await symlink('v3.json', resolve(cwd, 'config/query-sets/v1.json'));
    const typeChanged = commit(cwd, 'change query v1 into symlink');
    expectBlocked(cwd, 'changing a committed query version type', regularFile, typeChanged);

    await write(cwd, 'config/query-sets/v2.json', '{"version":2}\n');
    const v2 = commit(cwd, 'add query v2');
    expectPass(cwd, 'adding query v2', typeChanged, v2);

    await write(cwd, 'unprotected/version.txt', 'changed outside protected directories\n');
    const outsideProtectedDirectories = commit(cwd, 'change an unprotected file');
    expectPass(cwd, 'changing a file outside protected directories', v2, outsideProtectedDirectories);

    await write(cwd, 'config/cohorts/v1.json', '{"version":1}\n');
    const cohortV1 = commit(cwd, 'add cohort v1');
    expectPass(cwd, 'adding the first cohort version', v2, cohortV1);
    await write(cwd, 'config/cohorts/v1.json', '{"version":"modified"}\n');
    const cohortModified = commit(cwd, 'modify cohort v1');
    expectBlocked(cwd, 'modifying a committed cohort version', cohortV1, cohortModified);

    await rm(resolve(cwd, 'config/cohorts/v1.json'));
    const cohortDeleted = commit(cwd, 'delete cohort v1');
    expectBlocked(cwd, 'deleting a committed cohort version', cohortModified, cohortDeleted);

    await write(cwd, 'config/cohorts/v1.json', '{"version":1}\n');
    const cohortRestored = commit(cwd, 'restore cohort v1');
    await rename(resolve(cwd, 'config/cohorts/v1.json'), resolve(cwd, 'config/cohorts/v3.json'));
    const cohortRenamed = commit(cwd, 'rename cohort v1');
    expectBlocked(cwd, 'renaming a committed cohort version', cohortRestored, cohortRenamed);

    await write(cwd, 'config/cohorts/v2.json', '{"version":2}\n');
    const cohortV2 = commit(cwd, 'add successor cohort v2');
    expectPass(cwd, 'adding a successor cohort version', cohortRenamed, cohortV2);

    await symlink('v2.json', resolve(cwd, 'config/cohorts/v4.json'));
    const cohortSymlink = commit(cwd, 'add cohort symlink');
    expectBlocked(cwd, 'adding a cohort version as a symlink', cohortV2, cohortSymlink);

    expectInvalid(cwd, 'missing SHAs');
    expectInvalid(cwd, 'symbolic revision', 'HEAD', cohortSymlink);
    expectInvalid(cwd, 'injection-like revision', `${cohortV1};touch-owned`, cohortSymlink);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function copyWiringFixture(cwd) {
  await mkdir(resolve(cwd, '.github/workflows'), { recursive: true });
  await mkdir(resolve(cwd, 'hooks'), { recursive: true });
  await cp(resolve(root, '.github/workflows/verify.yml'), resolve(cwd, '.github/workflows/verify.yml'));
  await cp(resolve(root, '.github/workflows/ingest.yml'), resolve(cwd, '.github/workflows/ingest.yml'));
  await cp(resolve(root, 'hooks/pre-push'), resolve(cwd, 'hooks/pre-push'));
  await chmod(resolve(cwd, 'hooks/pre-push'), 0o755);
  commit(cwd, 'copy append-only wiring');
}

function runWorkflowVerifier(cwd) {
  return spawnSync(process.execPath, [workflowVerifier], { cwd, encoding: 'utf8', shell: false });
}

async function expectWiringMutationFails(label, mutate) {
  const { cwd } = await setupRepository();
  try {
    await copyWiringFixture(cwd);
    const baseline = runWorkflowVerifier(cwd);
    assert.equal(baseline.status, 0, `baseline wiring should pass:\n${baseline.stderr || baseline.stdout}`);
    await mutate(cwd);
    const result = runWorkflowVerifier(cwd);
    assert.notEqual(result.status, 0, `${label} should make the workflow verifier fail`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function verifyWiringIsWatched() {
  await expectWiringMutationFails('removing the local append-only gate', async (cwd) => {
    const path = resolve(cwd, 'hooks/pre-push');
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replace('node scripts/verify-append-only-config-selftest.mjs >/dev/null || fail "append-only self-test failed — run: npm run verify:append-only-config:self-test"\n', ''));
  });
  await expectWiringMutationFails('removing the push append-only gate', async (cwd) => {
    const path = resolve(cwd, '.github/workflows/verify.yml');
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replace(/      - name: query and cohort versions are append-only \(push\)[\s\S]*?(?=\n      - name: query and cohort versions are append-only \(pull request\))/, ''));
  });
  await expectWiringMutationFails('removing the pull-request append-only gate', async (cwd) => {
    const path = resolve(cwd, '.github/workflows/verify.yml');
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replace(/\n      - name: query and cohort versions are append-only \(pull request\)[\s\S]*?(?=\n      - name: compose an ephemeral \.env)/, ''));
  });
}

function expectRejected(cwd, label, ...args) {
  const result = runGuard(cwd, ...args);
  assert.notEqual(result.status, 0, `${label} should fail`);
}

function expectNotCommit(cwd, label, ...args) {
  const result = runGuard(cwd, ...args);
  assert.notEqual(result.status, 0, `${label} should fail`);
  assert.match(`${result.stderr}${result.stdout}`, /must name an existing commit/i, `${label} should reject non-commit objects before history inspection`);
}

async function inRepository(callback) {
  const { cwd, rootCommit } = await setupRepository();
  try {
    await callback(cwd, rootCommit);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function verifyEveryIntroducedCommitIsChecked() {
  await inRepository(async (cwd, rootCommit) => {
    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    commit(cwd, 'add query version');
    await write(cwd, 'config/query-sets/v1.json', '{"version":"edited"}\n');
    const head = commit(cwd, 'edit newly added query version');
    expectBlocked(cwd, 'add then edit', rootCommit, head);
    expectBlocked(cwd, 'all-zero base inspects all reachable commits', ZERO_SHA, head);
  });

  await inRepository(async (cwd) => {
    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    const base = commit(cwd, 'seed query version');
    await write(cwd, 'config/query-sets/v1.json', '{"version":"edited"}\n');
    commit(cwd, 'edit existing query version');
    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    const head = commit(cwd, 'restore existing query version');
    expectBlocked(cwd, 'existing modify then restore', base, head);
  });

  await inRepository(async (cwd, rootCommit) => {
    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    commit(cwd, 'add query version');
    await rm(resolve(cwd, 'config/query-sets/v1.json'));
    const head = commit(cwd, 'delete newly added query version');
    expectBlocked(cwd, 'add then delete', rootCommit, head);
  });

  await inRepository(async (cwd) => {
    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    const base = commit(cwd, 'seed query version');
    await mkdir(resolve(cwd, 'archive'), { recursive: true });
    await rename(resolve(cwd, 'config/query-sets/v1.json'), resolve(cwd, 'archive/v1.json'));
    commit(cwd, 'move query version out');
    await rename(resolve(cwd, 'archive/v1.json'), resolve(cwd, 'config/query-sets/v1.json'));
    const head = commit(cwd, 'move query version back');
    expectBlocked(cwd, 'move out then back', base, head);
  });

  await inRepository(async (cwd) => {
    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    const base = commit(cwd, 'seed query version');
    git(cwd, ['checkout', '-b', 'feature']);
    await write(cwd, 'config/query-sets/v1.json', '{"version":"feature edit"}\n');
    commit(cwd, 'feature modifies query version');
    git(cwd, ['checkout', 'main']);
    await write(cwd, 'outside.txt', 'main branch only\n');
    commit(cwd, 'main branch changes outside protected directories');
    git(cwd, ['-c', 'user.name=append-only-selftest', '-c', 'user.email=selftest@example.invalid', 'merge', '--no-ff', 'feature', '-m', 'merge feature']);
    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    const head = commit(cwd, 'restore query version after merge');
    expectBlocked(cwd, 'merge-parent mutation', base, head);
  });

  await inRepository(async (cwd, rootCommit) => {
    const unusual = 'config/query-sets/version with spaces\tand\nnewlines.json';
    await write(cwd, unusual, '{"version":1}\n');
    const added = commit(cwd, 'add unusual protected filename');
    expectPass(cwd, 'adding a protected filename containing spaces tabs and newlines', rootCommit, added);
    await write(cwd, unusual, '{"version":"edited"}\n');
    const edited = commit(cwd, 'edit unusual protected filename');
    expectBlocked(cwd, 'editing a protected filename containing spaces tabs and newlines', added, edited);
  });
}

async function verifyAddedSymlinkBypassIsBlocked() {
  await inRepository(async (cwd, rootCommit) => {
    await write(cwd, 'mutable-query-target.json', '{"version":1}\n');
    await mkdir(resolve(cwd, 'config/query-sets'), { recursive: true });
    await symlink('../../mutable-query-target.json', resolve(cwd, 'config/query-sets/v1.json'));
    commit(cwd, 'add protected query symlink');

    await write(cwd, 'mutable-query-target.json', '{"version":"rewritten"}\n');
    const head = commit(cwd, 'rewrite unprotected symlink target');
    expectBlocked(cwd, 'two-commit added-symlink bypass', rootCommit, head);
    await expectGuardMutationIsCaught(
      cwd,
      'removing the added-object mode check',
      1,
      [rootCommit, head],
      (source) => source.replace(
        "if (!entry || entry.mode !== '100644' || entry.type !== 'blob') {",
        'if (!entry) {'
      ),
    );
  });
}

async function verifyAddedQueryObjectsArePlainJsonBlobs() {
  await inRepository(async (cwd, rootCommit) => {
    await write(cwd, 'config/query-sets/executable.json', querySetJson('executable', '2026-08-12'));
    await chmod(resolve(cwd, 'config/query-sets/executable.json'), 0o755);
    const head = commit(cwd, 'add executable query config');
    expectBlocked(cwd, 'added executable query config', rootCommit, head);
  });

  await inRepository(async (cwd, rootCommit) => {
    await write(cwd, 'gitlink-source.txt', 'gitlink object\n');
    const target = commit(cwd, 'create gitlink target commit');
    git(cwd, ['update-index', '--add', '--cacheinfo', `160000,${target},config/query-sets/gitlink.json`]);
    git(cwd, ['-c', 'user.name=append-only-selftest', '-c', 'user.email=selftest@example.invalid', 'commit', '-m', 'add query config gitlink']);
    const head = git(cwd, ['rev-parse', 'HEAD']);
    expectBlocked(cwd, 'added query config gitlink', rootCommit, head);
  });
}

async function verifyQuerySetCollectionHistory() {
  await inRepository(async (cwd) => {
    await write(cwd, 'config/query-sets/v1.json', querySetJson('nz-v1', '2026-08-01'));
    await write(cwd, 'raw/adzuna-query/nz/query-one/2026-08-10.json', JSON.stringify({
      source: 'adzuna',
      coverage_mode: 'query_census',
      country: 'nz',
      partition: '2026-08-10',
      query_set: 'nz-v1',
    }));
    const base = commit(cwd, 'seed query set and capture evidence');
    await write(cwd, 'config/query-sets/v2.json', querySetJson('nz-v2', '2026-08-05', 'query-two'));
    const head = commit(cwd, 'add retroactive query set');
    expectBlocked(cwd, 'retroactive activation over committed capture evidence', base, head);
    await expectGuardMutationIsCaught(
      cwd,
      'removing the retroactive evidence intersection check',
      1,
      [base, head],
      (source) => source.replace('if (intersection) {', 'if (false && intersection) {'),
    );
  });

  await inRepository(async (cwd) => {
    await write(cwd, 'config/query-sets/v1.json', querySetJson('nz-v1', '2026-08-01'));
    const base = commit(cwd, 'seed query set');
    await write(cwd, 'config/query-sets/v2.json', querySetJson('nz-v1', '2026-08-12', 'query-two'));
    const head = commit(cwd, 'add duplicate query-set id');
    expectBlocked(cwd, 'duplicate query-set id', base, head);
  });

  await inRepository(async (cwd) => {
    await write(cwd, 'config/query-sets/v1.json', querySetJson('nz-v1', '2026-08-01'));
    const base = commit(cwd, 'seed query set');
    await write(cwd, 'config/query-sets/v2.json', querySetJson('nz-v2', '2026-08-01', 'query-two'));
    const head = commit(cwd, 'add duplicate effective date');
    expectBlocked(cwd, 'duplicate effective_from date', base, head);
  });

  await inRepository(async (cwd) => {
    await write(cwd, 'config/query-sets/v1.json', querySetJson('nz-v1', '2026-08-01'));
    await write(cwd, 'raw/_manifests/2026-08-10/unknown.json', `${JSON.stringify({
      collector: 'adzuna-query-census',
      partition: '2026-08-10',
      query_set: 'nz-v2',
    })}\n`);
    const base = commit(cwd, 'seed unknown manifest query-set evidence');
    await write(cwd, 'config/query-sets/v2.json', querySetJson('nz-v2', '2026-08-05', 'query-two'));
    const head = commit(cwd, 'retroactively define unknown manifest query set');
    expectBlocked(cwd, 'retroactive activation matching unknown manifest identity', base, head);
    await expectGuardMutationIsCaught(
      cwd,
      'removing unknown manifest identity matching',
      1,
      [base, head],
      (source) => {
        const changed = source.replace('item.querySet === added.id || ', '');
        assert.notEqual(changed, source, 'unknown manifest identity mutation target missing');
        return changed;
      },
    );
  });
}

async function verifyTopologyAndObjectValidation() {
  await inRepository(async (cwd, rootCommit) => {
    await write(cwd, 'main.txt', 'main\n');
    const mainHead = commit(cwd, 'main branch change');
    git(cwd, ['checkout', '-b', 'other', rootCommit]);
    await write(cwd, 'other.txt', 'other\n');
    const otherHead = commit(cwd, 'other branch change');
    expectRejected(cwd, 'non-ancestor force-push comparison', mainHead, otherHead);
  });

  await inRepository(async (cwd) => {
    await write(cwd, 'main.txt', 'main\n');
    commit(cwd, 'main branch change');
    git(cwd, ['checkout', '--orphan', 'unrelated']);
    await rm(resolve(cwd, 'README.md'), { force: true });
    await rm(resolve(cwd, 'main.txt'), { force: true });
    await write(cwd, 'unrelated.txt', 'unrelated root\n');
    commit(cwd, 'unrelated root');
    git(cwd, ['checkout', 'main']);
    git(cwd, ['-c', 'user.name=append-only-selftest', '-c', 'user.email=selftest@example.invalid', 'merge', '--allow-unrelated-histories', '--no-ff', 'unrelated', '-m', 'merge unrelated root']);
    const head = git(cwd, ['rev-parse', 'HEAD']);
    expectRejected(cwd, 'multiple-root history', ZERO_SHA, head);
    expectRejected(cwd, 'multiple-root history with a non-zero base', head, head);
  });

  await inRepository(async (cwd, rootCommit) => {
    const tree = git(cwd, ['rev-parse', `${rootCommit}^{tree}`]);
    const blob = git(cwd, ['rev-parse', `${rootCommit}:README.md`]);
    expectNotCommit(cwd, 'tree SHA', tree, rootCommit);
    expectNotCommit(cwd, 'blob SHA', blob, rootCommit);
    expectNotCommit(cwd, 'nonexistent SHA', 'f'.repeat(40), rootCommit);
  });
}

async function verifyBlockingWiringIsWatched() {
  await expectWiringMutationFails('allowing the push gate to continue on error', async (cwd) => {
    const path = resolve(cwd, '.github/workflows/verify.yml');
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replace("        if: github.event_name == 'push'\n", "        if: github.event_name == 'push'\n        continue-on-error: true\n"));
  });
  await expectWiringMutationFails('allowing the pull-request gate to continue on error', async (cwd) => {
    const path = resolve(cwd, '.github/workflows/verify.yml');
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replace("        if: github.event_name == 'pull_request'\n", "        if: github.event_name == 'pull_request'\n        continue-on-error: true\n"));
  });
  await expectWiringMutationFails('turning the pre-push guard failure into || true', async (cwd) => {
    const path = resolve(cwd, 'hooks/pre-push');
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replace('|| fail "query or cohort version history changed — create a new version file"', '|| true'));
  });
  await expectWiringMutationFails('removing the pre-push guard failure handler', async (cwd) => {
    const path = resolve(cwd, 'hooks/pre-push');
    const source = await readFile(path, 'utf8');
    await writeFile(path, source.replace(' || fail "query or cohort version history changed — create a new version file"', ''));
  });
  await expectWiringMutationFails('moving the local gate before workflow sanity', async (cwd) => {
    const path = resolve(cwd, 'hooks/pre-push');
    const source = await readFile(path, 'utf8');
    const selfTest = 'node scripts/verify-append-only-config-selftest.mjs >/dev/null || fail "append-only self-test failed — run: npm run verify:append-only-config:self-test"\n';
    await writeFile(path, source.replace('node scripts/verify-workflows.mjs >/dev/null || fail "workflow sanity failed — run: node scripts/verify-workflows.mjs"\n', selfTest + 'node scripts/verify-workflows.mjs >/dev/null || fail "workflow sanity failed — run: node scripts/verify-workflows.mjs"\n'));
  });
}

function runGuardAt(cwd, guardPath, ...args) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [guardPath, ...args], { cwd, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function expectGuardMutationIsCaught(cwd, label, expectedStatus, args, mutate) {
  const mutationPath = resolve(cwd, 'mutated-append-only-guard.mjs');
  await cp(guard, mutationPath);
  await writeFile(mutationPath, mutate(await readFile(mutationPath, 'utf8')));
  const result = runGuardAt(cwd, mutationPath, ...args);
  assert.notEqual(result.status, expectedStatus, `${label} should make the scenario's expected result fail`);
}

async function verifyMergeSemantics() {
  await inRepository(async (cwd, rootCommit) => {
    git(cwd, ['checkout', '-b', 'feature', rootCommit]);
    await write(cwd, 'feature.txt', 'feature branch only\n');
    commit(cwd, 'feature changes outside protected directories');
    git(cwd, ['checkout', 'main']);
    await write(cwd, 'main.txt', 'main branch only\n');
    commit(cwd, 'main changes outside protected directories');
    git(cwd, ['-c', 'user.name=append-only-selftest', '-c', 'user.email=selftest@example.invalid', 'merge', '--no-ff', 'feature', '-m', 'clean divergent merge']);
    const head = git(cwd, ['rev-parse', 'HEAD']);
    expectPass(cwd, 'clean divergent merge with only unprotected changes', rootCommit, head);

    await expectGuardMutationIsCaught(
      cwd,
      'reintroducing blanket merge rejection',
      0,
      [rootCommit, head],
      (source) => source.replace(
        '  for (const parent of parents.length === 0 ? [EMPTY_TREE] : parents) {',
        '  if (parents.length > 1) violations.push(`${commit}: merge commits are not permitted`);\n\n  for (const parent of parents.length === 0 ? [EMPTY_TREE] : parents) {'
      )
    );
  });

  await inRepository(async (cwd) => {
    await write(cwd, 'config/query-sets/v1.json', '{"version":1}\n');
    commit(cwd, 'seed query version');
    git(cwd, ['checkout', '-b', 'feature']);
    await write(cwd, 'config/query-sets/v1.json', '{"version":"feature"}\n');
    const featureHead = commit(cwd, 'feature changes protected version');
    git(cwd, ['checkout', 'main']);
    await write(cwd, 'main.txt', 'main branch only\n');
    commit(cwd, 'main changes outside protected directories');
    git(cwd, ['-c', 'user.name=append-only-selftest', '-c', 'user.email=selftest@example.invalid', 'merge', '--no-ff', 'feature', '-m', 'malicious merge parent delta']);
    const head = git(cwd, ['rev-parse', 'HEAD']);
    expectBlocked(cwd, 'protected merge delta against a parent', featureHead, head);

    await expectGuardMutationIsCaught(
      cwd,
      'skipping the first merge parent',
      1,
      [featureHead, head],
      (source) => source.replace(
        'for (const parent of parents.length === 0 ? [EMPTY_TREE] : parents) {',
        'for (const parent of parents.length === 0 ? [EMPTY_TREE] : parents.slice(1)) {'
      )
    );
  });
}

await verifyAppendOnlyHistory();
await verifyAddedSymlinkBypassIsBlocked();
await verifyAddedQueryObjectsArePlainJsonBlobs();
await verifyQuerySetCollectionHistory();
await verifyWiringIsWatched();
await verifyEveryIntroducedCommitIsChecked();
await verifyTopologyAndObjectValidation();
await verifyBlockingWiringIsWatched();
await verifyMergeSemantics();
console.log('append-only config self-test: PASS');

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, test } from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  exportPublicTree,
  loadExportMap,
  prohibitedPublicPath,
  verifyPublicHistory,
  verifyPublicTree,
} from './lib/public-export.mjs';

const REQUIRED_FEEDBACK_DESTINATIONS = [
  'docs/FEEDBACK-SETUP.md',
  'docs/FEEDBACK-SMOKE.md',
  'docs/superpowers/specs/2026-09-06-authenticated-reviewer-feedback-design.md',
  'docs/superpowers/plans/2026-09-06-authenticated-reviewer-feedback.md',
  'supabase/migrations/202609060001_reviewer_feedback.sql',
  'supabase/functions/moderate-feedback/policy.mjs',
  'supabase/functions/moderate-feedback/index.ts',
  'docs/evidence/feedback-config.mjs',
  'docs/evidence/feedback-core.mjs',
  'docs/evidence/feedback.mjs',
  'docs/evidence/feedback.bundle.js',
  'scripts/build-feedback.mjs',
  'scripts/verify-reviewer-feedback-schema.mjs',
  'scripts/verify-reviewer-feedback-function.mjs',
  'scripts/verify-reviewer-feedback-client.mjs',
];

const scratchRoots = [];
const execFile = promisify(execFileCallback);

function exportedPath(source, destination) {
  const sourcePath = resolve(source);
  return existsSync(sourcePath) ? sourcePath : resolve(destination);
}

after(async () => {
  await Promise.all(scratchRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('requires every public reviewer-feedback artifact in the export map', async () => {
  const exportMap = await loadExportMap(resolve('config/public-export.json'));
  for (const destination of REQUIRED_FEEDBACK_DESTINATIONS) {
    assert.equal(exportMap.files.some((entry) => entry.destination === destination), true, destination);
  }
});


test('documents redirectTo fragment transport and allowlist matching', async () => {
  const setup = await readFile(resolve('docs/FEEDBACK-SETUP.md'), 'utf8');
  const client = await readFile(exportedPath('public/docs/evidence/feedback.mjs', 'docs/evidence/feedback.mjs'), 'utf8');
  assert.match(setup, /https:\/\/\$\{SUPABASE_PROJECT_REF\}\.supabase\.co\/auth\/v1\/callback/);
  assert.match(setup, /https:\/\/vatsalyab\.github\.io\/hiring-observatory\/docs\/evidence\//);
  assert.match(setup, /http:\/\/localhost:8000\/docs\/evidence\//);
  assert.match(setup, /http:\/\/127\.0\.0\.1:8000\/docs\/evidence\//);
  assert.match(client, /redirectTo:\s*location\.href\.split\('#'\)\[0\]\s*\+\s*'#feedback-comment'/);
  assert.match(setup, /passes the full dashboard URL with #feedback-comment as redirectTo/i);
  assert.match(setup, /URL-encodes that full value as redirect_to/i);
  assert.match(setup, /GoTrue (?:ignores|strips) the fragment only when matching redirect\s+allowlists/i);
  assert.match(setup, /without #feedback-comment/i);
});

test('documents the sanitized PostgREST rate-limit retry contract', async () => {
  const smoke = await readFile(resolve('docs/FEEDBACK-SMOKE.md'), 'utf8');
  assert.match(smoke, /message.*rate limit exceeded/i);
  assert.match(smoke, /details.*retry_at=<UTC timestamp>/i);
  assert.match(smoke, /earliest submission still inside the rolling 60-minute window/i);
});

test('prompts for moderator login without exporting a moderator identity', async () => {
  const setup = await readFile(resolve('docs/FEEDBACK-SETUP.md'), 'utf8');
  const plan = await readFile(resolve('docs/superpowers/plans/2026-09-06-authenticated-reviewer-feedback.md'), 'utf8');
  for (const document of [setup, plan]) {
    assert.match(document, /read -r -p "Moderator GitHub login: " MODERATOR_GITHUB_LOGIN/);
    assert.match(document, /test -n "\$MODERATOR_GITHUB_LOGIN"/);
    assert.match(document, /secrets set MODERATOR_GITHUB_LOGINS="\$MODERATOR_GITHUB_LOGIN"/);
  }

  const exportMap = await loadExportMap(resolve('config/public-export.json'));
  const disclosedLogin = ['vatsalya', 'b'].join('');
  const standaloneLogin = new RegExp(`(^|[^/:.\\w-])${disclosedLogin}(?=$|[^.\\w-])`, 'im');
  for (const { source, destination } of exportMap.files) {
    assert.doesNotMatch(await readFile(exportedPath(source, destination), 'utf8'), standaloneLogin, destination);
  }
});

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'public-export-test-'));
  scratchRoots.push(root);
  const sourceRoot = join(root, 'source');
  const destinationRoot = join(root, 'destination');
  const mapPath = join(sourceRoot, 'config', 'public-export.json');
  await mkdir(join(sourceRoot, 'config'), { recursive: true });
  return { root, sourceRoot, destinationRoot, mapPath };
}

async function write(path, content) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function writeMap(path, files) {
  await write(path, `${JSON.stringify({ files }, null, 2)}\n`);
}

async function git(repository, ...args) {
  return execFile('git', args, { cwd: repository, encoding: 'utf8' });
}

async function makeRepository() {
  const root = await mkdtemp(join(tmpdir(), 'public-history-test-'));
  scratchRoots.push(root);
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Public Export Test');
  await git(root, 'config', 'user.email', 'public-export-test@example.invalid');
  return root;
}

async function commitAll(repository, message) {
  await git(repository, 'add', '--all');
  await git(repository, 'commit', '-m', message);
}

test('copies only explicit mappings and supports public overlays', async () => {
  const { sourceRoot, destinationRoot, mapPath } = await makeFixture();
  await write(join(sourceRoot, 'public', 'README.md'), '# Public\n');
  await write(join(sourceRoot, 'private.txt'), 'must not cross\n');
  await writeMap(mapPath, [
    { source: 'public/README.md', destination: 'README.md' },
  ]);

  const result = await exportPublicTree({ sourceRoot, destinationRoot, mapPath });

  assert.deepEqual(result.files, ['README.md']);
  assert.equal(await readFile(join(destinationRoot, 'README.md'), 'utf8'), '# Public\n');
  await assert.rejects(readFile(join(destinationRoot, 'private.txt'), 'utf8'), { code: 'ENOENT' });

  await git(destinationRoot, 'init', '-b', 'main');
  assert.deepEqual((await verifyPublicTree({ treeRoot: destinationRoot, mapPath })).files, ['README.md']);
});

test('fresh public history tracks the aggregate evidence bundle', async () => {
  const { sourceRoot, destinationRoot, mapPath } = await makeFixture();
  await write(join(sourceRoot, '.gitignore'), await readFile(resolve('.gitignore'), 'utf8'));
  await write(join(sourceRoot, 'pilot.json'), '{"schema_version":1}\n');
  await writeMap(mapPath, [
    { source: '.gitignore', destination: '.gitignore' },
    { source: 'pilot.json', destination: 'docs/evidence/data/pilot.json' },
  ]);
  await exportPublicTree({ sourceRoot, destinationRoot, mapPath });
  await git(destinationRoot, 'init', '-b', 'main');
  await git(destinationRoot, 'add', '--all');
  const tracked = await git(destinationRoot, 'ls-files', 'docs/evidence/data/pilot.json');
  assert.equal(tracked.stdout.trim(), 'docs/evidence/data/pilot.json');
});

test('rejects traversal, absolute paths, and duplicate destinations', async () => {
  const { mapPath } = await makeFixture();

  for (const files of [
    [{ source: '../private.txt', destination: 'private.txt' }],
    [{ source: 'safe.txt', destination: '../escape.txt' }],
    [{ source: '/absolute.txt', destination: 'absolute.txt' }],
    [
      { source: 'one.txt', destination: 'README.md' },
      { source: 'two.txt', destination: 'README.md' },
    ],
  ]) {
    await writeMap(mapPath, files);
    await assert.rejects(loadExportMap(mapPath), /relative POSIX path|duplicate destination/i);
  }
});

test('rejects prohibited public paths and unexpected files', async () => {
  const { sourceRoot, destinationRoot, mapPath } = await makeFixture();
  await write(join(sourceRoot, 'README.md'), '# Public\n');
  await writeMap(mapPath, [{ source: 'README.md', destination: 'README.md' }]);
  await exportPublicTree({ sourceRoot, destinationRoot, mapPath });
  await write(join(destinationRoot, 'raw', 'source', '2026-08-12.json'), '{}\n');

  await assert.rejects(
    verifyPublicTree({ treeRoot: destinationRoot, mapPath }),
    /prohibited public path.*raw\/source\/2026-08-12\.json/i,
  );
});

test('rejects remapping a prohibited private source to a harmless destination', async () => {
  const { sourceRoot, destinationRoot, mapPath } = await makeFixture();
  await write(join(sourceRoot, 'raw', 'source', 'capture.json'), '{}\n');
  await writeMap(mapPath, [
    { source: 'raw/source/capture.json', destination: 'examples/capture.json' },
  ]);

  await assert.rejects(
    exportPublicTree({ sourceRoot, destinationRoot, mapPath }),
    /prohibited allowlisted source.*raw\/source\/capture\.json/i,
  );
});

test('rejects private paths in export maps and public trees', async () => {
  const privateEvaluationPath = ['private', 'evaluation', 'v1', 'manifest.json'].join('/');
  assert.equal(prohibitedPublicPath(privateEvaluationPath), true);
  assert.equal(prohibitedPublicPath('docs/private/evidence.json'), true);
  assert.equal(prohibitedPublicPath('private-notes.md'), false);

  for (const files of [
    [{ source: privateEvaluationPath, destination: 'docs/evidence/data/safe.json' }],
    [{ source: 'docs/evidence/data/safe.json', destination: 'private/evidence.json' }],
  ]) {
    const fixture = await makeFixture();
    await writeMap(fixture.mapPath, files);
    await assert.rejects(loadExportMap(fixture.mapPath), /prohibited (?:allowlisted source|public path)/i);
  }

  const tree = await makeFixture();
  await write(join(tree.destinationRoot, 'README.md'), '# Public\n');
  await write(join(tree.destinationRoot, 'private', 'evaluation', 'v1', 'snapshot.json'), '{}\n');
  await writeMap(tree.mapPath, [
    { source: 'README.md', destination: 'README.md' },
  ]);
  await assert.rejects(
    verifyPublicTree({ treeRoot: tree.destinationRoot, mapPath: tree.mapPath }),
    /prohibited public path.*private\/evaluation\/v1\/snapshot\.json/i,
  );
});

test('rejects production schedules and non-synthetic advert fixtures', async () => {
  const production = await makeFixture();
  await write(join(production.sourceRoot, 'workflow.yml'), 'on:\n  schedule:\n');
  await writeMap(production.mapPath, [
    { source: 'workflow.yml', destination: '.github/workflows/ingest.yml' },
  ]);
  await assert.rejects(
    exportPublicTree(production),
    /prohibited public path.*ingest\.yml/i,
  );

  const fixture = await makeFixture();
  await write(
    join(fixture.sourceRoot, 'fixture.json'),
    `${JSON.stringify({ results: [{ id: 'real-looking', title: 'Example role' }] })}\n`,
  );
  await writeMap(fixture.mapPath, [
    { source: 'fixture.json', destination: 'adapters/fixtures/adzuna-nz.json' },
  ]);
  await assert.rejects(
    exportPublicTree(fixture),
    /fixture_kind.*synthetic/i,
  );
});

test('rejects ATS operational, private-fixture, registry, and cohort paths', async () => {
  for (const destination of [
    'adapters/fixtures/private/greenhouse.json',
    'config/ats-employers.json',
    'config/ats-panel.json',
    'config/cohorts/nz-ats-2026q4-v1.json',
    'config/cohorts/nz-ats-2026q4-v2.json',
  ]) {
    const fixture = await makeFixture();
    await write(join(fixture.sourceRoot, 'candidate.json'), '{"fixture_kind":"synthetic"}\n');
    await writeMap(fixture.mapPath, [{ source: 'candidate.json', destination }]);
    await assert.rejects(exportPublicTree(fixture), /prohibited public path/i);
  }
});

test('requires nested ATS fixtures to be explicitly synthetic', async () => {
  const fixture = await makeFixture();
  await write(join(fixture.sourceRoot, 'fixture.json'), '{"jobs":[]}\n');
  await writeMap(fixture.mapPath, [
    { source: 'fixture.json', destination: 'adapters/fixtures/ats/greenhouse.json' },
  ]);
  await assert.rejects(exportPublicTree(fixture), /fixture_kind.*synthetic/i);
});

test('rejects unsafe evidence JSON and private repository locator text', async () => {
  const unsafeEvidence = [
    { records: [{ id: 'source-row' }] },
    { source_url: 'https://jobs.example.invalid/board' },
    {
      id: 'row-1',
      title: 'Data Engineer',
      description: 'Captured source payload',
      company: 'Example',
      location: 'Auckland',
      url: 'https://jobs.example.invalid/row-1',
    },
  ];
  for (const document of unsafeEvidence) {
    const fixture = await makeFixture();
    await write(join(fixture.sourceRoot, 'pilot.json'), `${JSON.stringify(document)}\n`);
    await writeMap(fixture.mapPath, [
      { source: 'pilot.json', destination: 'docs/evidence/data/pilot.json' },
    ]);
    await assert.rejects(exportPublicTree(fixture), /unsafe evidence JSON/i);
  }

  const locator = await makeFixture();
  const privateSlug = `hiring-observatory${'-private'}`;
  await write(join(locator.sourceRoot, 'README.md'), `https://github.com/example/${privateSlug}\n`);
  await writeMap(locator.mapPath, [{ source: 'README.md', destination: 'README.md' }]);
  await assert.rejects(exportPublicTree(locator), /private repository locator/i);
});

test('permits aggregate evidence labels without allowing private review labels', async () => {
  const aggregate = await makeFixture();
  await write(join(aggregate.sourceRoot, 'pilot.json'), JSON.stringify({
    periods: [{ id: 'pilot', label: 'pilot release' }],
  }) + '\n');
  await writeMap(aggregate.mapPath, [
    { source: 'pilot.json', destination: 'docs/evidence/data/pilot.json' },
  ]);
  assert.deepEqual(
    (await exportPublicTree(aggregate)).files,
    ['docs/evidence/data/pilot.json'],
  );

  const repository = await makeRepository();
  await write(join(repository, 'docs', 'evidence', 'data', 'pilot.json'), JSON.stringify({
    periods: [{ id: 'pilot', label: 'pilot release' }],
  }) + '\n');
  await commitAll(repository, 'public aggregate evidence');
  await verifyPublicHistory(repository);

  const privateReview = await makeFixture();
  await write(join(privateReview.sourceRoot, 'review.json'), JSON.stringify({ human_label: 'eligible' }) + '\n');
  await writeMap(privateReview.mapPath, [{ source: 'review.json', destination: 'docs/evidence/data/pilot.json' }]);
  await assert.rejects(exportPublicTree(privateReview), /unsafe evidence JSON/i);
});

test('permits the allowlisted package lock while retaining generic JSON scanning', async () => {
  const packageLock = await makeFixture();
  await write(join(packageLock.sourceRoot, 'package-lock.json'), JSON.stringify({
    name: 'fixture',
    packages: {
      'node_modules/fixture': {
        resolved: 'https://registry.npmjs.org/fixture.tgz',
        funding: { url: 'https://funding.example.test/fixture' },
      },
    },
  }) + '\n');
  await writeMap(packageLock.mapPath, [{ source: 'package-lock.json', destination: 'package-lock.json' }]);
  assert.deepEqual((await exportPublicTree(packageLock)).files, ['package-lock.json']);

  const ordinaryJson = await makeFixture();
  await write(join(ordinaryJson.sourceRoot, 'document.json'), JSON.stringify({
    resolved: 'https://registry.npmjs.org/fixture.tgz',
  }) + '\n');
  await writeMap(ordinaryJson.mapPath, [{ source: 'document.json', destination: 'examples/document.json' }]);
  await assert.rejects(exportPublicTree(ordinaryJson), /unsafe evidence JSON/i);

  const repository = await makeRepository();
  await write(join(repository, 'package-lock.json'), JSON.stringify({
    packages: {
      'node_modules/fixture': { resolved: 'https://registry.npmjs.org/fixture.tgz' },
    },
  }) + '\n');
  await commitAll(repository, 'public dependency lock');

  const sensitiveLock = await makeFixture();
  await write(join(sensitiveLock.sourceRoot, 'package-lock.json'), JSON.stringify({
    packages: { 'node_modules/fixture': { resolved: 'https://registry.npmjs.org/fixture.tgz' } },
    human_label: 'private review',
  }) + '\n');
  await writeMap(sensitiveLock.mapPath, [{ source: 'package-lock.json', destination: 'package-lock.json' }]);
  await assert.rejects(exportPublicTree(sensitiveLock), /unsafe evidence JSON/i);

  const unrelatedUrlLock = await makeFixture();
  await write(join(unrelatedUrlLock.sourceRoot, 'package-lock.json'), JSON.stringify({
    packages: { 'node_modules/fixture': { resolved: 'https://registry.npmjs.org/fixture.tgz' } },
    callback_url: 'https://private.example.test/callback',
  }) + '\n');
  await writeMap(unrelatedUrlLock.mapPath, [{ source: 'package-lock.json', destination: 'package-lock.json' }]);
  await assert.rejects(exportPublicTree(unrelatedUrlLock), /unsafe evidence JSON/i);


  const sensitiveHistory = await makeRepository();
  await write(join(sensitiveHistory, 'package-lock.json'), JSON.stringify({
    packages: { 'node_modules/fixture': { integrity: 'sha512-test', resolved: 'https://registry.npmjs.org/fixture.tgz' } },
    evidence_note: 'private review',
  }) + '\n');
  await commitAll(sensitiveHistory, 'sensitive dependency lock');
  await assert.rejects(verifyPublicHistory(sensitiveHistory), /unsafe evidence JSON/i);

  await verifyPublicHistory(repository);
});
test('permits package lock URLs only in dependency entries', async () => {
  const modern = {
    lockfileVersion: 3,
    packages: {
      'node_modules/fixture': {
        resolved: 'https://registry.npmjs.org/fixture.tgz',
        integrity: 'sha512-fixture',
        funding: { url: 'https://funding.example.test/fixture' },
      },
    },
  };
  const legacy = {
    lockfileVersion: 1,
    dependencies: {
      fixture: {
        resolved: 'https://registry.npmjs.org/fixture.tgz',
        integrity: 'sha512-fixture',
        funding: { url: 'https://funding.example.test/fixture' },
      },
    },
  };

  for (const document of [modern, legacy]) {
    const fixture = await makeFixture();
    await write(join(fixture.sourceRoot, 'package-lock.json'), JSON.stringify(document) + '\n');
    await writeMap(fixture.mapPath, [{ source: 'package-lock.json', destination: 'package-lock.json' }]);
    assert.deepEqual((await exportPublicTree(fixture)).files, ['package-lock.json']);

    const repository = await makeRepository();
    await write(join(repository, 'package-lock.json'), JSON.stringify(document) + '\n');
    await commitAll(repository, 'valid dependency lock');
    await verifyPublicHistory(repository);
  }

  const dependencyEntry = {
    resolved: 'https://registry.npmjs.org/fixture.tgz',
    integrity: 'sha512-fixture',
    funding: { url: 'https://funding.example.test/fixture' },
  };
  const rejected = [
    {
      lockfileVersion: 3,
      packages: {
        'node_modules/fixture': {
          dependencies: {
            nested: { resolved: 'https://registry.npmjs.org/nested.tgz' },
          },
        },
      },
    },
    { resolved: 'https://registry.npmjs.org/fixture.tgz' },
    { funding: { url: 'https://funding.example.test/fixture' } },
    { packages: { 'node_modules/fixture': dependencyEntry }, human_label: 'private review' },
    { packages: { 'node_modules/fixture': dependencyEntry }, evidence_note: 'private review' },
    { packages: { 'node_modules/fixture': dependencyEntry }, description: 'private payload' },
    { packages: { 'node_modules/fixture': dependencyEntry }, results: [] },
    {
      packages: { 'node_modules/fixture': dependencyEntry },
      sample: {
        id: 'row-1',
        title: 'Data Engineer',
        description: 'Captured source payload',
        company: 'Example',
        location: 'Auckland',
        url: 'https://jobs.example.invalid/row-1',
      },
    },
    { packages: { 'node_modules/fixture': dependencyEntry }, callback_url: 'https://private.example.test/callback' },
  ];

  for (const document of rejected) {
    const fixture = await makeFixture();
    await write(join(fixture.sourceRoot, 'package-lock.json'), JSON.stringify(document) + '\n');
    await writeMap(fixture.mapPath, [{ source: 'package-lock.json', destination: 'package-lock.json' }]);
    await assert.rejects(exportPublicTree(fixture), /unsafe evidence JSON/i);

    const repository = await makeRepository();
    await write(join(repository, 'package-lock.json'), JSON.stringify(document) + '\n');
    await commitAll(repository, 'invalid dependency lock');
    await assert.rejects(verifyPublicHistory(repository), /unsafe evidence JSON/i);
  }
});


test('rejects renamed evaluation descriptions and human evidence while permitting synthetic fixtures', async () => {
  for (const document of [
    { record_key: 'candidate-1', redacted_description: 'Captured advert text' },
    { review_key: 'candidate-1', human_label: 'eligible', evidence_note: 'Reviewer rationale' },
  ]) {
    const fixture = await makeFixture();
    await write(join(fixture.sourceRoot, 'pilot.json'), JSON.stringify(document) + '\n');
    await writeMap(fixture.mapPath, [
      { source: 'pilot.json', destination: 'docs/evidence/data/pilot.json' },
    ]);
    await assert.rejects(exportPublicTree(fixture), /unsafe evidence JSON/i);
  }

  const locator = await makeFixture();
  await write(join(locator.sourceRoot, 'README.md'), ['See ', 'private', '/evaluation/v1/manifest.json for the review corpus.\n'].join(''));
  await writeMap(locator.mapPath, [{ source: 'README.md', destination: 'README.md' }]);
  await assert.rejects(exportPublicTree(locator), /private repository locator/i);

  const synthetic = await makeFixture();
  await write(
    join(synthetic.sourceRoot, 'fixture.json'),
    JSON.stringify({
      fixture_kind: 'synthetic',
      jobs: [{ id: 'example-1', title: 'Example role', description: 'Synthetic advert text' }],
    }) + '\n',
  );
  await writeMap(synthetic.mapPath, [
    { source: 'fixture.json', destination: 'adapters/fixtures/ats/example.json' },
  ]);
  assert.deepEqual(
    (await exportPublicTree(synthetic)).files,
    ['adapters/fixtures/ats/example.json'],
  );
});

test('rejects sensitive evaluation fields in JSON outside public evidence paths', async () => {
  const fixture = await makeFixture();
  await write(join(fixture.sourceRoot, 'review.json'), JSON.stringify({
    human_label: 'eligible',
    gold_label: 'positive',
    evidence_quote: 'Reviewer evidence',
    confidence: 0.98,
    sampling_hint: 'stratum-a',
  }) + '\n');
  await writeMap(fixture.mapPath, [{ source: 'review.json', destination: 'examples/review.json' }]);
  await assert.rejects(exportPublicTree(fixture), /unsafe evidence JSON/i);

  const repository = await makeRepository();
  await write(join(repository, 'README.md'), '# Public\n');
  await write(join(repository, 'examples', 'review.json'), JSON.stringify({ human_label: 'eligible' }) + '\n');
  await commitAll(repository, 'plant human label');
  await assert.rejects(verifyPublicHistory(repository), /unsafe evidence JSON/i);
});

test('rejects each standalone sensitive evaluation field outside fixtures', async () => {
  for (const document of [
    { human_label: 'eligible' },
    { gold_label: 'positive' },
    { evidence_quote: 'Reviewer evidence' },
    { confidence: 0.98 },
    { sampling_hint: 'stratum-a' },
  ]) {
    const fixture = await makeFixture();
    await write(join(fixture.sourceRoot, 'review.json'), JSON.stringify(document) + '\n');
    await writeMap(fixture.mapPath, [{ source: 'review.json', destination: 'examples/review.json' }]);
    await assert.rejects(exportPublicTree(fixture), /unsafe evidence JSON/i);
  }
});

test('accepts a fresh public history with one clean root', async () => {
  const repository = await makeRepository();
  await write(join(repository, 'README.md'), '# Public\n');
  await commitAll(repository, 'public root');

  const result = await verifyPublicHistory(repository);

  assert.equal(result.roots.length, 1);
  assert.equal(result.commits.length, 1);
});

test('rejects a history containing a second root', async () => {
  const repository = await makeRepository();
  await write(join(repository, 'README.md'), '# Public\n');
  await commitAll(repository, 'public root');
  await git(repository, 'checkout', '--orphan', 'unrelated');
  await git(repository, 'rm', '-rf', '.');
  await write(join(repository, 'OTHER.md'), '# Other root\n');
  await commitAll(repository, 'other root');
  await git(repository, 'checkout', 'main');
  await git(repository, 'merge', '--allow-unrelated-histories', 'unrelated', '-m', 'merge unrelated root');

  await assert.rejects(verifyPublicHistory(repository), /exactly one root commit.*found 2/i);
});

test('rejects prohibited paths in deleted historical commits', async () => {
  const repository = await makeRepository();
  await write(join(repository, 'README.md'), '# Public\n');
  await commitAll(repository, 'public root');
  await write(join(repository, 'raw', 'source', '2026-08-12.json'), '{}\n');
  await commitAll(repository, 'plant raw');
  await git(repository, 'rm', '-r', 'raw');
  await commitAll(repository, 'delete raw');

  await assert.rejects(verifyPublicHistory(repository), /prohibited historical path.*raw\/source\/2026-08-12\.json/i);
});

test('rejects private paths in deleted historical commits', async () => {
  const repository = await makeRepository();
  await write(join(repository, 'README.md'), '# Public\n');
  await commitAll(repository, 'public root');
  await write(join(repository, 'private', 'evaluation', 'v1', 'snapshot.json'), '{}\n');
  await commitAll(repository, 'plant private snapshot');
  await git(repository, 'rm', '-r', 'private');
  await commitAll(repository, 'delete private snapshot');

  await assert.rejects(
    verifyPublicHistory(repository),
    /prohibited historical path.*private\/evaluation\/v1\/snapshot\.json/i,
  );
});

test('rejects deleted ATS cohort paths and unsafe evidence in public history', async () => {
  const prohibited = await makeRepository();
  await write(join(prohibited, 'README.md'), '# Public\n');
  await commitAll(prohibited, 'public root');
  await write(join(prohibited, 'config', 'cohorts', 'nz-ats-2026q4-v1.json'), '{}\n');
  await commitAll(prohibited, 'plant cohort');
  await git(prohibited, 'rm', '-r', 'config/cohorts');
  await commitAll(prohibited, 'delete cohort');
  await assert.rejects(verifyPublicHistory(prohibited), /prohibited historical path.*config\/cohorts/i);

  const evidence = await makeRepository();
  await write(join(evidence, 'README.md'), '# Public\n');
  await write(join(evidence, 'docs', 'evidence', 'data', 'pilot.json'), '{"jobs":[]}\n');
  await commitAll(evidence, 'plant source payload');
  await assert.rejects(verifyPublicHistory(evidence), /unsafe evidence JSON/i);
});

test('rejects listing-like JSON outside marked synthetic fixtures', async () => {
  const repository = await makeRepository();
  await write(join(repository, 'README.md'), '# Public\n');
  await write(
    join(repository, 'examples', 'listing.json'),
    `${JSON.stringify({
      id: '123',
      title: 'Data Engineer',
      description: 'Captured advert text',
      redirect_url: 'https://jobs.example.test/123',
      company: { display_name: 'Example' },
      location: { display_name: 'Auckland' },
    })}\n`,
  );
  await commitAll(repository, 'plant listing-shaped data');

  await assert.rejects(verifyPublicHistory(repository), /unsafe evidence JSON.*examples\/listing\.json/i);
});

const treeFlag = process.argv.indexOf('--tree');
if (treeFlag >= 0) {
  const treeRoot = resolve(process.argv[treeFlag + 1] ?? '.');
  test('current public tree matches the exact export allowlist', async () => {
    await verifyPublicTree({
      treeRoot,
      mapPath: join(treeRoot, 'config', 'public-export.json'),
    });
  });
}

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import {
  exportPublicTree,
  loadExportMap,
  verifyPublicHistory,
  verifyPublicTree,
} from './lib/public-export.mjs';

const scratchRoots = [];
const execFile = promisify(execFileCallback);

after(async () => {
  await Promise.all(scratchRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
    /unexpected public file.*raw\/source\/2026-08-12\.json/i,
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
    'config/cohorts/nz-ats-2026q4-v1.json',
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

  await assert.rejects(verifyPublicHistory(repository), /listing-like JSON.*examples\/listing\.json/i);
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

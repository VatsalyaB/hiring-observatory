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

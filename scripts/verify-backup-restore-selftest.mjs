import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = './lib/backup-restore.mjs';
const HELPER_CLI = join(ROOT, 'scripts', 'lib', 'backup-restore.mjs');
const RESTORE = join(ROOT, 'scripts', 'restore.mjs');

let passed = 0;
let failed = 0;

async function test(name, action) {
  try {
    await action();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitFor(action, detail) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await action()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`timed out waiting for ${detail}`);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function dockerCalls(path) {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function producer(destination, bytes, status = 0, delayMs = 0) {
  return {
    command: process.execPath,
    args: [
      '-e',
      `process.stdout.write(Buffer.from([${bytes}]),` +
        `()=>setTimeout(()=>process.exit(${status}),${delayMs}));`,
    ],
    destination,
  };
}

async function partials(path) {
  return (await readdir(path)).filter((name) => name.endsWith('.partial')).sort();
}

const BACKUP_MARKER_FORMAT = 'hiring-observatory-backup-generation';
const BACKUP_MARKER_VERSION = 1;

function generationPaths(dumpPath) {
  assert.match(dumpPath, /\.dump$/);
  const stem = dumpPath.slice(0, -'.dump'.length);
  return {
    dumpPath,
    globalsPath: `${stem}.globals.sql`,
    markerPath: `${stem}.complete.json`,
  };
}

async function writeTestCompletionMarker(dumpPath) {
  const generation = generationPaths(dumpPath);
  const [dumpBytes, globalsBytes] = await Promise.all([
    readFile(generation.dumpPath).then((value) => value.length),
    readFile(generation.globalsPath).then((value) => value.length),
  ]);
  await writeFile(
    generation.markerPath,
    `${JSON.stringify({
      format: BACKUP_MARKER_FORMAT,
      version: BACKUP_MARKER_VERSION,
      dump: { file: basename(generation.dumpPath), bytes: dumpBytes },
      globals: { file: basename(generation.globalsPath), bytes: globalsBytes },
    })}\n`
  );
  return generation;
}

async function frozenScratchConnectionOutcome(createScratchConnector, runRestoreProbeLifecycle) {
  const primary = Object.freeze(new Error('frozen scratch connection diagnostic'));
  const closeError = new Error('scratch client close diagnostic');
  const events = [];
  const guardedNames = [];
  const closeDiagnostics = [];
  const connectScratch = createScratchConnector({
    createClient: (name) => ({
      connect: async () => {
        events.push(`connect:${name}`);
        throw primary;
      },
      end: async () => {
        events.push(`failed-client-end:${name}`);
        throw closeError;
      },
    }),
    onCloseError: (error) => closeDiagnostics.push(error),
  });
  let thrown;
  try {
    await runRestoreProbeLifecycle({
      assertDroppable: (name) => guardedNames.push(name),
      createScratch: async (name) => events.push(`create:${name}`),
      restoreScratch: async (name) => events.push(`restore:${name}`),
      connectScratch,
      inspectScratch: async () => assert.fail('inspect must not run after connection failure'),
      closeScratch: async () => assert.fail('lifecycle received no connected client to close'),
      dropScratch: async (name) => events.push(`drop:${name}`),
      onCleanupError: () => assert.fail('guarded drop unexpectedly failed'),
    });
  } catch (error) {
    thrown = error;
  }
  return { closeDiagnostics, closeError, events, guardedNames, primary, thrown };
}

async function assertFrozenScratchConnectionContract(createScratchConnector, runRestoreProbeLifecycle) {
  const outcome = await frozenScratchConnectionOutcome(
    createScratchConnector,
    runRestoreProbeLifecycle
  );
  assert.equal(outcome.thrown instanceof TypeError, false, 'mutable-error TypeError masked primary');
  assert.equal(outcome.thrown instanceof AggregateError, true, 'combined error must be an AggregateError');
  assert.equal(outcome.thrown.message, outcome.primary.message);
  assert.equal(outcome.thrown.cause, outcome.primary);
  assert.deepEqual(outcome.thrown.errors, [outcome.primary, outcome.closeError]);
  assert.deepEqual(outcome.closeDiagnostics, [outcome.closeError]);
  assert.equal(outcome.events.at(-1), 'drop:restore_probe');
  assert.equal(
    outcome.guardedNames.every((name) => name === 'restore_probe'),
    true,
    String(outcome.guardedNames)
  );
}

const sandbox = await mkdtemp(join(tmpdir(), 'backup restore self-test '));
const canonicalRoot = join(sandbox, 'hiring-observatory');
const linkedRoot = join(sandbox, 'linked worktree');
const transferRoot = join(sandbox, 'transfer files with spaces');
const fakeBin = join(sandbox, 'fake docker bin');
const fakeDockerLog = join(sandbox, 'fake docker calls.jsonl');

try {
  await mkdir(canonicalRoot, { recursive: true });
  await mkdir(transferRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    join(fakeBin, 'docker'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_DOCKER_LOG) {
  fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
}
if (args.includes('pg_restore')) {
  if (process.env.FAKE_PG_RESTORE_STDERR) process.stderr.write(process.env.FAKE_PG_RESTORE_STDERR);
  process.exit(Number(process.env.FAKE_PG_RESTORE_STATUS ?? 0));
}
const sqlIndex = args.indexOf('-c');
if (args.includes('psql') && sqlIndex !== -1 && args[sqlIndex + 1].includes('select count(*) from pg_database')) {
  process.stdout.write('1\\n');
}
`
  );
  await chmod(join(fakeBin, 'docker'), 0o755);
  git(canonicalRoot, ['init', '--quiet', '--initial-branch=main']);
  git(canonicalRoot, ['config', 'user.name', 'Backup Restore Self-test']);
  git(canonicalRoot, ['config', 'user.email', 'backup-restore-selftest@example.invalid']);
  await writeFile(join(canonicalRoot, 'docker-compose.yml'), 'services: {}\n');
  await writeFile(join(canonicalRoot, 'README.md'), 'fixture\n');
  git(canonicalRoot, ['add', 'docker-compose.yml', 'README.md']);
  git(canonicalRoot, ['commit', '--quiet', '-m', 'test: initialise fixture']);
  git(canonicalRoot, ['worktree', 'add', '--quiet', '--detach', linkedRoot]);

  await test('linked worktree resolves the canonical repository from absolute and relative common dirs', async () => {
    const { resolveCanonicalRepository } = await import(HELPER);
    const expectedRoot = await realpath(canonicalRoot);
    const canonicalCommonResult = git(canonicalRoot, ['rev-parse', '--git-common-dir']).trim();
    const linkedCommonResult = git(linkedRoot, ['rev-parse', '--git-common-dir']).trim();
    assert.equal(canonicalCommonResult, '.git');
    assert.equal(isAbsolute(linkedCommonResult), true);
    const fromCanonical = resolveCanonicalRepository({ cwd: canonicalRoot });
    const fromLinked = resolveCanonicalRepository({ cwd: linkedRoot });
    assert.equal(fromCanonical.root, expectedRoot);
    assert.equal(fromLinked.root, expectedRoot);
    assert.equal(fromCanonical.commonDir, join(expectedRoot, '.git'));
    assert.equal(fromLinked.commonDir, join(expectedRoot, '.git'));
    assert.equal(fromCanonical.projectName, 'hiring-observatory');
    assert.equal(fromLinked.projectName, 'hiring-observatory');
  });

  await test('Compose args explicitly select the canonical project directory and file', async () => {
    const { dockerComposeArgs, resolveCanonicalRepository } = await import(HELPER);
    const expectedRoot = await realpath(canonicalRoot);
    const repository = resolveCanonicalRepository({ cwd: linkedRoot });
    assert.deepEqual(
      dockerComposeArgs(repository, 'ps', '--status', 'running', '--quiet', 'postgres'),
      [
        'compose',
        '--project-name',
        'hiring-observatory',
        '--project-directory',
        expectedRoot,
        '--file',
        join(expectedRoot, 'docker-compose.yml'),
        'ps',
        '--status',
        'running',
        '--quiet',
        'postgres',
      ]
    );
  });

  await test('canonical Compose identity rejects a root basename containing spaces', async () => {
    const { resolveCanonicalRepository } = await import(HELPER);
    const invalidRoot = join(sandbox, 'invalid project name');
    await mkdir(invalidRoot, { recursive: true });
    git(invalidRoot, ['init', '--quiet', '--initial-branch=main']);
    await writeFile(join(invalidRoot, 'docker-compose.yml'), 'services: {}\n');
    assert.throws(
      () => resolveCanonicalRepository({ cwd: invalidRoot }),
      /canonical Compose project name is invalid/
    );
  });

  await test('Compose CLI overrides a malicious COMPOSE_PROJECT_NAME from a path containing spaces', async () => {
    await rm(fakeDockerLog, { force: true });
    const result = spawnSync(
      process.execPath,
      [HELPER_CLI, 'compose', 'ps', '--quiet', 'postgres'],
      {
        cwd: linkedRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
          COMPOSE_PROJECT_NAME: '../../attacker',
          FAKE_DOCKER_LOG: fakeDockerLog,
        },
        encoding: 'utf8',
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = await dockerCalls(fakeDockerLog);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), ['compose', '--project-name', 'hiring-observatory']);
    assert.equal(calls[0].includes('../../attacker'), false);
  });

  await test('canonical resolution fails closed when docker-compose.yml is absent', async () => {
    const { resolveCanonicalRepository } = await import(HELPER);
    const compose = join(canonicalRoot, 'docker-compose.yml');
    const moved = `${compose}.missing`;
    await rename(compose, moved);
    try {
      assert.throws(
        () => resolveCanonicalRepository({ cwd: linkedRoot }),
        /canonical Compose file is not a regular file/
      );
    } finally {
      await rename(moved, compose);
    }
  });

  await test('binary stdout publishes atomically into a host path containing spaces', async () => {
    const { streamCommandStdoutToAtomicFile } = await import(HELPER);
    const destination = join(transferRoot, 'database bytes.dump');
    const first = [0, 255, 10, 13];
    const second = [128, 64, 1, 2];
    const transfer = streamCommandStdoutToAtomicFile({
      command: process.execPath,
      args: [
        '-e',
        `process.stdout.write(Buffer.from([${first}]));` +
          `setTimeout(() => process.stdout.end(Buffer.from([${second}])), 75);`,
      ],
      destination,
    });
    await waitFor(
      async () => (await readdir(transferRoot)).some((name) => name.startsWith(`${basename(destination)}.`)),
      'owned partial file'
    );
    assert.equal(await exists(destination), false, 'final became visible before the producer exited');
    const result = await transfer;
    assert.equal(result.bytes, first.length + second.length);
    assert.deepEqual(await readFile(destination), Buffer.from([...first, ...second]));
    assert.deepEqual(
      (await readdir(transferRoot)).filter((name) => name.endsWith('.partial')),
      []
    );
  });

  await test('host dump bytes stream to child stdin without text conversion', async () => {
    const { streamFileToCommand } = await import(HELPER);
    const source = join(transferRoot, 'stdin source.dump');
    const received = join(transferRoot, 'stdin received.dump');
    const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255, 10, 13]);
    await writeFile(source, bytes);
    await streamFileToCommand({
      command: process.execPath,
      args: [
        '-e',
        "const fs=require('node:fs');const out=fs.createWriteStream(process.argv[1],{flags:'wx'});process.stdin.pipe(out);",
        received,
      ],
      source,
    });
    assert.deepEqual(await readFile(received), bytes);
  });

  await test('failed stdout transfer removes only its owned partial and publishes no final', async () => {
    const { streamCommandStdoutToAtomicFile } = await import(HELPER);
    const destination = join(transferRoot, 'failed transfer.dump');
    const unrelatedPartial = join(transferRoot, 'preserve-me.partial');
    await writeFile(unrelatedPartial, 'not owned by the transfer');
    await assert.rejects(
      streamCommandStdoutToAtomicFile({
        command: process.execPath,
        args: [
          '-e',
          "process.stdout.write(Buffer.from([1,2,3]),()=>process.exit(7));",
        ],
        destination,
      }),
      /exited with status 7/
    );
    assert.equal(await exists(destination), false);
    assert.equal(await readFile(unrelatedPartial, 'utf8'), 'not owned by the transfer');
    assert.deepEqual(
      (await readdir(transferRoot)).filter(
        (name) => name.startsWith(`${basename(destination)}.`) && name.endsWith('.partial')
      ),
      []
    );
  });

  await test('backup-set second-stream failure leaves no observable final orphan', async () => {
    const { streamBackupSetAtomically } = await import(HELPER);
    assert.equal(typeof streamBackupSetAtomically, 'function', 'backup-set atomic API is missing');
    const path = join(transferRoot, 'second stream failure');
    await mkdir(path, { recursive: true });
    const dump = join(path, 'set.dump');
    const globals = join(path, 'set.globals.sql');
    const unrelated = join(path, 'unrelated.partial');
    await writeFile(unrelated, 'preserve');
    await assert.rejects(
      streamBackupSetAtomically({
        entries: [producer(dump, [0, 255, 1]), producer(globals, [2, 3, 4], 7)],
      }),
      /exited with status 7/
    );
    assert.equal(await exists(dump), false);
    assert.equal(await exists(globals), false);
    assert.equal(await readFile(unrelated, 'utf8'), 'preserve');
    assert.deepEqual(await partials(path), ['unrelated.partial']);
  });

  await test('backup-set second-publish failure rolls back its first owned final', async () => {
    const { streamBackupSetAtomically } = await import(HELPER);
    assert.equal(typeof streamBackupSetAtomically, 'function', 'backup-set atomic API is missing');
    const path = join(transferRoot, 'second publish failure');
    await mkdir(path, { recursive: true });
    const dump = join(path, 'set.dump');
    const globals = join(path, 'set.globals.sql');
    let publishes = 0;
    const publishFile = async (source, destination) => {
      publishes += 1;
      if (publishes === 2) throw new Error('injected second-publish failure');
      await link(source, destination);
    };
    await assert.rejects(
      streamBackupSetAtomically({
        entries: [producer(dump, [1, 2, 3]), producer(globals, [4, 5, 6])],
        publishFile,
      }),
      /injected second-publish failure/
    );
    assert.equal(await exists(dump), false);
    assert.equal(await exists(globals), false);
    assert.deepEqual(await partials(path), []);
  });

  await test('backup-set publication never overwrites or removes an existing final', async () => {
    const { streamBackupSetAtomically } = await import(HELPER);
    assert.equal(typeof streamBackupSetAtomically, 'function', 'backup-set atomic API is missing');
    const path = join(transferRoot, 'existing final');
    await mkdir(path, { recursive: true });
    const dump = join(path, 'set.dump');
    const globals = join(path, 'set.globals.sql');
    await writeFile(globals, 'existing globals');
    await assert.rejects(
      streamBackupSetAtomically({
        entries: [producer(dump, [1]), producer(globals, [2])],
      }),
      /refusing to overwrite existing backup/
    );
    assert.equal(await exists(dump), false);
    assert.equal(await readFile(globals, 'utf8'), 'existing globals');
    assert.deepEqual(await partials(path), []);
  });

  await test('concurrent backup-set publishers produce one complete unmixed pair', async () => {
    const { streamBackupSetAtomically } = await import(HELPER);
    assert.equal(typeof streamBackupSetAtomically, 'function', 'backup-set atomic API is missing');
    const path = join(transferRoot, 'concurrent pair');
    await mkdir(path, { recursive: true });
    const dump = join(path, 'set.dump');
    const globals = join(path, 'set.globals.sql');
    const attempts = await Promise.allSettled([
      streamBackupSetAtomically({
        entries: [producer(dump, [11, 11], 0, 30), producer(globals, [12, 12], 0, 30)],
      }),
      streamBackupSetAtomically({
        entries: [producer(dump, [21, 21]), producer(globals, [22, 22])],
      }),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    const pair = [(await readFile(dump))[0], (await readFile(globals))[0]];
    assert.equal(
      JSON.stringify(pair) === JSON.stringify([11, 12]) ||
        JSON.stringify(pair) === JSON.stringify([21, 22]),
      true,
      `mixed pair: ${pair}`
    );
    assert.deepEqual(await partials(path), []);
  });

  await test('successful backup set publishes its completion marker after both payload files', async () => {
    const { latestCompleteBackupGeneration, streamBackupSetAtomically } = await import(HELPER);
    const path = join(transferRoot, 'complete generation');
    await mkdir(path, { recursive: true });
    const dump = join(path, 'observatory-2026-08-10T01-00-00-000Z.dump');
    const globals = join(path, 'observatory-2026-08-10T01-00-00-000Z.globals.sql');
    const published = [];
    await streamBackupSetAtomically({
      entries: [producer(dump, [1, 2, 3]), producer(globals, [4, 5, 6])],
      publishFile: async (source, destination) => {
        published.push(basename(destination));
        await link(source, destination);
      },
    });
    assert.deepEqual(published, [
      basename(dump),
      basename(globals),
      'observatory-2026-08-10T01-00-00-000Z.complete.json',
    ]);
    assert.equal(typeof latestCompleteBackupGeneration, 'function');
    const selected = await latestCompleteBackupGeneration(path);
    assert.equal(selected.dumpPath, dump);
    assert.equal(selected.globalsPath, globals);
  });

  await test('newest crash orphan is rejected while an older complete generation stays selectable', async () => {
    const { latestCompleteBackupGeneration } = await import(HELPER);
    const path = join(transferRoot, 'crash generation');
    await mkdir(path, { recursive: true });

    const olderDump = join(path, 'observatory-2026-08-10T01-00-00-000Z.dump');
    const olderGlobals = generationPaths(olderDump).globalsPath;
    await writeFile(olderDump, Buffer.from([11]));
    await writeFile(olderGlobals, Buffer.from([12]));
    await writeTestCompletionMarker(olderDump);

    const newerDump = join(path, 'observatory-2026-08-10T02-00-00-000Z.dump');
    const newerGlobals = generationPaths(newerDump).globalsPath;
    const crashScript = join(path, 'crash-after-first-publish.mjs');
    await writeFile(
      crashScript,
      `import { link } from 'node:fs/promises';\n` +
        `import { streamBackupSetAtomically } from ${JSON.stringify(pathToFileURL(HELPER_CLI).href)};\n` +
        `let publishes = 0;\n` +
        `await streamBackupSetAtomically({\n` +
        `  entries: [\n` +
        `    { command: process.execPath, args: ['-e', 'process.stdout.write(Buffer.from([21]))'], destination: process.argv[2] },\n` +
        `    { command: process.execPath, args: ['-e', 'process.stdout.write(Buffer.from([22]))'], destination: process.argv[3] },\n` +
        `  ],\n` +
        `  publishFile: async (source, destination) => {\n` +
        `    publishes += 1;\n` +
        `    if (publishes === 2) process.kill(process.pid, 'SIGKILL');\n` +
        `    await link(source, destination);\n` +
        `  },\n` +
        `});\n`
    );
    const crash = spawnSync(process.execPath, [crashScript, newerDump, newerGlobals], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(crash.signal, 'SIGKILL', crash.stderr);
    assert.equal(await exists(newerDump), true, 'crash fixture did not leave the first final');
    assert.equal(await exists(newerGlobals), false, 'second final unexpectedly became visible');
    assert.equal(await exists(generationPaths(newerDump).markerPath), false);

    assert.equal(typeof latestCompleteBackupGeneration, 'function');
    const selected = await latestCompleteBackupGeneration(path);
    assert.equal(selected.dumpPath, olderDump);
    assert.equal(selected.globalsPath, olderGlobals);
    assert.equal(await exists(newerDump), true, 'selection must not delete material orphan data');
  });

  await test('restore-probe failures after create, restore, or connect always drop literal restore_probe', async () => {
    const { runRestoreProbeLifecycle } = await import(HELPER);
    assert.equal(typeof runRestoreProbeLifecycle, 'function', 'restore-probe lifecycle API is missing');
    for (const phase of ['restore', 'connect', 'inspect']) {
      const names = [];
      const events = [];
      const primary = new Error(`injected ${phase} failure`);
      let thrown;
      try {
        await runRestoreProbeLifecycle({
          assertDroppable: (name) => names.push(name),
          createScratch: async (name) => events.push(`create:${name}`),
          restoreScratch: async (name) => {
            events.push(`restore:${name}`);
            if (phase === 'restore') throw primary;
          },
          connectScratch: async (name) => {
            events.push(`connect:${name}`);
            if (phase === 'connect') throw primary;
            return { phase };
          },
          inspectScratch: async (_client, name) => {
            events.push(`inspect:${name}`);
            if (phase === 'inspect') throw primary;
          },
          closeScratch: async () => events.push('close'),
          dropScratch: async (name) => events.push(`drop:${name}`),
          onCleanupError: () => assert.fail('cleanup unexpectedly failed'),
        });
      } catch (error) {
        thrown = error;
      }
      assert.equal(thrown, primary);
      assert.equal(events.at(-1), 'drop:restore_probe');
      assert.equal(names.every((name) => name === 'restore_probe'), true, `${phase}: ${names}`);
      if (phase === 'inspect') assert.equal(events.includes('close'), true);
    }
  });

  await test('restore-probe cleanup failures are loud without masking the original diagnostic', async () => {
    const { runRestoreProbeLifecycle } = await import(HELPER);
    assert.equal(typeof runRestoreProbeLifecycle, 'function', 'restore-probe lifecycle API is missing');
    const primary = Object.freeze(new Error('original inspect diagnostic'));
    const cleanup = [];
    let thrown;
    try {
      await runRestoreProbeLifecycle({
        assertDroppable: (name) => assert.equal(name, 'restore_probe'),
        createScratch: async () => {},
        restoreScratch: async () => {},
        connectScratch: async () => ({}),
        inspectScratch: async () => { throw primary; },
        closeScratch: async () => { throw new Error('close failed'); },
        dropScratch: async (name) => {
          assert.equal(name, 'restore_probe');
          throw new Error('drop failed');
        },
        onCleanupError: (label, error) => cleanup.push(`${label}: ${error.message}`),
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, primary);
    assert.deepEqual(cleanup, ['client close: close failed', 'scratch drop: drop failed']);
  });

  await test('production scratch connector preserves frozen connection and close diagnostics before guarded drop', async () => {
    const { createScratchConnector, runRestoreProbeLifecycle } = await import(HELPER);
    assert.equal(typeof createScratchConnector, 'function', 'production scratch connector API is missing');
    await assertFrozenScratchConnectionContract(createScratchConnector, runRestoreProbeLifecycle);
  });

  await test('direct-assignment source mutation is killed by the production scratch connector contract', async () => {
    const source = await readFile(HELPER_CLI, 'utf8');
    const safeThrow = 'throw combinePrimaryAndCleanup(primaryError, closeError);';
    assert.equal(source.includes(safeThrow), true, 'safe scratch connector aggregation is missing');
    const mutantPath = join(transferRoot, 'backup-restore-direct-assignment-mutant.mjs');
    await writeFile(
      mutantPath,
      source.replace(
        safeThrow,
        'primaryError.cleanupErrors = [closeError];\n          throw primaryError;'
      )
    );
    const mutant = await import(`${pathToFileURL(mutantPath).href}?mutation=${Date.now()}`);
    await assert.rejects(
      () => assertFrozenScratchConnectionContract(
        mutant.createScratchConnector,
        mutant.runRestoreProbeLifecycle
      ),
      /mutable-error TypeError masked primary/
    );
  });

  await test('production scratch connector ordinary success closes client and drops guarded scratch', async () => {
    const { createScratchConnector, runRestoreProbeLifecycle } = await import(HELPER);
    assert.equal(typeof createScratchConnector, 'function', 'production scratch connector API is missing');
    const events = [];
    const guardedNames = [];
    const client = {
      connect: async () => events.push('connect'),
      end: async () => events.push('end'),
    };
    await runRestoreProbeLifecycle({
      assertDroppable: (name) => guardedNames.push(name),
      createScratch: async (name) => events.push(`create:${name}`),
      restoreScratch: async (name) => events.push(`restore:${name}`),
      connectScratch: createScratchConnector({ createClient: () => client }),
      inspectScratch: async (connected, name) => {
        assert.equal(connected, client);
        events.push(`inspect:${name}`);
      },
      closeScratch: (connected) => connected.end(),
      dropScratch: async (name) => events.push(`drop:${name}`),
      onCleanupError: () => assert.fail('ordinary cleanup unexpectedly failed'),
    });
    assert.deepEqual(events, [
      'create:restore_probe',
      'restore:restore_probe',
      'connect',
      'inspect:restore_probe',
      'end',
      'drop:restore_probe',
    ]);
    assert.deepEqual(guardedNames, ['restore_probe', 'restore_probe']);
  });

  const guardDump = join(transferRoot, 'guard source.dump');
  await writeFile(guardDump, Buffer.from([1]));
  await writeFile(generationPaths(guardDump).globalsPath, Buffer.from([2]));
  await writeTestCompletionMarker(guardDump);
  const guardEnv = {
    ...process.env,
    POSTGRES_DB: 'live_observatory',
    POSTGRES_USER: 'selftest_user',
    POSTGRES_PASSWORD: 'selftest-only',
    RESTORE_ALLOW_LIVE: '',
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    FAKE_DOCKER_LOG: fakeDockerLog,
  };

  await test('restore keeps --into mandatory', () => {
    const result = spawnSync(process.execPath, [RESTORE, '--from', guardDump], {
      cwd: ROOT,
      env: guardEnv,
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--into is mandatory\. There is no default, on purpose\./);
  });

  await test('restore requires POSTGRES_DB and POSTGRES_USER before any Docker call', async () => {
    for (const missing of ['POSTGRES_DB', 'POSTGRES_USER']) {
      await rm(fakeDockerLog, { force: true });
      const env = { ...guardEnv };
      delete env[missing];
      const result = spawnSync(
        process.execPath,
        [RESTORE, '--from', guardDump, '--into', 'restore_unit'],
        { cwd: ROOT, env, encoding: 'utf8' }
      );
      assert.equal(result.status, 1, `${missing}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`${missing} is not set`));
      assert.deepEqual(await dockerCalls(fakeDockerLog), [], `${missing} reached Docker`);
    }
  });

  await test('restore protects N8N_DB before any Docker call', async () => {
    await rm(fakeDockerLog, { force: true });
    const result = spawnSync(
      process.execPath,
      [RESTORE, '--from', guardDump, '--into', 'automation_live'],
      { cwd: ROOT, env: { ...guardEnv, N8N_DB: 'automation_live' }, encoding: 'utf8' }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /refusing to restore into "automation_live"/);
    assert.deepEqual(await dockerCalls(fakeDockerLog), []);
  });

  await test('restore rejects an incomplete explicit backup generation before any Docker call', async () => {
    const incompleteDump = join(transferRoot, 'incomplete source.dump');
    await writeFile(incompleteDump, Buffer.from([9]));
    await rm(fakeDockerLog, { force: true });
    const result = spawnSync(
      process.execPath,
      [RESTORE, '--from', incompleteDump, '--into', 'restore_unit'],
      { cwd: ROOT, env: guardEnv, encoding: 'utf8' }
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /complete backup generation/);
    assert.deepEqual(await dockerCalls(fakeDockerLog), []);
  });

  await test('restore rejects unsafe target forms before any Docker call', async () => {
    const unsafe = [
      'dbname=live_observatory',
      'postgres://selftest.invalid/live_observatory',
      '"live_observatory"',
      ' live_observatory',
      'live_observatory ',
      'live-observatory',
      'LIVE_OBSERVATORY',
      "safe';drop database observatory;--",
      'a'.repeat(64),
    ];
    const problems = [];
    for (const into of unsafe) {
      await rm(fakeDockerLog, { force: true });
      const result = spawnSync(
        process.execPath,
        [RESTORE, '--from', guardDump, '--into', into],
        { cwd: ROOT, env: guardEnv, encoding: 'utf8' }
      );
      const calls = await dockerCalls(fakeDockerLog);
      if (result.status !== 1 || calls.length !== 0 ||
          !/--into must be a plain lowercase PostgreSQL identifier/.test(result.stderr)) {
        problems.push({ into, status: result.status, calls: calls.length, stderr: result.stderr });
      }
    }
    assert.deepEqual(problems, []);
  });

  await test('restore keeps the protected database guard and exact live confirmation string', async () => {
    await rm(fakeDockerLog, { force: true });
    const result = spawnSync(
      process.execPath,
      [RESTORE, '--from', guardDump, '--into', 'live_observatory'],
      { cwd: ROOT, env: guardEnv, encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RESTORE_ALLOW_LIVE=yes-overwrite-the-live-database/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /restoring guard source\.dump/);
    assert.deepEqual(await dockerCalls(fakeDockerLog), []);
  });

  await test('pg_restore status mutation from zero to seven becomes a concise hard failure', async () => {
    await rm(fakeDockerLog, { force: true });
    const success = spawnSync(
      process.execPath,
      [RESTORE, '--from', guardDump, '--into', 'restore_unit'],
      {
        cwd: ROOT,
        env: { ...guardEnv, FAKE_PG_RESTORE_STATUS: '0' },
        encoding: 'utf8',
      }
    );
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /restore finished/);

    await rm(fakeDockerLog, { force: true });
    const failure = spawnSync(
      process.execPath,
      [RESTORE, '--from', guardDump, '--into', 'restore_unit'],
      {
        cwd: ROOT,
        env: {
          ...guardEnv,
          FAKE_PG_RESTORE_STATUS: '7',
          FAKE_PG_RESTORE_STDERR: 'sensitive-child-marker',
        },
        encoding: 'utf8',
      }
    );
    const calls = await dockerCalls(fakeDockerLog);
    const restoreCall = calls.find((call) => call.includes('pg_restore'));
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /ABORT  pg_restore failed \(status 7\)/);
    assert.doesNotMatch(`${failure.stdout}\n${failure.stderr}`, /sensitive-child-marker|restore finished/);
    assert.equal(restoreCall.includes('--exit-on-error'), true, JSON.stringify(restoreCall));
  });
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

console.log(`\nverify-backup-restore-selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { access, link, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function invalid(message, cause) {
  return new Error(`backup/restore: ${message}`, cause ? { cause } : undefined);
}

function regularDirectory(path, label) {
  try {
    if (!statSync(path).isDirectory()) throw invalid(`${label} is not a directory: ${path}`);
  } catch (error) {
    if (error?.message?.startsWith('backup/restore:')) throw error;
    throw invalid(`${label} is not a directory: ${path}`, error);
  }
}

const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
const BACKUP_MARKER_FORMAT = 'hiring-observatory-backup-generation';
const BACKUP_MARKER_VERSION = 1;

export function resolveCanonicalRepository({ cwd = process.cwd() } = {}) {
  regularDirectory(cwd, 'invoking directory');

  let commonResult;
  try {
    commonResult = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw invalid('cannot resolve the Git common directory', error);
  }
  if (!commonResult || commonResult.includes('\0')) {
    throw invalid('Git returned an invalid common directory');
  }

  const commonCandidate = isAbsolute(commonResult)
    ? resolve(commonResult)
    : resolve(cwd, commonResult);
  let commonDir;
  try {
    commonDir = realpathSync(commonCandidate);
  } catch (error) {
    throw invalid(`Git common directory does not exist: ${commonCandidate}`, error);
  }
  regularDirectory(commonDir, 'Git common directory');
  if (basename(commonDir) !== '.git') {
    throw invalid(`Git common directory is not a canonical .git directory: ${commonDir}`);
  }

  let root;
  try {
    root = realpathSync(dirname(commonDir));
  } catch (error) {
    throw invalid(`canonical repository root does not exist: ${dirname(commonDir)}`, error);
  }
  regularDirectory(root, 'canonical repository root');

  const projectName = basename(root);
  if (!COMPOSE_PROJECT.test(projectName)) {
    throw invalid(`canonical Compose project name is invalid: ${projectName}`);
  }

  const composeFile = join(root, 'docker-compose.yml');
  try {
    if (!statSync(composeFile).isFile()) {
      throw invalid(`canonical Compose file is not a regular file: ${composeFile}`);
    }
  } catch (error) {
    if (error?.message?.startsWith('backup/restore:')) throw error;
    throw invalid(`canonical Compose file is not a regular file: ${composeFile}`, error);
  }

  return Object.freeze({ commonDir, root, composeFile, projectName });
}

export function dockerComposeArgs(repository, ...args) {
  if (!repository?.root || !repository?.composeFile || !COMPOSE_PROJECT.test(repository.projectName)) {
    throw invalid('canonical repository context is required for Docker Compose');
  }
  return [
    'compose',
    '--project-name',
    repository.projectName,
    '--project-directory',
    repository.root,
    '--file',
    repository.composeFile,
    ...args,
  ];
}

function runChild({ command, args, cwd, env, stdin = 'ignore', stdout = 'inherit', stderr = 'inherit', encoding }) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(command, args, { cwd, env, stdio: [stdin, stdout, stderr] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    if (child.stdout) child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    if (child.stderr) child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      rejectChild(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      const stdoutValue = Buffer.concat(stdoutChunks);
      const stderrValue = Buffer.concat(stderrChunks);
      if (code === 0) {
        resolveChild({
          stdout: encoding ? stdoutValue.toString(encoding) : stdoutValue,
          stderr: encoding ? stderrValue.toString(encoding) : stderrValue,
        });
        return;
      }
      const status = code === null ? `signal ${signal ?? 'unknown'}` : `status ${code}`;
      const error = invalid(`${command} exited with ${status}`);
      error.status = code;
      error.signal = signal;
      error.stdout = encoding ? stdoutValue.toString(encoding) : stdoutValue;
      error.stderr = encoding ? stderrValue.toString(encoding) : stderrValue;
      rejectChild(error);
    });
  });
}

async function assertDestinationAbsent(destination) {
  try {
    await access(destination);
    throw invalid(`refusing to overwrite existing backup: ${destination}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function backupGenerationPaths(dumpPath) {
  if (typeof dumpPath !== 'string' || !dumpPath.endsWith('.dump')) {
    throw invalid('complete backup generation requires a .dump path');
  }
  const absoluteDump = resolve(dumpPath);
  const stem = absoluteDump.slice(0, -'.dump'.length);
  return Object.freeze({
    dumpPath: absoluteDump,
    globalsPath: `${stem}.globals.sql`,
    markerPath: `${stem}.complete.json`,
  });
}

function completionGenerationForEntries(entries) {
  if (entries.length !== 2) return null;
  const dumpEntry = entries.find((entry) => entry.destination?.endsWith('.dump'));
  if (!dumpEntry) return null;
  const generation = backupGenerationPaths(dumpEntry.destination);
  if (!entries.some((entry) => resolve(entry.destination) === generation.globalsPath)) return null;
  return generation;
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function stageCompletionMarker(generation, staged) {
  const dump = staged.find((entry) => resolve(entry.destination) === generation.dumpPath);
  const globals = staged.find((entry) => resolve(entry.destination) === generation.globalsPath);
  if (!dump || !globals) throw invalid('cannot complete a backup generation without dump and globals');

  const partial = `${generation.markerPath}.${randomUUID()}.partial`;
  let handle;
  let keepPartial = false;
  try {
    handle = await open(partial, 'wx');
    await handle.writeFile(`${JSON.stringify({
      format: BACKUP_MARKER_FORMAT,
      version: BACKUP_MARKER_VERSION,
      dump: { file: basename(generation.dumpPath), bytes: dump.bytes },
      globals: { file: basename(generation.globalsPath), bytes: globals.bytes },
    })}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const markerStat = await stat(partial);
    keepPartial = true;
    return { destination: generation.markerPath, partial, bytes: markerStat.size };
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!keepPartial) await rm(partial, { force: true });
  }
}

function incomplete(message, cause) {
  return invalid(`incomplete backup generation: ${message}`, cause);
}

async function requiredGenerationFile(path, label) {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size === 0) {
      throw incomplete(`${label} is not a non-empty regular file: ${path}`);
    }
    return fileStat;
  } catch (error) {
    if (error?.message?.startsWith('backup/restore:')) throw error;
    throw incomplete(`${label} is missing or unreadable: ${path}`, error);
  }
}

export async function readCompleteBackupGeneration(dumpPath) {
  const generation = backupGenerationPaths(dumpPath);
  const [dumpStat, globalsStat] = await Promise.all([
    requiredGenerationFile(generation.dumpPath, 'dump'),
    requiredGenerationFile(generation.globalsPath, 'globals'),
  ]);
  await requiredGenerationFile(generation.markerPath, 'completion marker');

  let marker;
  try {
    marker = JSON.parse(await readFile(generation.markerPath, 'utf8'));
  } catch (error) {
    throw incomplete(`completion marker is not valid JSON: ${generation.markerPath}`, error);
  }
  const valid = marker?.format === BACKUP_MARKER_FORMAT &&
    marker?.version === BACKUP_MARKER_VERSION &&
    marker?.dump?.file === basename(generation.dumpPath) &&
    marker?.globals?.file === basename(generation.globalsPath) &&
    Number.isSafeInteger(marker?.dump?.bytes) && marker.dump.bytes > 0 &&
    Number.isSafeInteger(marker?.globals?.bytes) && marker.globals.bytes > 0 &&
    marker.dump.bytes === dumpStat.size &&
    marker.globals.bytes === globalsStat.size;
  if (!valid) {
    throw incomplete(`completion marker does not match its dump and globals: ${generation.markerPath}`);
  }
  return Object.freeze({
    ...generation,
    dumpBytes: dumpStat.size,
    globalsBytes: globalsStat.size,
  });
}

export async function latestCompleteBackupGeneration(directory) {
  const absoluteDirectory = resolve(directory);
  let names;
  try {
    names = await readdir(absoluteDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw invalid(`cannot read backup directory: ${absoluteDirectory}`, error);
  }
  const markers = names.filter((name) => name.endsWith('.complete.json')).sort().toReversed();
  if (markers.length === 0) return undefined;
  const marker = markers[0];
  const dumpName = `${marker.slice(0, -'.complete.json'.length)}.dump`;
  return readCompleteBackupGeneration(join(absoluteDirectory, dumpName));
}

async function stageCommand(entry) {
  const { command, args = [], destination, cwd, env, stderr = 'inherit' } = entry;
  if (!command || !destination) throw invalid('command and destination are required');
  const partial = `${destination}.${randomUUID()}.partial`;
  let handle;
  let keepPartial = false;
  try {
    handle = await open(partial, 'wx');
    await runChild({ command, args, cwd, env, stdout: handle.fd, stderr });
    await handle.sync();
    await handle.close();
    handle = undefined;
    const partialStat = await stat(partial);
    if (!partialStat.isFile() || partialStat.size === 0) {
      throw invalid(`command produced an empty backup: ${destination}`);
    }
    keepPartial = true;
    return { destination, partial, bytes: partialStat.size };
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (!keepPartial) await rm(partial, { force: true });
  }
}

async function removeOwnedFinal(staged) {
  try {
    const [partialStat, finalStat] = await Promise.all([
      stat(staged.partial),
      stat(staged.destination),
    ]);
    if (partialStat.dev === finalStat.dev && partialStat.ino === finalStat.ino) {
      await rm(staged.destination);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function streamBackupSetAtomically({ entries, publishFile = link }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw invalid('at least one backup-set entry is required');
  }
  const destinations = entries.map((entry) => entry.destination);
  if (new Set(destinations).size !== destinations.length) {
    throw invalid('backup-set destinations must be unique');
  }
  const completionGeneration = completionGenerationForEntries(entries);
  for (const destination of destinations) await assertDestinationAbsent(destination);
  if (completionGeneration) await assertDestinationAbsent(completionGeneration.markerPath);

  const staged = [];
  const published = [];
  const cleanupErrors = [];
  let completionStaged;
  let result;
  let primaryError;
  try {
    for (const entry of entries) staged.push(await stageCommand(entry));
    for (const item of staged) {
      await publishFile(item.partial, item.destination);
      published.push(item);
    }
    if (completionGeneration) {
      // The marker is the only evidence readers trust. Persist both payload directory entries
      // before publishing it, so a power loss can leave an ignored orphan but never a marker that
      // names files whose links were still only in the filesystem cache.
      await syncDirectory(dirname(completionGeneration.markerPath));
      completionStaged = await stageCompletionMarker(completionGeneration, staged);
      await publishFile(completionStaged.partial, completionStaged.destination);
      published.push(completionStaged);
      await syncDirectory(dirname(completionGeneration.markerPath));
    }
    result = staged.map(({ destination, bytes }) => ({ path: destination, bytes }));
  } catch (error) {
    primaryError = error;
    for (const item of published.toReversed()) {
      try {
        await removeOwnedFinal(item);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (completionGeneration) {
      try {
        await syncDirectory(dirname(completionGeneration.markerPath));
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
  } finally {
    if (completionStaged) {
      try {
        await rm(completionStaged.partial, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    for (const item of staged) {
      try {
        await rm(item.partial, { force: true });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
  }

  if (primaryError) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], primaryError.message, { cause: primaryError });
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'backup-set cleanup failed');
  }
  return result;
}

export async function streamCommandStdoutToAtomicFile(options) {
  const [result] = await streamBackupSetAtomically({ entries: [options] });
  return result;
}

export async function streamFileToCommand({
  command,
  args = [],
  source,
  cwd,
  env,
  stdout = 'inherit',
  stderr = 'inherit',
  encoding,
}) {
  if (!command || !source) throw invalid('command and source are required');
  const handle = await open(source, 'r');
  try {
    const sourceStat = await handle.stat();
    if (!sourceStat.isFile()) throw invalid(`source is not a regular file: ${source}`);
    return await runChild({
      command,
      args,
      cwd,
      env,
      stdin: handle.fd,
      stdout,
      stderr,
      encoding,
    });
  } finally {
    await handle.close();
  }
}

function combinePrimaryAndCleanup(primaryError, closeError) {
  const message = primaryError instanceof Error ? primaryError.message : String(primaryError);
  return new AggregateError(
    [primaryError, closeError],
    message,
    { cause: primaryError }
  );
}

export function createScratchConnector({ createClient, onCloseError = () => {} }) {
  return async function connectScratch(name) {
    const client = createClient(name);
    try {
      await client.connect();
      return client;
    } catch (primaryError) {
      try {
        await client.end();
      } catch (closeError) {
        onCloseError(closeError);
        throw combinePrimaryAndCleanup(primaryError, closeError);
      }
      throw primaryError;
    }
  };
}

const RESTORE_PROBE = 'restore_probe';

export async function runRestoreProbeLifecycle({
  assertDroppable,
  createScratch,
  restoreScratch,
  connectScratch,
  inspectScratch,
  closeScratch,
  dropScratch,
  onCleanupError = () => {},
}) {
  let client;
  let cleanupNeeded = false;
  let primaryError;
  const cleanupErrors = [];

  try {
    assertDroppable(RESTORE_PROBE);
    cleanupNeeded = true;
    await createScratch(RESTORE_PROBE);
    await restoreScratch(RESTORE_PROBE);
    client = await connectScratch(RESTORE_PROBE);
    await inspectScratch(client, RESTORE_PROBE);
  } catch (error) {
    primaryError = error;
  } finally {
    if (client) {
      try {
        await closeScratch(client);
      } catch (error) {
        cleanupErrors.push(error);
        onCleanupError('client close', error);
      }
    }
    if (cleanupNeeded) {
      try {
        assertDroppable(RESTORE_PROBE);
        await dropScratch(RESTORE_PROBE);
      } catch (error) {
        cleanupErrors.push(error);
        onCleanupError('scratch drop', error);
      }
    }
  }

  if (primaryError) {
    if (cleanupErrors.length > 0 && primaryError instanceof Error) {
      try {
        Object.defineProperty(primaryError, 'cleanupErrors', { value: cleanupErrors });
      } catch {
        // Diagnostic metadata is best-effort; the original error must remain the thrown value.
      }
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'restore-probe cleanup failed');
  }
}

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  if (process.argv[2] !== 'compose' || process.argv.length < 4) {
    console.error('usage: node scripts/lib/backup-restore.mjs compose <docker-compose-args...>');
    process.exit(2);
  }
  try {
    const repository = resolveCanonicalRepository();
    await runChild({
      command: 'docker',
      args: dockerComposeArgs(repository, ...process.argv.slice(3)),
      cwd: repository.root,
      env: process.env,
    });
  } catch (error) {
    console.error(String(error?.stderr || error?.message || error).split('\n')[0]);
    process.exit(1);
  }
}

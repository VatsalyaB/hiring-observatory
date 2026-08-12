import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

function manifestPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    throw new Error(`${label} must be a non-empty relative POSIX path`);
  }
  const normalized = posix.normalize(value);
  if (
    posix.isAbsolute(value)
    || normalized !== value
    || normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw new Error(`${label} must be a normalized relative POSIX path: ${value}`);
  }
  return value;
}

export function prohibitedPublicPath(path) {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const basename = segments.at(-1);

  if (segments.some((segment) => ['.git', 'raw', '_manifests', 'backups'].includes(segment))) {
    return true;
  }
  if (basename?.startsWith('.env') && lower !== '.env.example') {
    return true;
  }
  if (['.github/workflows/canary.yml', '.github/workflows/ingest.yml'].includes(lower)) {
    return true;
  }
  return /\.(?:dump|backup|bak|sql\.gz|tar\.gz)$/.test(lower);
}

export async function loadExportMap(mapPath) {
  let document;
  try {
    document = JSON.parse(await readFile(mapPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read public export map ${mapPath}: ${error.message}`, { cause: error });
  }
  if (!Array.isArray(document?.files) || document.files.length === 0) {
    throw new Error('Public export map must contain a non-empty files array');
  }

  const sources = new Set();
  const destinations = new Set();
  const files = document.files.map((entry, index) => {
    const source = manifestPath(entry?.source, `files[${index}].source`);
    const destination = manifestPath(entry?.destination, `files[${index}].destination`);
    if (sources.has(source)) throw new Error(`duplicate source in public export map: ${source}`);
    if (destinations.has(destination)) throw new Error(`duplicate destination in public export map: ${destination}`);
    if (prohibitedPublicPath(source)) throw new Error(`prohibited allowlisted source: ${source}`);
    if (prohibitedPublicPath(destination)) throw new Error(`prohibited public path: ${destination}`);
    sources.add(source);
    destinations.add(destination);
    return { source, destination };
  });

  return { files };
}

async function walkFiles(root, current = '') {
  const directory = join(root, ...current.split('/').filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (current === '' && entry.name === '.git') continue;
    const path = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Public tree contains a symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Public tree contains an unsupported filesystem entry: ${path}`);
  }
  return files.sort();
}

async function requireSyntheticFixtures(treeRoot, paths) {
  for (const path of paths.filter((candidate) => /^adapters\/fixtures\/[^/]+\.json$/i.test(candidate))) {
    let fixture;
    try {
      fixture = JSON.parse(await readFile(join(treeRoot, ...path.split('/')), 'utf8'));
    } catch (error) {
      throw new Error(`Public fixture is not valid JSON: ${path}: ${error.message}`, { cause: error });
    }
    if (fixture?.fixture_kind !== 'synthetic') {
      throw new Error(`Public fixture must declare fixture_kind "synthetic": ${path}`);
    }
  }
}

export async function verifyPublicTree({ treeRoot, mapPath }) {
  const { files } = await loadExportMap(mapPath);
  const expected = files.map(({ destination }) => destination).sort();
  const actual = await walkFiles(treeRoot);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  const missing = expected.filter((path) => !actualSet.has(path));

  if (unexpected.length > 0) throw new Error(`Unexpected public file(s): ${unexpected.join(', ')}`);
  if (missing.length > 0) throw new Error(`Missing public file(s): ${missing.join(', ')}`);
  const prohibited = actual.filter(prohibitedPublicPath);
  if (prohibited.length > 0) throw new Error(`Prohibited public path(s): ${prohibited.join(', ')}`);
  await requireSyntheticFixtures(treeRoot, actual);
  return { files: actual };
}

async function git(repository, args, options = {}) {
  const result = await execFile('git', args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  return result.stdout;
}

function containsListingLikeObject(value) {
  if (Array.isArray(value)) return value.some(containsListingLikeObject);
  if (value == null || typeof value !== 'object') return false;
  const keys = new Set(Object.keys(value).map((key) => key.toLowerCase()));
  const identity = keys.has('id') || keys.has('slug') || keys.has('source_ref');
  const company = keys.has('company') || keys.has('company_name');
  const location = keys.has('location') || keys.has('location_name');
  const url = keys.has('redirect_url') || keys.has('url');
  if (identity && keys.has('title') && keys.has('description') && company && location && url) return true;
  return Object.values(value).some(containsListingLikeObject);
}

export async function verifyPublicHistory(repository) {
  const roots = (await git(repository, ['rev-list', '--max-parents=0', '--all']))
    .trim().split('\n').filter(Boolean);
  if (roots.length !== 1) {
    throw new Error(`Public history must contain exactly one root commit; found ${roots.length}`);
  }
  const commits = (await git(repository, ['rev-list', '--all'])).trim().split('\n').filter(Boolean);

  for (const commit of commits) {
    const paths = (await git(repository, ['ls-tree', '-r', '--name-only', '-z', commit]))
      .split('\0').filter(Boolean);
    const prohibited = paths.find(prohibitedPublicPath);
    if (prohibited) throw new Error(`Prohibited historical path in ${commit}: ${prohibited}`);

    for (const path of paths.filter((candidate) => candidate.toLowerCase().endsWith('.json'))) {
      const content = await git(repository, ['show', `${commit}:${path}`]);
      let document;
      try {
        document = JSON.parse(content);
      } catch (error) {
        throw new Error(`Historical JSON is invalid in ${commit}:${path}: ${error.message}`, { cause: error });
      }
      const fixture = /^adapters\/fixtures\/[^/]+\.json$/i.test(path);
      if (fixture && document?.fixture_kind !== 'synthetic') {
        throw new Error(`Historical fixture lacks fixture_kind "synthetic" in ${commit}:${path}`);
      }
      if (!fixture && containsListingLikeObject(document)) {
        throw new Error(`Listing-like JSON found outside a synthetic fixture in ${commit}:${path}`);
      }
    }
  }

  return { commits, roots };
}

async function prepareEmptyDestination(destinationRoot) {
  try {
    const stat = await lstat(destinationRoot);
    if (!stat.isDirectory()) throw new Error('target exists and is not a directory');
    const entries = await readdir(destinationRoot);
    if (entries.length > 0) throw new Error(`target directory is not empty (${entries.length} entries)`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot prepare public export target ${destinationRoot}: ${error.message}`, { cause: error });
    await mkdir(destinationRoot, { recursive: true });
  }
}

export async function exportPublicTree({ sourceRoot, destinationRoot, mapPath }) {
  const { files } = await loadExportMap(mapPath);
  await prepareEmptyDestination(destinationRoot);
  const physicalSourceRoot = await realpath(sourceRoot);

  for (const { source, destination } of files) {
    const sourcePath = resolve(sourceRoot, ...source.split('/'));
    const stat = await lstat(sourcePath).catch((error) => {
      throw new Error(`Allowlisted source does not exist: ${source}: ${error.message}`, { cause: error });
    });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Allowlisted source is not a regular file: ${source}`);
    const physicalSource = await realpath(sourcePath);
    const physicalRelative = relative(physicalSourceRoot, physicalSource);
    if (physicalRelative === '..' || physicalRelative.startsWith(`..${posix.sep}`)) {
      throw new Error(`Allowlisted source escapes the repository root: ${source}`);
    }

    const destinationPath = resolve(destinationRoot, ...destination.split('/'));
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }

  return verifyPublicTree({ treeRoot: destinationRoot, mapPath });
}

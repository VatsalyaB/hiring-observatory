import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const PARTITION = /^\d{4}-\d{2}-\d{2}\.json$/;
const EXCLUDED_SOURCES = new Set(['adzuna-query', '_manifests', '_canary']);

async function entries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

// This intentionally stops at the partition entry. Census captures live one directory deeper.
export async function listBroadCaptures(rawRoot) {
  const raw = join(rawRoot, 'raw');
  const captures = [];
  for (const source of await entries(raw)) {
    if (!source.isDirectory() || EXCLUDED_SOURCES.has(source.name)) continue;
    for (const country of await entries(join(raw, source.name))) {
      if (!country.isDirectory()) continue;
      for (const partition of await entries(join(raw, source.name, country.name))) {
        if (!partition.isFile() || !PARTITION.test(partition.name)) continue;
        captures.push({
          source: source.name,
          country: country.name,
          partition: partition.name.slice(0, -'.json'.length),
          path: join(raw, source.name, country.name, partition.name),
        });
      }
    }
  }
  return captures.sort((left, right) => left.path.localeCompare(right.path));
}

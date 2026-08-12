import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const QUERY_SET_KEYS = new Set(['id', 'country', 'effective_from', 'results_per_page', 'daily_page_budget', 'queries']);
const QUERY_KEYS = new Set(['id', 'text', 'role_family']);
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isSafeId = (value) => typeof value === 'string' && SAFE_ID.test(value);

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateQuerySet(value) {
  const problems = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['query set must be an object'] };
  }

  for (const key of Object.keys(value)) {
    if (!QUERY_SET_KEYS.has(key)) problems.push(`unknown query set key: ${key}`);
  }
  if (!isSafeId(value.id)) problems.push('id must be a lowercase kebab-case identifier');
  if (!isNonEmptyString(value.country) || !/^[a-z]{2}$/.test(value.country)) problems.push('country must be a lowercase ISO code');
  if (!isDate(value.effective_from)) problems.push('effective_from must be a valid YYYY-MM-DD date');
  if (!Number.isInteger(value.results_per_page) || value.results_per_page < 1 || value.results_per_page > 50) {
    problems.push('results_per_page must be an integer between 1 and 50');
  }
  if (!Number.isInteger(value.daily_page_budget) || value.daily_page_budget < 1 || value.daily_page_budget > 60) {
    problems.push('daily_page_budget must be an integer between 1 and 60');
  }
  if (!Array.isArray(value.queries) || value.queries.length === 0) {
    problems.push('queries must be a non-empty array');
  } else {
    const ids = new Set();
    const texts = new Set();
    value.queries.forEach((query, index) => {
      if (!query || typeof query !== 'object' || Array.isArray(query)) {
        problems.push(`queries[${index}] must be an object`);
        return;
      }
      for (const key of Object.keys(query)) {
        if (!QUERY_KEYS.has(key)) problems.push(`unknown query key at queries[${index}]: ${key}`);
      }
      if (!isSafeId(query.id)) problems.push(`queries[${index}].id must be a lowercase kebab-case identifier`);
      else if (ids.has(query.id)) problems.push(`duplicate query id: ${query.id}`);
      else ids.add(query.id);
      if (!isNonEmptyString(query.text)) problems.push(`queries[${index}].text must be a non-empty string`);
      else {
        const normalizedText = query.text.toLowerCase();
        if (texts.has(normalizedText)) problems.push(`duplicate query text: ${query.text}`);
        else texts.add(normalizedText);
      }
      if (!isNonEmptyString(query.role_family)) problems.push(`queries[${index}].role_family must be a non-empty string`);
    });
  }

  return { ok: problems.length === 0, problems };
}

export function validateQuerySetCollection(values) {
  const problems = [];
  if (!Array.isArray(values)) return { ok: false, problems: ['query sets must be an array'] };
  const ids = new Set();
  const effectiveDates = new Set();
  values.forEach((value, index) => {
    const result = validateQuerySet(value);
    for (const problem of result.problems) problems.push(`query set ${index}: ${problem}`);
    if (typeof value?.id === 'string') {
      if (ids.has(value.id)) problems.push(`duplicate query-set id: ${value.id}`);
      ids.add(value.id);
    }
    if (typeof value?.effective_from === 'string') {
      if (effectiveDates.has(value.effective_from)) problems.push(`duplicate effective_from: ${value.effective_from}`);
      effectiveDates.add(value.effective_from);
    }
  });
  return { ok: problems.length === 0, problems };
}

export async function loadQuerySet(path) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new Error('invalid query set: unable to read or parse JSON');
  }
  if (!stats.isFile()) throw new Error('invalid query set: path must be a regular file');

  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('invalid query set: unable to read or parse JSON');
  }
  const result = validateQuerySet(value);
  if (!result.ok) throw new Error(`invalid query set: ${result.problems.join('; ')}`);
  return value;
}

export async function loadQuerySets(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error('invalid query sets: unable to read config directory');
  }
  const names = entries.map((entry) => entry.name).filter((name) => name.endsWith('.json')).sort();
  const values = await Promise.all(names.map((name) => loadQuerySet(join(directory, name))));
  const result = validateQuerySetCollection(values);
  if (!result.ok) throw new Error(`invalid query sets: ${result.problems.join('; ')}`);
  return values;
}

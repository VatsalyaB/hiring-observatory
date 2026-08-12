import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

const SQL_DIR = 'sql';

// Replace ${VAR} with process.env.VAR so secrets never live in .sql files.
function substitute(sql, file) {
  return sql.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const value = process.env[name];
    if (!value) throw new Error(`${file}: environment variable ${name} is not set`);
    return value;
  });
}

const client = new Client({
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});
await client.connect();

await client.query(`
  create table if not exists schema_migrations (
    filename   text primary key,
    applied_at timestamptz not null default now()
  )
`);

const applied = new Set(
  (await client.query('select filename from schema_migrations')).rows.map((r) => r.filename)
);
const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip   ${file}`);
    continue;
  }
  const sql = substitute(await readFile(join(SQL_DIR, file), 'utf8'), file);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into schema_migrations (filename) values ($1)', [file]);
    await client.query('commit');
    console.log(`apply  ${file}`);
    count++;
  } catch (err) {
    await client.query('rollback');
    console.error(`FAILED ${file}: ${err.message}`);
    await client.end();
    process.exit(1);
  }
}

await client.end();
console.log(`\nmigrate: ${count} applied, ${files.length - count} already present`);

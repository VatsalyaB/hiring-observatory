import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { connectWithRetry, pgConfig } from './lib/verify.mjs';

const migrationPath = resolve('supabase/migrations/202609060001_reviewer_feedback.sql');
const repairMigrationPath = resolve('supabase/migrations/202609070001_public_grant.sql');
let migration;
try {
  migration = await readFile(migrationPath, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') {
    throw new Error(`required migration is missing: ${migrationPath}`);
  }
  throw error;
}
const repairMigration = await readFile(repairMigrationPath, 'utf8');

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const scratchDatabase = `reviewer_feedback_verify_${process.pid}_${Date.now()}`;
const adminConnection = await connectWithRetry(pgConfig());
assert.ok(adminConnection.ok, `postgres unreachable: ${adminConnection.detail}`);
const admin = adminConnection.client;
await admin.query(`create database ${quoteIdentifier(scratchDatabase)}`);
const scratchConfig = pgConfig({ database: scratchDatabase });
const ownerConnection = await connectWithRetry(scratchConfig);
assert.ok(ownerConnection.ok, `scratch postgres unreachable: ${ownerConnection.detail}`);
const owner = ownerConnection.client;
const raceClients = [];

async function asRole(role, userId, action) {
  await owner.query('savepoint reviewer_feedback_actor');
  try {
    await owner.query(`set local role ${quoteIdentifier(role)}`);
    await owner.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    const result = await action();
    await owner.query('reset role');
    await owner.query('release savepoint reviewer_feedback_actor');
    return result;
  } catch (error) {
    await owner.query('rollback to savepoint reviewer_feedback_actor');
    await owner.query('release savepoint reviewer_feedback_actor');
    throw error;
  }
}

const authorA = '11111111-1111-4111-8111-111111111111';
const authorB = '22222222-2222-4222-8222-222222222222';

async function visibleCount(role, userId) {
  return asRole(role, userId, async () => {
    const { rows } = await owner.query('select count(*)::int as count from public.reviewer_feedback');
    return rows[0].count;
  });
}

async function submit(authorId, {
  targetType = 'project',
  targetKey = 'hiring-observatory',
  category = 'useful',
  comment = 'initial feedback',
} = {}) {
  return asRole('authenticated', authorId, async () => {
    const { rows } = await owner.query(
      'select public.submit_reviewer_feedback($1, $2, $3, $4) as id',
      [targetType, targetKey, category, comment]
    );
    return rows[0].id;
  });
}

async function submitOn(client, authorId, comment) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [authorId]);
    const { rows } = await client.query(
      'select public.submit_reviewer_feedback($1, $2, $3, $4) as id',
      ['project', 'hiring-observatory', 'useful', comment],
    );
    await client.query('commit');
    return { ok: true, id: rows[0].id };
  } catch (error) {
    await client.query('rollback');
    return { ok: false, error };
  }
}

async function directInsert(authorId) {
  return asRole('authenticated', authorId, () => owner.query(
    `insert into public.reviewer_feedback
       (author_id, github_user_id, github_login, target_type, target_key, category, comment)
     values ($1, '101', 'author-a', 'project', 'hiring-observatory', 'useful', 'bypass')`,
    [authorId]
  ));
}

async function directUpdate(authorId, id) {
  return asRole('authenticated', authorId, () => owner.query(
    'update public.reviewer_feedback set comment = comment where id = $1',
    [id]
  ));
}

async function directDelete(authorId, id) {
  return asRole('authenticated', authorId, () => owner.query(
    'delete from public.reviewer_feedback where id = $1',
    [id]
  ));
}

try {
  await owner.query('begin');
  await owner.query('create extension if not exists pgcrypto');
  await owner.query('create schema if not exists auth');
  await owner.query(`
    create table if not exists auth.users (
      id uuid primary key,
      raw_app_meta_data jsonb not null default '{}'::jsonb,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    )
  `);
  await owner.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
    end;
    $$
  `);
  const { rows: currentUserRows } = await owner.query('select current_user as name');
  await owner.query(`grant anon, authenticated, service_role to ${quoteIdentifier(currentUserRows[0].name)}`);
  await owner.query('grant usage on schema auth to anon, authenticated, service_role');
  const browserColumns = [
    'category',
    'comment',
    'created_at',
    'github_login',
    'moderated_at',
    'status',
    'target_key',
    'target_type',
  ];

  const { rows: uidRows } = await owner.query(`select to_regprocedure('auth.uid()') is null as missing`);
  if (uidRows[0].missing) {
    await owner.query(`
      create function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$
    `);
  }
  await owner.query('grant execute on function auth.uid() to anon, authenticated, service_role');

  await owner.query(migration);
  await owner.query(`
    revoke select (
      github_login,
      target_type,
      target_key,
      category,
      comment,
      status,
      created_at,
      moderated_at
    ) on public.reviewer_feedback from anon, authenticated
  `);
  await owner.query(repairMigration);
  const { rows: browserGrantRows } = await owner.query(`
    select grantee, array_agg(column_name::text order by column_name)::text[] as columns
    from information_schema.column_privileges
    where table_schema = 'public'
      and table_name = 'reviewer_feedback'
      and privilege_type = 'SELECT'
      and grantee in ('anon', 'authenticated')
    group by grantee
    order by grantee
  `);
  assert.deepEqual(browserGrantRows, [
    { grantee: 'anon', columns: browserColumns },
    { grantee: 'authenticated', columns: browserColumns },
  ]);
  await owner.query(
    `insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
     values
       ($1, '{"provider":"github"}', '{"provider_id":"101","user_name":"author-a","identities":[{"provider":"github","id":"101"}]}'),
       ($2, '{"provider":"github"}', '{"sub":"202","user_name":"author-b","identities":[{"provider":"github","id":"202"}]}')`,
    [authorA, authorB]
  );
  const { rows: profiles } = await owner.query(
    'select github_user_id, github_login from public.reviewer_profiles where user_id = $1',
    [authorA]
  );
  assert.deepEqual(profiles, [{ github_user_id: '101', github_login: 'author-a' }]);

  const initialId = await submit(authorA);
  assert.equal(await visibleCount('anon', null), 0);
  assert.equal(await visibleCount('authenticated', authorA), 1);
  assert.equal(await visibleCount('authenticated', authorB), 0);
  await assert.rejects(() => directInsert(authorA), /permission denied/i);
  await assert.rejects(() => directUpdate(authorA, initialId), /permission denied/i);
  await assert.rejects(() => directDelete(authorA, initialId), /permission denied/i);
  for (const [role, userId] of [['anon', null], ['authenticated', authorA]]) {
    await assert.rejects(
      () => asRole(role, userId, () => owner.query('select id from public.reviewer_feedback limit 1')),
      /permission denied/i,
    );
  }
  await assert.rejects(() => submit(authorA, { category: 'other' }), /category/i);
  await assert.rejects(() => submit(authorA, { targetKey: 'missing' }), /target/i);
  await assert.rejects(() => submit(authorA, { comment: ' '.repeat(3) }), /comment/i);
  await assert.rejects(() => submit(authorA, { comment: 'x'.repeat(2001) }), /comment/i);
  for (let index = 0; index < 3; index += 1) {
    await submit(authorA, { comment: `accepted ${index}` });
  }

  await owner.query(
    `update public.reviewer_feedback
     set status = 'approved', moderated_at = now(), moderated_by_login = 'moderator'
     where id = $1`,
    [initialId],
  );
  const anonymousApproved = await asRole('anon', null, () => owner.query(`
    select category, comment, created_at, github_login, moderated_at, status, target_key, target_type
    from public.reviewer_feedback
    where comment = 'initial feedback'
  `));
  assert.equal(anonymousApproved.rowCount, 1);
  assert.deepEqual(Object.keys(anonymousApproved.rows[0]).sort(), browserColumns);
  assert.equal(Object.hasOwn(anonymousApproved.rows[0], 'id'), false);

  for (const column of ['author_id', 'github_user_id', 'moderated_by_login', 'moderator_note']) {
    await assert.rejects(
      () => asRole('authenticated', authorA, () =>
        owner.query(`select ${column} from public.reviewer_feedback limit 1`)
      ),
      /permission denied/i
    );
  }
  await assert.rejects(
    () => asRole('authenticated', authorA, () =>
      owner.query('select user_id from public.reviewer_profiles limit 1')
    ),
    /permission denied/i
  );
  for (const statement of [
    `insert into public.feedback_targets (target_type, target_key, label)
       values ('project', 'bypass', 'bypass')`,
    'update public.feedback_targets set label = label',
    'delete from public.feedback_targets',
  ]) {
    await assert.rejects(
      () => asRole('authenticated', authorA, () => owner.query(statement)),
      /permission denied/i
    );
  }
  await assert.rejects(
    () => asRole('anon', null, () => owner.query(
      'select public.submit_reviewer_feedback($1, $2, $3, $4)',
      ['project', 'hiring-observatory', 'useful', 'anonymous rpc']
    )),
    /permission denied/i
  );
  const visibleSnapshot = await asRole('authenticated', authorA, () => owner.query(
    `select github_login from public.reviewer_feedback where comment = 'initial feedback'`,
  ));
  assert.equal(visibleSnapshot.rows[0].github_login, 'author-a');

  await owner.query(`
    update public.reviewer_feedback
    set created_at = case comment
      when 'initial feedback' then now() - interval '55 minutes'
      when 'accepted 0' then now() - interval '45 minutes'
      when 'accepted 1' then now() - interval '35 minutes'
      when 'accepted 2' then now() - interval '25 minutes'
    end
    where author_id = $1
  `, [authorA]);
  await owner.query('commit');

  for (let index = 0; index < 2; index += 1) {
    const connection = await connectWithRetry(scratchConfig);
    assert.ok(connection.ok, `concurrent postgres unreachable: ${connection.detail}`);
    raceClients.push(connection.client);
  }
  const beforeRace = Date.now();
  const attempts = await Promise.all([
    submitOn(raceClients[0], authorA, 'concurrent submission A'),
    submitOn(raceClients[1], authorA, 'concurrent submission B'),
  ]);
  const accepted = attempts.filter((attempt) => attempt.ok);
  const rejected = attempts.filter((attempt) => !attempt.ok);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].error.message, 'rate limit exceeded');
  assert.match(rejected[0].error.detail, /^retry_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const retryAt = Date.parse(rejected[0].error.detail.slice('retry_at='.length));
  assert.ok(retryAt - beforeRace > 4 * 60_000 && retryAt - beforeRace < 6 * 60_000);

  console.log('verify-reviewer-feedback-schema: OK');
} finally {
  await Promise.all(raceClients.map((client) => client.end().catch(() => {})));
  await owner.query('rollback').catch(() => {});
  await owner.end().catch(() => {});
  await admin.query(`drop database if exists ${quoteIdentifier(scratchDatabase)} with (force)`).catch(() => {});
  await admin.end().catch(() => {});
}

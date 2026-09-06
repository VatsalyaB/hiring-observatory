import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseDecision, parseModeratorLogins, isModerator } from '../supabase/functions/moderate-feedback/policy.mjs';

const UUID = '8df6cebb-6810-4e00-9373-a7a1e8552894';

assert.deepEqual(
  [...parseModeratorLogins(' Maintainer-One,maintainer-two,maintainer-one ')],
  ['maintainer-one', 'maintainer-two'],
);
assert.equal(isModerator('MAINTAINER-ONE', new Set(['maintainer-one'])), true);
assert.throws(() => parseModeratorLogins('not valid!'), /login/i);

assert.deepEqual(parseDecision({ id: UUID, decision: 'approved', note: 'checked' }), {
  id: UUID,
  decision: 'approved',
  note: 'checked',
});
assert.deepEqual(parseDecision({ id: UUID, decision: 'rejected', note: '  ' }), {
  id: UUID,
  decision: 'rejected',
  note: null,
});
assert.throws(() => parseDecision({ id: UUID, decision: 'pending' }), /decision/i);
assert.throws(() => parseDecision({ id: 'not-a-uuid', decision: 'rejected' }), /id/i);
assert.throws(() => parseDecision({ id: UUID, decision: 'rejected', note: 'x'.repeat(2001) }), /note/i);

const source = await readFile(new URL('../supabase/functions/moderate-feedback/index.ts', import.meta.url), 'utf8');


assert.deepEqual(
  {
    preflightHeaders: source.includes(
      "'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'",
    ),
    exceptionContainment: /Deno\.serve\(async \(request\) => \{\s*try \{\s*return await handleRequest\(request\);\s*\} catch \{\s*return response\(request, \{ error: 'unable to moderate feedback' \}, 500\);\s*\}\s*\}\);/.test(source),
  },
  { preflightHeaders: true, exceptionContainment: true },
  'preflight headers and unexpected-exception containment must both be present',
);
assert.match(source, /auth\.getUser\(jwt\)/, 'JWT verification must use auth.getUser(jwt)');
assert.match(source, /identity\.provider\s*===\s*['"]github['"]/, 'moderator login must come from a GitHub identity');
assert.match(source, /identity\.identity_data\?\.user_name/, 'moderator login must not use editable user metadata');
assert.match(source, /MODERATOR_GITHUB_LOGINS/, 'moderator allowlist must come from the Edge Function environment');
assert.match(source, /https:\/\/vatsalyab\.github\.io/, 'production origin must be explicitly allowed');
assert.match(source, /http:\/\/localhost:8000/, 'localhost origin must be explicitly allowed');
assert.match(source, /http:\/\/127\.0\.0\.1:8000/, 'loopback origin must be explicitly allowed');
assert.match(source, /\.eq\(['"]status['"],\s*['"]pending['"]\)/, 'decision updates must remain conditional on pending status');
assert.match(source, /,\s*409\)/, 'a stale decision must return 409');
assert.doesNotMatch(source, /console\.(?:log|error)\(/, 'the function must not log private feedback or errors');

const authorization = source.indexOf('auth.getUser(jwt)');
const serviceRole = source.indexOf('SUPABASE_SERVICE_ROLE_KEY');
assert.ok(authorization >= 0 && serviceRole > authorization, 'service role access must occur after JWT verification');

const publicManifestUrl = new URL('../public/package.json', import.meta.url);
const hasSeparatePublicManifest = existsSync(publicManifestUrl);
const manifestPaths = hasSeparatePublicManifest ? ['package.json', 'public/package.json'] : ['package.json'];
for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(await readFile(new URL(`../${manifestPath}`, import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['verify:reviewer-feedback-function'], 'node scripts/verify-reviewer-feedback-function.mjs');
}

const rootManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const publicManifest = JSON.parse(await readFile(hasSeparatePublicManifest ? publicManifestUrl : new URL('../package.json', import.meta.url), 'utf8'));
if (hasSeparatePublicManifest) assert.match(rootManifest.scripts.verify, /verify-reviewer-feedback-function\.mjs/);
assert.match(publicManifest.scripts['verify:public'], /verify-reviewer-feedback-function\.mjs/);

console.log('reviewer feedback function verification passed');

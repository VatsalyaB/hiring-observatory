import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const evidenceRoot = existsSync(resolve('public/docs/evidence')) ? 'public/docs/evidence' : 'docs/evidence';
const {
  buildFeedbackTargets,
  createFeedbackApi,
  createTokenFilteringStorage,
  renderPlainText,
} = await import(pathToFileURL(resolve(evidenceRoot, 'feedback-core.mjs')).href);
const { bootFeedback } = await import(pathToFileURL(resolve(evidenceRoot, 'feedback.mjs')).href);

const release = JSON.parse(await readFile(resolve(evidenceRoot, 'data/pilot.json'), 'utf8'));
const migration = await readFile(resolve('supabase/migrations/202609060001_reviewer_feedback.sql'), 'utf8');
const submissionSignature = migration.match(
  /create function public\.submit_reviewer_feedback\(\s*([\s\S]*?)\)\s*returns uuid/i,
);
assert.ok(submissionSignature, 'submission RPC signature must exist in the exported migration');
const submissionParameterNames = [...submissionSignature[1].matchAll(/\b(p_[a-z_]+)\s+text\b/gi)]
  .map((match) => match[1]);
assert.deepEqual(submissionParameterNames, [
  'p_target_type', 'p_target_key', 'p_category', 'p_comment',
]);
const PROJECT_TARGET = ['hiring', 'observatory'].join('-');
const targetRelease = { release_id: release.release_id, insights: [release.insights[0]] };

assert.deepEqual(buildFeedbackTargets(targetRelease), [
  { type: 'project', key: 'hiring-observatory', label: 'Hiring Observatory project' },
  { type: 'release', key: release.release_id, label: release.release_id },
  { type: 'claim', key: `${release.release_id}:observable-demand`, label: '469 observable vacancies across complete pilot captures.' },
]);

const sink = {
  value: null,
  setItem(_key, value) { this.value = JSON.parse(value); },
  getItem(key) { return key === 'session' ? JSON.stringify(this.value) : null; },
  removeItem() {},
  clear() {},
  key() { return null; },
  get length() { return 0; },
};
const storage = createTokenFilteringStorage(sink);
storage.setItem('session', JSON.stringify({
  access_token: 'supabase-access',
  refresh_token: 'supabase-refresh',
  provider_token: 'github-access',
  provider_refresh_token: 'github-refresh',
  nested: { provider_token: 'nested-github-access', kept: true },
}));
assert.equal(sink.value.provider_token, undefined);
assert.equal(sink.value.provider_refresh_token, undefined);
assert.equal(sink.value.nested.provider_token, undefined);
assert.equal(sink.value.access_token, 'supabase-access');
assert.equal(sink.value.refresh_token, 'supabase-refresh');

const regressions = [];
const failedWrites = [];
const failingSink = {
  setItem(_key, value) {
    failedWrites.push(JSON.parse(value));
    throw new Error('storage unavailable');
  },
  getItem() { return null; },
  removeItem() {},
  clear() {},
  key() { return null; },
  get length() { return 0; },
};
try {
  assert.throws(() => createTokenFilteringStorage(failingSink).setItem('session', JSON.stringify({
    access_token: 'supabase-access',
    provider_token: 'github-access',
    provider_refresh_token: 'github-refresh',
  })), /storage unavailable/);
  assert.equal(failedWrites.length, 1);
} catch (error) {
  regressions.push(error);
}
try {
  assert.equal(failedWrites.some((value) => 'provider_token' in value || 'provider_refresh_token' in value), false);
} catch (error) {
  regressions.push(error);
}

const node = { textContent: '', set innerHTML(_) { throw new Error('unsafe'); } };
renderPlainText(node, '<img src=x onerror=alert(1)>');
assert.equal(node.textContent, '<img src=x onerror=alert(1)>');

const calls = [];
const client = {
  from(table) {
    calls.push(['from', table]);
    return { select(columns) { calls.push(['select', columns]); return Promise.resolve({ data: [{ github_login: 'reviewer' }], error: null }); } };
  },
  rpc(name, args) { calls.push(['rpc', name, args]); return Promise.resolve({ data: 'submission-id', error: null }); },
  functions: {
    invoke(name, options) { calls.push(['invoke', name, options]); return Promise.resolve({ data: [{ id: 'pending-row' }], error: null }); },
  },
};
const api = createFeedbackApi(client);
assert.deepEqual(await api.list(), [{ github_login: 'reviewer' }]);
assert.equal(await api.submit({
  targetType: 'project', targetKey: 'hiring-observatory', category: 'useful', comment: '  Useful evidence.  ',
}), 'submission-id');
const rpcCall = calls.find(([type]) => type === 'rpc');
assert.equal(rpcCall[1], 'submit_reviewer_feedback');
assert.deepEqual(Object.keys(rpcCall[2]), submissionParameterNames);
assert.deepEqual(await api.listPending(), [{ id: 'pending-row' }]);
await api.decide({ id: '8df6cebb-6810-4e00-9373-a7a1e8552894', decision: 'approved', note: '  checked  ' });
const legacyCalls = [
  ['from', 'reviewer_feedback'],
  ['select', 'id, github_login, target_type, target_key, category, comment, status, created_at, moderated_at'],
  ['rpc', 'submit_reviewer_feedback', {
    target_type: 'project', target_key: 'hiring-observatory', category: 'useful', comment: 'Useful evidence.',
  }],
  ['invoke', 'moderate-feedback', { method: 'GET' }],
  ['invoke', 'moderate-feedback', {
    method: 'POST', body: { id: '8df6cebb-6810-4e00-9373-a7a1e8552894', decision: 'approved', note: 'checked' },
  }],
];
assert.notDeepEqual(calls, legacyCalls);
assert.deepEqual(calls, [
  ['from', 'reviewer_feedback'],
  ['select', 'github_login, target_type, target_key, category, comment, status, created_at, moderated_at'],
  ['rpc', 'submit_reviewer_feedback', {
    p_target_type: 'project', p_target_key: PROJECT_TARGET, p_category: 'useful', p_comment: 'Useful evidence.',
  }],
  ['invoke', 'moderate-feedback', { method: 'GET' }],
  ['invoke', 'moderate-feedback', {
    method: 'POST', body: { id: '8df6cebb-6810-4e00-9373-a7a1e8552894', decision: 'approved', note: 'checked' },
  }],
]);
await assert.rejects(
  () => api.submit({ targetType: 'project', targetKey: 'hiring-observatory', category: 'other', comment: 'Nope' }),
  /category/i,
);
await assert.rejects(
  () => api.submit({ targetType: 'project', targetKey: 'hiring-observatory', category: 'useful', comment: ' ' }),
  /comment/i,
);

const disabledConfig = Object.freeze({ enabled: false });
const status = { textContent: '' };
let requests = 0;
await bootFeedback({
  document: { querySelector(selector) { return selector === '#feedback-status' ? status : null; } },
  location: { href: 'https://vatsalyab.github.io/hiring-observatory/docs/evidence/' },
  fetch: async () => { requests += 1; throw new Error('must not fetch while disabled'); },
  config: disabledConfig,
});
assert.equal(requests, 0);
assert.equal(status.textContent, 'Reviewer feedback is not connected yet.');

for (const manifestPath of existsSync('public/package.json') ? ['package.json', 'public/package.json'] : ['package.json']) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.dependencies['@supabase/supabase-js'], '2.115.0');
  assert.equal(manifest.devDependencies.esbuild, '0.28.2');
  assert.equal(manifest.scripts['build:feedback'], 'node scripts/build-feedback.mjs');
  assert.equal(manifest.scripts['verify:reviewer-feedback-client'], 'node scripts/verify-reviewer-feedback-client.mjs');
}

const bundle = await import(pathToFileURL(resolve(evidenceRoot, 'feedback.bundle.js')).href);
assert.equal(typeof bundle.bootFeedback, 'function');

if (!process.env.FEEDBACK_VERIFY_EXPORT_FIXTURE && existsSync('public/package.json')) {
  const exportedRoot = await mkdtemp(join(tmpdir(), 'feedback-export-'));
  try {
    await cp('public/package.json', join(exportedRoot, 'package.json'));
    await cp('public/docs/evidence', join(exportedRoot, 'docs/evidence'), { recursive: true });
    await mkdir(join(exportedRoot, 'scripts'));
    await cp('scripts/build-feedback.mjs', join(exportedRoot, 'scripts/build-feedback.mjs'));
    await cp('scripts/verify-reviewer-feedback-client.mjs', join(exportedRoot, 'scripts/verify-reviewer-feedback-client.mjs'));
    await mkdir(join(exportedRoot, 'supabase/migrations'), { recursive: true });
    await cp('supabase/migrations/202609060001_reviewer_feedback.sql', join(exportedRoot, 'supabase/migrations/202609060001_reviewer_feedback.sql'));
    await symlink(resolve('node_modules'), join(exportedRoot, 'node_modules'));
    const exportedBuild = spawnSync('npm', ['run', 'build:feedback'], { cwd: exportedRoot, encoding: 'utf8' });
    assert.equal(exportedBuild.status, 0, exportedBuild.stderr);
    const exportedVerify = spawnSync('npm', ['run', 'verify:reviewer-feedback-client'], {
      cwd: exportedRoot,
      encoding: 'utf8',
      env: { ...process.env, FEEDBACK_VERIFY_EXPORT_FIXTURE: '1' },
    });
    assert.equal(exportedVerify.status, 0, exportedVerify.stderr);
    assert.match(await readFile(join(exportedRoot, 'docs/evidence/feedback.bundle.js'), 'utf8'), /supabase/i);
  } catch (error) {
    regressions.push(error);
  } finally {
    await rm(exportedRoot, { recursive: true, force: true });
  }
}

if (regressions.length) throw new AggregateError(regressions, 'reviewer feedback client regressions');

console.log('reviewer feedback client verification passed');

class FakeElement {
  constructor(document, id = '') {
    this.document = document; this.id = id; this.children = []; this.hidden = false;
    this.disabled = false; this.textContent = ''; this.value = ''; this.listeners = new Map();
  }
  set innerHTML(_value) { throw new Error('feedback UI must not use innerHTML'); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  async emit(type) {
    let prevented = false;
    for (const listener of this.listeners.get(type) ?? []) await listener({ preventDefault() { prevented = true; } });
    return prevented;
  }
  focus() { this.document.activeElement = this; }
  setAttribute(name, value) { (this.attributes ??= new Map()).set(name, String(value)); }
  getAttribute(name) { return this.attributes?.get(name) ?? null; }
  remove() { this.parent?.replaceChildren(...this.parent.children.filter((child) => child !== this)); }
}
function feedbackDom() {
  const nodes = new Map();
  const document = {
    activeElement: null,
    querySelector(selector) { return nodes.get(selector.slice(1)) ?? null; },
    getElementById(id) { return nodes.get(id) ?? null; },
    createElement() { return new FakeElement(document); },
  };
  for (const id of [
    'feedback-form', 'feedback-sign-in', 'feedback-sign-out', 'feedback-anonymous',
    'feedback-target', 'feedback-category', 'feedback-comment', 'feedback-characters',
    'feedback-submit', 'feedback-status', 'feedback-retry', 'public-feedback-list',
    'your-feedback-list', 'moderation-queue', 'moderation-feedback-list',
  ]) nodes.set(id, new FakeElement(document, id));
  nodes.get('moderation-queue').hidden = true;
  return { document, nodes };
}
const ui = feedbackDom();
let signedIn = true;
let failSubmit = false;
const uiCalls = [];
const uiClient = {
  auth: {
    async getSession() { return { data: { session: signedIn ? { user: { user_metadata: { user_name: 'reviewer' } } } : null }, error: null }; },
    async signInWithOAuth(options) { uiCalls.push(['sign-in', options]); return { error: null }; },
    async signOut() { signedIn = false; return { error: null }; },
  },
  from() { return { select() { return Promise.resolve({ data: [{ id: 'public', github_login: 'reviewer', target_type: 'project', target_key: 'hiring-observatory', category: 'useful', comment: '<img src=x>', status: 'approved', created_at: '2026-09-06T00:00:00Z' }], error: null }); } }; },
  rpc(name, input) { uiCalls.push(['submit', name, input]); return Promise.resolve(failSubmit ? { data: null, error: new Error('offline') } : { data: 'feedback-id', error: null }); },
  functions: { invoke(_name, options) { uiCalls.push(['moderate', options]); return Promise.resolve({ data: null, error: new Error('forbidden') }); } },
};
const uiLocation = { href: 'https://example.test/docs/evidence/', hash: '' };
const enabledConfig = { enabled: true, supabaseUrl: 'https://example.test', supabasePublishableKey: 'key' };
await bootFeedback({ document: ui.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: uiClient });
assert.equal(ui.nodes.get('feedback-form').hidden, false);
assert.equal(ui.nodes.get('feedback-anonymous').hidden, true);
assert.equal(ui.nodes.get('moderation-queue').hidden, true);
assert.equal(ui.nodes.get('public-feedback-list').children[0].textContent.includes('<img src=x>'), true);
ui.nodes.get('feedback-target').value = 'project:hiring-observatory';
ui.nodes.get('feedback-category').value = 'useful';
ui.nodes.get('feedback-comment').value = 'Hello';
await ui.nodes.get('feedback-comment').emit('input');
assert.equal(ui.nodes.get('feedback-characters').textContent, '1,995 characters remaining');
assert.equal(await ui.nodes.get('feedback-form').emit('submit'), true);
const legacyUiPayload = {
  target_type: 'project', target_key: 'hiring-observatory', category: 'useful', comment: 'Hello',
};
assert.notDeepEqual(Object.keys(legacyUiPayload), submissionParameterNames);
assert.deepEqual(uiCalls.find(([type]) => type === 'submit'), ['submit', 'submit_reviewer_feedback', {
  p_target_type: 'project', p_target_key: PROJECT_TARGET, p_category: 'useful', p_comment: 'Hello',
}]);
assert.equal(ui.nodes.get('your-feedback-list').children[0].textContent.includes('Hello'), true);
failSubmit = true;
ui.nodes.get('feedback-comment').value = 'Keep this feedback';
await ui.nodes.get('feedback-form').emit('submit');
assert.equal(ui.nodes.get('feedback-comment').value, 'Keep this feedback');
assert.equal(ui.nodes.get('feedback-retry').hidden, false);

signedIn = false;
const returnUi = feedbackDom();
await bootFeedback({ document: returnUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: uiClient });
returnUi.nodes.get('feedback-sign-in').focus();
await returnUi.nodes.get('feedback-sign-in').emit('click');
assert.equal(uiCalls.find(([type]) => type === 'sign-in')[1].options.redirectTo.endsWith('#feedback-comment'), true);
signedIn = true;
uiLocation.hash = '#feedback-comment';
await bootFeedback({ document: returnUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: uiClient });
assert.equal(returnUi.document.activeElement, returnUi.nodes.get('feedback-comment'));

const statusError = { context: { status: 403 } };
const blockedApi = createFeedbackApi({ functions: { invoke: async () => ({ data: null, error: statusError }) } });
await assert.rejects(() => blockedApi.listPending(), (error) => error.status === 403);
const unavailableApi = createFeedbackApi({ functions: { invoke: async () => ({ data: null, error: new Error('offline') }) } });
await assert.rejects(() => unavailableApi.listPending(), (error) => error.status === undefined);
const retryAt = '2026-09-06T01:02:03.456Z';
const limitedApi = createFeedbackApi({
  rpc: async () => ({
    data: null,
    error: { message: 'rate limit exceeded', details: `retry_at=${retryAt}` },
  }),
});
await assert.rejects(
  () => limitedApi.submit({ targetType: 'project', targetKey: PROJECT_TARGET, category: 'useful', comment: 'One too many' }),
  (error) => error.retryAt === retryAt && error.message === `Rate limit reached. Try again after ${retryAt}.`,
);
const limitedUi = feedbackDom();
const limitedClient = {
  auth: {
    async getSession() { return { data: { session: { user: { user_metadata: { user_name: 'reviewer' } } } }, error: null }; },
    async signOut() { return { error: null }; },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
  },
  from() { return { select() { return Promise.resolve({ data: [], error: null }); } }; },
  rpc() { return Promise.resolve({ data: null, error: { message: 'rate limit exceeded', details: `retry_at=${retryAt}` } }); },
  functions: { invoke() { return Promise.resolve({ data: null, error: { context: { status: 403 } } }); } },
};
await bootFeedback({ document: limitedUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: limitedClient });
limitedUi.nodes.get('feedback-target').value = 'project:hiring-observatory';
limitedUi.nodes.get('feedback-category').value = 'useful';
limitedUi.nodes.get('feedback-comment').value = 'One too many';
await limitedUi.nodes.get('feedback-form').emit('submit');
assert.equal(limitedUi.nodes.get('feedback-status').textContent, `Rate limit reached. Try again after ${retryAt}.`);

const moderationUi = feedbackDom();
let authStateChange;
let decideResult;
const decisionWaiter = new Promise((resolve) => { decideResult = resolve; });
const moderationClient = {
  auth: {
    async getSession() { return { data: { session: { user: { user_metadata: { user_name: 'maintainer' } } } }, error: null }; },
    async signOut() { return { error: null }; },
    onAuthStateChange(listener) { authStateChange = listener; return { data: { subscription: { unsubscribe() {} } } }; },
  },
  from() { return { select() { return Promise.resolve({ data: [{ id: 'public', github_login: 'reviewer', target_type: 'project', target_key: 'hiring-observatory', category: 'useful', comment: 'Public review', status: 'approved', created_at: '2026-09-06T00:00:00Z' }], error: null }); } }; },
  rpc() { return Promise.resolve({ data: 'submission-id', error: null }); },
  functions: {
    invoke(_name, options) {
      if (options.method === 'GET') return Promise.resolve({ data: { feedback: [{ id: '8df6cebb-6810-4e00-9373-a7a1e8552894', github_login: 'reviewer', target_type: 'claim', target_key: 'release:claim', category: 'evidence_concern', comment: 'Check the denominator', created_at: '2026-09-06T01:02:03Z' }] }, error: null });
      return decisionWaiter;
    },
  },
};
await bootFeedback({ document: moderationUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: moderationClient });
await Promise.resolve();
const moderationEntry = moderationUi.nodes.get('moderation-feedback-list').children[0];
assert.match(moderationEntry.textContent, /claim.*release:claim.*2026-09-06.*reviewer.*evidence_concern.*Check the denominator/i);
assert.doesNotMatch(moderationEntry.textContent, /undefined/);
const [moderatorNote, approve, reject] = moderationEntry.children;
const deciding = approve.emit('click');
await Promise.resolve();
assert.equal(moderatorNote.disabled, true);
assert.equal(approve.disabled, true);
assert.equal(reject.disabled, true);
assert.equal(moderationEntry.getAttribute('aria-busy'), 'true');
decideResult({ data: { feedback: { id: '8df6cebb-6810-4e00-9373-a7a1e8552894', status: 'approved' } }, error: null });
await deciding;
assert.equal(moderationUi.document.activeElement, moderationUi.nodes.get('moderation-queue'));

moderationUi.nodes.get('your-feedback-list').append(new FakeElement(moderationUi.document));
moderationUi.nodes.get('moderation-feedback-list').append(new FakeElement(moderationUi.document));
moderationUi.nodes.get('moderation-queue').hidden = false;
await moderationUi.nodes.get('feedback-sign-out').emit('click');
assert.equal(moderationUi.nodes.get('your-feedback-list').children.length, 0);
assert.equal(moderationUi.nodes.get('moderation-feedback-list').children.length, 0);
assert.equal(moderationUi.nodes.get('moderation-queue').hidden, true);
assert.equal(moderationUi.nodes.get('feedback-form').hidden, true);
assert.equal(moderationUi.nodes.get('feedback-anonymous').hidden, false);
await authStateChange('SIGNED_OUT');
assert.equal(moderationUi.nodes.get('your-feedback-list').children.length, 0);

const retryUi = feedbackDom();
const retryClient = {
  auth: { async getSession() { return { data: { session: { user: { user_metadata: { user_name: 'reviewer' } } } }, error: null }; }, async signOut() { return { error: null }; }, onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; } },
  from() { return { select() { return Promise.resolve({ data: [], error: null }); } }; },
  rpc(_name, input) { uiCalls.push(['retry-submit', input]); return Promise.resolve({ data: 'retry-id', error: null }); },
  functions: { invoke(_name, options) { return options.method === 'GET' ? Promise.resolve({ data: null, error: { context: { status: 503 } } }) : Promise.resolve({ data: null, error: null }); } },
};
await bootFeedback({ document: retryUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: retryClient });
await Promise.resolve();
assert.equal(retryUi.nodes.get('feedback-retry').hidden, false);
assert.match(retryUi.nodes.get('feedback-status').textContent, /unavailable/i);
await retryUi.nodes.get('feedback-retry').emit('click');
retryUi.nodes.get('feedback-target').value = 'project:hiring-observatory';
retryUi.nodes.get('feedback-category').value = 'useful';
retryUi.nodes.get('feedback-comment').value = 'One request';
const beforeRetrySubmit = uiCalls.filter(([type]) => type === 'retry-submit').length;
await retryUi.nodes.get('feedback-form').emit('submit');
assert.equal(uiCalls.filter(([type]) => type === 'retry-submit').length - beforeRetrySubmit, 1);

assert.match(ui.nodes.get('public-feedback-list').children[0].textContent, /Target: project\/hiring-observatory.*Submitted: 2026-09-06.*Reviewer: @reviewer.*Category: useful.*Status: approved.*<img src=x>/);

const failedModerationUi = feedbackDom();
const failedModerationClient = {
  auth: {
    async getSession() { return { data: { session: { user: { user_metadata: { user_name: 'maintainer' } } } }, error: null }; },
    async signOut() { return { error: null }; },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
  },
  from() { return { select() { return Promise.resolve({ data: [], error: null }); } }; },
  rpc() { return Promise.resolve({ data: 'submission-id', error: null }); },
  functions: {
    invoke(_name, options) {
      if (options.method === 'GET') return Promise.resolve({ data: { feedback: [{ id: '8df6cebb-6810-4e00-9373-a7a1e8552894', github_login: 'reviewer', target_type: 'project', target_key: 'hiring-observatory', category: 'useful', comment: 'Will fail', status: 'pending', created_at: '2026-09-06T00:00:00Z' }] }, error: null });
      return Promise.resolve({ data: null, error: new Error('offline') });
    },
  },
};
await bootFeedback({ document: failedModerationUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: failedModerationClient });
await Promise.resolve();
const failedEntry = failedModerationUi.nodes.get('moderation-feedback-list').children[0];
const [, failedApprove, failedReject] = failedEntry.children;
failedReject.focus();
await failedReject.emit('click');
assert.equal(failedApprove.disabled, false);
assert.equal(failedReject.disabled, false);
assert.equal(failedEntry.getAttribute('aria-busy'), 'false');
assert.equal(failedModerationUi.document.activeElement, failedReject);

const raceUi = feedbackDom();
let resolvePending;
const pendingList = new Promise((resolve) => { resolvePending = resolve; });
const raceClient = {
  auth: {
    async getSession() { return { data: { session: { user: { user_metadata: { user_name: 'maintainer' } } } }, error: null }; },
    async signOut() { return { error: null }; },
    onAuthStateChange(listener) { this.listener = listener; return { data: { subscription: { unsubscribe() {} } } }; },
  },
  from() { return { select() { return Promise.resolve({ data: [], error: null }); } }; },
  rpc() { return Promise.resolve({ data: 'id', error: null }); },
  functions: { invoke(_name, options) { return options.method === 'GET' ? pendingList : Promise.resolve({ data: null, error: null }); } },
};
await bootFeedback({ document: raceUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: raceClient });
raceClient.auth.listener('SIGNED_OUT', null);
assert.equal(raceUi.nodes.get('feedback-form').hidden, true);
assert.equal(raceUi.nodes.get('feedback-sign-out').hidden, true);
assert.equal(raceUi.nodes.get('moderation-queue').hidden, true);
assert.equal(raceUi.nodes.get('moderation-feedback-list').children.length, 0);
resolvePending({ data: { feedback: [{ id: '8df6cebb-6810-4e00-9373-a7a1e8552894', github_login: 'reviewer', target_type: 'project', target_key: 'hiring-observatory', category: 'useful', comment: 'stale private feedback', status: 'pending', created_at: '2026-09-06T00:00:00Z' }] }, error: null });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(raceUi.nodes.get('moderation-queue').hidden, true);
assert.equal(raceUi.nodes.get('moderation-feedback-list').children.length, 0);

// Fix round 3 deferred-failure coverage.
const failureRaceUi = feedbackDom();
let rejectStart;
const startGate = new Promise((_, reject) => { rejectStart = reject; });
const failureRaceClient = { auth:{ async getSession(){return {data:{session:{user:{}}},error:null};}, async signOut(){return {error:null};}, onAuthStateChange(listener){this.listener=listener;return {data:{subscription:{unsubscribe(){}}}};} }, from(){return {select(){return startGate;}};}, rpc(){return Promise.resolve({data:'id',error:null});}, functions:{invoke(){return Promise.resolve({data:null,error:{context:{status:403}}});}} };
const failureBoot=bootFeedback({document:failureRaceUi.document,location:uiLocation,fetch:async()=>({ok:true,json:async()=>targetRelease}),config:enabledConfig,client:failureRaceClient});
await Promise.resolve();
await failureRaceUi.nodes.get('feedback-sign-out').emit('click');
rejectStart(new Error('late start failure'));
await failureBoot;
await new Promise((resolve)=>setTimeout(resolve,0));
assert.equal(failureRaceUi.nodes.get('feedback-retry').hidden,true);

const decisionRaceUi=feedbackDom(); let rejectDecision;
const decisionGate=new Promise((_,reject)=>{rejectDecision=reject;});
const decisionRaceClient={auth:{async getSession(){return {data:{session:{user:{}}},error:null};},async signOut(){return {error:null};},onAuthStateChange(listener){this.listener=listener;return {data:{subscription:{unsubscribe(){}}}};}},from(){return {select(){return Promise.resolve({data:[],error:null});}};},rpc(){return Promise.resolve({data:'id',error:null});},functions:{invoke(_name,options){return options.method==='GET'?Promise.resolve({data:{feedback:[{id:'8df6cebb-6810-4e00-9373-a7a1e8552894',github_login:'r',target_type:'project',target_key:'k',category:'useful',comment:'c',status:'pending',created_at:'2026-09-06T00:00:00Z'}]},error:null}):decisionGate;}}};
await bootFeedback({document:decisionRaceUi.document,location:uiLocation,fetch:async()=>({ok:true,json:async()=>targetRelease}),config:enabledConfig,client:decisionRaceClient});
await new Promise((resolve)=>setTimeout(resolve,0));
const [,decisionApprove]=decisionRaceUi.nodes.get('moderation-feedback-list').children[0].children;
const decisionClick=decisionApprove.emit('click'); await Promise.resolve();
await decisionRaceUi.nodes.get('feedback-sign-out').emit('click'); rejectDecision(new Error('late decision failure')); await decisionClick;
assert.equal(decisionRaceUi.nodes.get('moderation-queue').hidden,true);
assert.notEqual(decisionRaceUi.document.activeElement,decisionApprove);

const pendingFailureUi = feedbackDom();
let rejectPending;
const pendingFailure = new Promise((_, reject) => { rejectPending = reject; });
const pendingFailureClient = {
  auth: {
    async getSession() { return { data: { session: { user: {} } }, error: null }; },
    async signOut() { return { error: null }; },
    onAuthStateChange(listener) { this.listener = listener; return { data: { subscription: { unsubscribe() {} } } }; },
  },
  from() { return { select() { return Promise.resolve({ data: [], error: null }); } }; },
  rpc() { return Promise.resolve({ data: 'id', error: null }); },
  functions: { invoke(_name, options) { return options.method === 'GET' ? pendingFailure : Promise.resolve({ data: null, error: null }); } },
};
await bootFeedback({ document: pendingFailureUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: pendingFailureClient });
pendingFailureClient.auth.listener('SIGNED_OUT', null);
const pendingFailureStatus = pendingFailureUi.nodes.get('feedback-status').textContent;
rejectPending(new Error('late pending failure'));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(pendingFailureUi.nodes.get('feedback-retry').hidden, true);
assert.equal(pendingFailureUi.nodes.get('feedback-status').textContent, pendingFailureStatus);
assert.equal(pendingFailureUi.nodes.get('moderation-queue').hidden, true);
assert.equal(pendingFailureUi.nodes.get('moderation-feedback-list').children.length, 0);

const successfulDecisionRaceUi = feedbackDom();
let resolveDecision;
const successfulDecisionGate = new Promise((resolve) => { resolveDecision = resolve; });
const successfulDecisionRaceClient = {
  auth: {
    async getSession() { return { data: { session: { user: {} } }, error: null }; },
    async signOut() { return { error: null }; },
    onAuthStateChange(listener) { this.listener = listener; return { data: { subscription: { unsubscribe() {} } } }; },
  },
  from() { return { select() { return Promise.resolve({ data: [], error: null }); } }; },
  rpc() { return Promise.resolve({ data: 'id', error: null }); },
  functions: {
    invoke(_name, options) {
      if (options.method === 'GET') return Promise.resolve({ data: { feedback: [{ id: '8df6cebb-6810-4e00-9373-a7a1e8552894', github_login: 'r', target_type: 'project', target_key: 'k', category: 'useful', comment: 'c', status: 'pending', created_at: '2026-09-06T00:00:00Z' }] }, error: null });
      return successfulDecisionGate;
    },
  },
};
await bootFeedback({ document: successfulDecisionRaceUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: successfulDecisionRaceClient });
await new Promise((resolve) => setTimeout(resolve, 0));
const successfulDecisionEntry = successfulDecisionRaceUi.nodes.get('moderation-feedback-list').children[0];
const [, successfulDecisionApprove, successfulDecisionReject] = successfulDecisionEntry.children;
const successfulDecisionClick = successfulDecisionApprove.emit('click');
await Promise.resolve();
await successfulDecisionRaceUi.nodes.get('feedback-sign-out').emit('click');
successfulDecisionRaceUi.nodes.get('feedback-anonymous').focus();
const successfulDecisionStatus = successfulDecisionRaceUi.nodes.get('feedback-status').textContent;
resolveDecision({ data: { feedback: { id: '8df6cebb-6810-4e00-9373-a7a1e8552894', status: 'approved' } }, error: null });
await successfulDecisionClick;
assert.equal(successfulDecisionApprove.disabled, true);
assert.equal(successfulDecisionReject.disabled, true);
assert.equal(successfulDecisionRaceUi.document.activeElement, successfulDecisionRaceUi.nodes.get('feedback-anonymous'));
assert.equal(successfulDecisionRaceUi.nodes.get('feedback-status').textContent, successfulDecisionStatus);
assert.equal(successfulDecisionRaceUi.nodes.get('moderation-queue').hidden, true);
assert.equal(successfulDecisionRaceUi.nodes.get('moderation-feedback-list').children.length, 0);

const initialFailureUi = feedbackDom();
const initialFailureClient = {
  auth: {
    async getSession() { return { data: { session: null }, error: null }; },
    async signOut() { return { error: null }; },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
  },
  from() { return { select() { return Promise.resolve({ data: null, error: new Error('offline') }); } }; },
  rpc() { return Promise.resolve({ data: 'id', error: null }); },
  functions: { invoke() { return Promise.resolve({ data: null, error: null }); } },
};
await bootFeedback({ document: initialFailureUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: initialFailureClient });
assert.equal(initialFailureUi.nodes.get('feedback-retry').hidden, false);
assert.match(initialFailureUi.nodes.get('feedback-status').textContent, /unavailable/i);

function deferredSubmissionClient(submission) {
  return {
    auth: {
      async getSession() { return { data: { session: { user: { user_metadata: { user_name: 'reviewer' } } } }, error: null }; },
      async signOut() { return { error: null }; },
      onAuthStateChange(listener) { this.listener = listener; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from() { return { select() { return Promise.resolve({ data: [], error: null }); } }; },
    rpc() { return submission; },
    functions: { invoke() { return Promise.resolve({ data: null, error: { context: { status: 403 } } }); } },
  };
}

function beginSubmission(ui) {
  ui.nodes.get('feedback-target').value = 'project:hiring-observatory';
  ui.nodes.get('feedback-category').value = 'useful';
  ui.nodes.get('feedback-comment').value = 'Deferred feedback';
  return ui.nodes.get('feedback-form').emit('submit');
}

const signedOutSubmitUi = feedbackDom();
let resolveSignedOutSubmit;
const signedOutSubmitClient = deferredSubmissionClient(new Promise((resolve) => { resolveSignedOutSubmit = resolve; }));
await bootFeedback({ document: signedOutSubmitUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: signedOutSubmitClient });
const signedOutSubmission = beginSubmission(signedOutSubmitUi);
await Promise.resolve();
await signedOutSubmitUi.nodes.get('feedback-sign-out').emit('click');
const signedOutStatus = signedOutSubmitUi.nodes.get('feedback-status').textContent;
resolveSignedOutSubmit({ data: 'late-success-id', error: null });
await signedOutSubmission;
assert.equal(signedOutSubmitUi.nodes.get('feedback-status').textContent, signedOutStatus);
assert.equal(signedOutSubmitUi.nodes.get('feedback-retry').hidden, true);
assert.equal(signedOutSubmitUi.nodes.get('your-feedback-list').children.length, 0);
assert.equal(signedOutSubmitUi.nodes.get('feedback-form').hidden, true);

const expiredSubmitUi = feedbackDom();
let rejectExpiredSubmit;
const expiredSubmitClient = deferredSubmissionClient(new Promise((resolve) => { rejectExpiredSubmit = resolve; }));
await bootFeedback({ document: expiredSubmitUi.document, location: uiLocation, fetch: async () => ({ ok: true, json: async () => targetRelease }), config: enabledConfig, client: expiredSubmitClient });
const expiredSubmission = beginSubmission(expiredSubmitUi);
await Promise.resolve();
expiredSubmitClient.auth.listener('TOKEN_REFRESH_FAILED', null);
const expiredStatus = expiredSubmitUi.nodes.get('feedback-status').textContent;
rejectExpiredSubmit({ data: null, error: new Error('expired session') });
await expiredSubmission;
assert.equal(expiredSubmitUi.nodes.get('feedback-status').textContent, expiredStatus);
assert.equal(expiredSubmitUi.nodes.get('feedback-retry').hidden, true);
assert.equal(expiredSubmitUi.nodes.get('your-feedback-list').children.length, 0);
assert.equal(expiredSubmitUi.nodes.get('feedback-form').hidden, true);

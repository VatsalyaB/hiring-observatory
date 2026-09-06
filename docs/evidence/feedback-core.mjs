const feedbackColumns = 'github_login, target_type, target_key, category, comment, status, created_at, moderated_at';
const categories = new Set(['useful', 'unclear', 'evidence_concern', 'suggestion']);
const targetTypes = new Set(['project', 'release', 'claim']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function withoutProviderTokens(value) {
  if (Array.isArray(value)) return value.map(withoutProviderTokens);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'provider_token' && key !== 'provider_refresh_token')
    .map(([key, nested]) => [key, withoutProviderTokens(nested)]));
}

function unavailable(cause) {
  const retry = cause?.message === 'rate limit exceeded' && typeof cause?.details === 'string'
    ? cause.details.match(/^retry_at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/)
    : null;
  if (retry && !Number.isNaN(Date.parse(retry[1]))) {
    const error = new Error(`Rate limit reached. Try again after ${retry[1]}.`);
    error.retryAt = retry[1];
    throw error;
  }
  const error = new Error('Feedback is unavailable. Please try again.');
  const status = cause?.context?.status ?? cause?.status;
  if (Number.isInteger(status)) error.status = status;
  throw error;
}

function validateSubmission(input) {
  const targetType = input?.targetType;
  const targetKey = typeof input?.targetKey === 'string' ? input.targetKey.trim() : '';
  const category = input?.category;
  const comment = typeof input?.comment === 'string' ? input.comment.trim() : '';
  if (!targetTypes.has(targetType)) throw new Error('Choose a valid feedback target.');
  if (!targetKey) throw new Error('Choose a valid feedback target.');
  if (!categories.has(category)) throw new Error('Choose a valid feedback category.');
  if (comment.length < 1 || comment.length > 2000) throw new Error('Feedback comment must be 1–2,000 characters.');
  return { p_target_type: targetType, p_target_key: targetKey, p_category: category, p_comment: comment };
}

function validateDecision(input) {
  const id = input?.id;
  const decision = input?.decision;
  const note = typeof input?.note === 'string' ? input.note.trim() : null;
  if (typeof id !== 'string' || !uuidPattern.test(id)) throw new Error('Choose valid feedback to moderate.');
  if (decision !== 'approved' && decision !== 'rejected') throw new Error('Choose an approval or rejection.');
  if (note && note.length > 2000) throw new Error('Moderator note must be 2,000 characters or fewer.');
  return { id, decision, note: note || null };
}

async function resultOrUnavailable(request) {
  const { data, error } = await request;
  if (error) unavailable(error);
  return data;
}

export function buildFeedbackTargets(release) {
  return [
    { type: 'project', key: 'hiring-observatory', label: 'Hiring Observatory project' },
    { type: 'release', key: release.release_id, label: release.release_id },
    ...(release.insights ?? []).map((insight) => ({
      type: 'claim', key: `${release.release_id}:${insight.id}`, label: insight.summary,
    })),
  ];
}

export function createTokenFilteringStorage(storage) {
  return {
    get length() { return storage.length; },
    clear() { storage.clear(); },
    getItem(key) { return storage.getItem(key); },
    key(index) { return storage.key(index); },
    removeItem(key) { storage.removeItem(key); },
    setItem(key, value) {
      let filtered = value;
      try {
        filtered = JSON.stringify(withoutProviderTokens(JSON.parse(value)));
      } catch {}
      storage.setItem(key, filtered);
    },
  };
}

export function renderPlainText(node, value) {
  node.textContent = String(value);
}

export function createFeedbackApi(client) {
  return {
    async list() {
      return (await resultOrUnavailable(client.from('reviewer_feedback').select(feedbackColumns))) ?? [];
    },
    async submit(input) {
      return resultOrUnavailable(client.rpc('submit_reviewer_feedback', validateSubmission(input)));
    },
    async listPending() {
      const data = await resultOrUnavailable(client.functions.invoke('moderate-feedback', { method: 'GET' }));
      return data?.feedback ?? data ?? [];
    },
    async decide(input) {
      const data = await resultOrUnavailable(client.functions.invoke('moderate-feedback', {
        method: 'POST', body: validateDecision(input),
      }));
      return data?.feedback ?? data;
    },
  };
}

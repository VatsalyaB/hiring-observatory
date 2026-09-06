import { createClient } from '@supabase/supabase-js';
import { feedbackConfig } from './feedback-config.mjs';
import { buildFeedbackTargets, createFeedbackApi, createTokenFilteringStorage } from './feedback-core.mjs';

function node(document, selector) { return document.querySelector(selector); }
function setStatus(document, message) { const status = node(document, '#feedback-status'); if (status) status.textContent = message; }
function setHidden(document, selector, hidden) { const element = node(document, selector); if (element) element.hidden = hidden; }

function row(document, feedback) {
  const item = document.createElement('li');
  const state = feedback.status ? ' | Status: ' + feedback.status : '';
  item.className = 'feedback-row';
  item.textContent = 'Target: ' + feedback.target_type + '/' + feedback.target_key
    + ' | Submitted: ' + (feedback.created_at?.slice(0, 10) ?? 'unknown')
    + ' | Reviewer: @' + feedback.github_login + ' | Category: ' + feedback.category
    + state + ' | Comment: ' + feedback.comment;
  return item;
}

function renderRows(document, selector, feedback) {
  const list = node(document, selector);
  if (list) list.replaceChildren(...feedback.map((item) => row(document, item)));
}

function targets(document, release) {
  const select = node(document, '#feedback-target');
  if (!select) return;
  select.replaceChildren();
  for (const target of buildFeedbackTargets(release)) {
    const option = document.createElement('option');
    option.value = target.type + ':' + target.key;
    option.textContent = target.label;
    select.append(option);
  }
}

function commentCount(document) {
  const comment = node(document, '#feedback-comment');
  const output = node(document, '#feedback-characters');
  if (comment && output) output.textContent = (2000 - comment.value.length).toLocaleString() + ' characters remaining';
}

function teardown(document) {
  setHidden(document, '#feedback-form', true);
  setHidden(document, '#feedback-anonymous', false);
  setHidden(document, '#feedback-sign-out', true);
  setHidden(document, '#moderation-queue', true);
  setHidden(document, '#feedback-retry', true);
  const comment = node(document, '#feedback-comment');
  if (comment) comment.value = '';
  renderRows(document, '#your-feedback-list', []);
  renderRows(document, '#moderation-feedback-list', []);
}

function restoreFocus(document, location) {
  if (location.hash === '#feedback-comment') node(document, '#feedback-comment')?.focus();
}

function bindForm(document, state) {
  const form = node(document, '#feedback-form');
  const comment = node(document, '#feedback-comment');
  const target = node(document, '#feedback-target');
  const category = node(document, '#feedback-category');
  const submit = node(document, '#feedback-submit');
  if (state.formBound || !form) return;
  state.formBound = true;
  comment?.addEventListener('input', () => commentCount(document));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.session) return;
    const generation = state.generation;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    try {
      const [targetType, ...targetKey] = target.value.split(':');
      const id = await state.api.submit({ targetType, targetKey: targetKey.join(':'), category: category.value, comment: comment.value });
      if (generation !== state.generation || !state.session) return;
      const user = state.session.user?.user_metadata?.user_name ?? 'you';
      state.feedback.push({ id, github_login: user, target_type: targetType, target_key: targetKey.join(':'), category: category.value, comment: comment.value.trim(), status: 'pending', created_at: new Date().toISOString() });
      renderRows(document, '#your-feedback-list', state.feedback.filter((item) => item.status !== 'approved'));
      comment.value = '';
      commentCount(document);
      setStatus(document, 'Feedback submitted for review. It is not public yet.');
    } catch (error) {
      if (generation !== state.generation || !state.session) return;
      setHidden(document, '#feedback-retry', false);
      setStatus(document, error.message);
      node(document, '#feedback-retry')?.focus();
    } finally {
      if (generation === state.generation && state.session) {
        submit.disabled = false;
        form.setAttribute('aria-busy', 'false');
      }
    }
  });
}

async function renderModeration(document, state, generation) {
  try {
    const feedback = await state.api.listPending();
    if (generation !== state.generation || !state.session) return;
    const queue = node(document, '#moderation-queue');
    const list = node(document, '#moderation-feedback-list');
    if (!queue || !list) return;
    queue.hidden = false;
    list.replaceChildren(...feedback.map((item) => {
      const entry = row(document, item);
      const note = document.createElement('textarea');
      note.className = 'moderation-note';
      note.maxLength = 2000;
      note.setAttribute('aria-label', 'Private moderator note');
      entry.append(note);
      const actions = ['approved', 'rejected'].map((decision) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'moderation-action';
        button.textContent = decision;
        button.addEventListener('click', async () => {
          for (const control of [...actions, note]) control.disabled = true;
          entry.setAttribute('aria-busy', 'true');
          const decisionGeneration = state.generation;
          try {
            await state.api.decide({ id: item.id, decision, note: note.value });
            if (decisionGeneration !== state.generation || !state.session) return;
            entry.remove();
            queue.tabIndex = -1;
            queue.focus();
            setStatus(document, 'Feedback ' + decision + '.');
          } catch {
            if (decisionGeneration !== state.generation || !state.session) return;
            for (const control of [...actions, note]) control.disabled = false;
            entry.setAttribute('aria-busy', 'false');
            button.focus();
            setStatus(document, 'Feedback is unavailable. Please try again.');
          }
        });
        entry.append(button);
        return button;
      });
      return entry;
    }));
  } catch (error) {
    if (generation !== state.generation || !state.session) return;
    if (error.status === 403) {
      setHidden(document, '#moderation-queue', true);
      return;
    }
    setHidden(document, '#feedback-retry', false);
    setStatus(document, 'Feedback is unavailable. Please try again.');
  }
}

function showSession(document, state) {
  const signedIn = Boolean(state.session);
  setHidden(document, '#feedback-form', !signedIn);
  setHidden(document, '#feedback-anonymous', signedIn);
  setHidden(document, '#feedback-sign-out', !signedIn);
  renderRows(document, '#your-feedback-list', signedIn ? state.feedback.filter((item) => item.status !== 'approved') : []);
}

export async function bootFeedback({ document, location, fetch, config = feedbackConfig, client = null }) {
  if (!config.enabled) {
    teardown(document);
    setHidden(document, '#feedback-anonymous', true);
    setStatus(document, 'Reviewer feedback is not connected yet.');
    return;
  }

  const feedbackClient = client ?? createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { flowType: 'pkce', storage: createTokenFilteringStorage(globalThis.localStorage), autoRefreshToken: true, persistSession: true },
  });
  const state = { api: createFeedbackApi(feedbackClient), session: null, feedback: [], formBound: false, generation: 0 };
  const retry = node(document, '#feedback-retry');
  const start = async () => {
    const generation = state.generation;
    retry.hidden = true;
    try {
      const [feedback, result, release] = await Promise.all([
        state.api.list(),
        feedbackClient.auth.getSession(),
        fetch('./data/pilot.json', { cache: 'no-store' }).then(async (response) => {
          if (!response.ok) throw new Error('release unavailable');
          return response.json();
        }),
      ]);
      if (generation !== state.generation) return;
      state.feedback = feedback;
      state.session = result.data?.session ?? null;
      targets(document, release);
      renderRows(document, '#public-feedback-list', feedback.filter((item) => item.status === 'approved'));
      showSession(document, state);
      bindForm(document, state);
      if (state.session) {
        restoreFocus(document, location);
        void renderModeration(document, state, generation);
      }
      setStatus(document, 'Feedback ready.');
    } catch {
      if (generation !== state.generation) return;
      setHidden(document, '#feedback-retry', false);
      setStatus(document, 'Feedback is unavailable. Please try again.');
    }
  };

  node(document, '#feedback-sign-in')?.addEventListener('click', async () => {
    const { error } = await feedbackClient.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.href.split('#')[0] + '#feedback-comment' } });
    if (error) setStatus(document, 'Feedback is unavailable. Please try again.');
  });
  node(document, '#feedback-sign-out')?.addEventListener('click', async () => {
    state.generation += 1;
    const { error } = await feedbackClient.auth.signOut();
    if (error) return setStatus(document, 'Feedback is unavailable. Please try again.');
    state.session = null;
    state.feedback = [];
    teardown(document);
    setStatus(document, 'Signed out of reviewer feedback.');
  });
  feedbackClient.auth.onAuthStateChange?.((_event, session) => {
    if (!session) {
      state.generation += 1;
      state.session = null;
      state.feedback = [];
      teardown(document);
    }
  });
  retry?.addEventListener('click', start);
  await start();
}

if (typeof document !== 'undefined') void bootFeedback({ document, location, fetch });

const githubLogin = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseModeratorLogins(value) {
  if (typeof value !== 'string') throw new Error('moderator logins must be a string');

  const logins = new Set();
  for (const login of value.split(',')) {
    const normalized = login.trim().toLowerCase();
    if (!normalized) continue;
    if (!githubLogin.test(normalized)) throw new Error('invalid moderator login');
    logins.add(normalized);
  }
  return logins;
}

export function isModerator(login, allowed) {
  return typeof login === 'string' && allowed instanceof Set && allowed.has(login.toLowerCase());
}

export function parseDecision(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('decision body must be an object');
  }

  const { id, decision, note } = body;
  if (typeof id !== 'string' || !uuid.test(id)) throw new Error('invalid id');
  if (decision !== 'approved' && decision !== 'rejected') throw new Error('invalid decision');
  if (note !== undefined && note !== null && typeof note !== 'string') throw new Error('invalid note');

  const normalizedNote = note == null ? null : note.trim();
  if (normalizedNote && normalizedNote.length > 2000) throw new Error('invalid note');

  return { id, decision, note: normalizedNote || null };
}

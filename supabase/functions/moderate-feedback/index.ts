import { createClient } from 'npm:@supabase/supabase-js@2.115.0';
import { isModerator, parseDecision, parseModeratorLogins } from './policy.mjs';

const allowedOrigins = new Set([
  'https://vatsalyab.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);

function headersFor(request: Request) {
  const origin = request.headers.get('Origin');
  return origin && allowedOrigins.has(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Vary': 'Origin',
      }
    : { 'Vary': 'Origin' };
}

function response(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headersFor(request) },
  });
}

function hasAllowedOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  return !origin || allowedOrigins.has(origin);
}

async function authorize(request: Request): Promise<{ login: string } | Response> {
  const authorization = request.headers.get('Authorization');
  const jwt = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return response(request, { error: 'unauthorized' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anonKey) return response(request, { error: 'unable to moderate feedback' }, 500);

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.getUser(jwt);
  const user = data.user;
  if (error || !user) return response(request, { error: 'unauthorized' }, 401);

  const identity = user.identities?.find((identity) => identity.provider === 'github');
  if (!identity) return response(request, { error: 'forbidden' }, 403);
  const login = identity.identity_data?.user_name;
  if (typeof login !== 'string') return response(request, { error: 'forbidden' }, 403);

  let allowed: Set<string>;
  try {
    allowed = parseModeratorLogins(Deno.env.get('MODERATOR_GITHUB_LOGINS') ?? '');
  } catch {
    return response(request, { error: 'unable to moderate feedback' }, 500);
  }

  return isModerator(login, allowed)
    ? { login: login.toLowerCase() }
    : response(request, { error: 'forbidden' }, 403);
}

async function handleRequest(request: Request) {
  if (!hasAllowedOrigin(request)) return response(request, { error: 'forbidden' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: headersFor(request) });
  if (request.method !== 'GET' && request.method !== 'POST') {
    return response(request, { error: 'method not allowed' }, 405);
  }

  const caller = await authorize(request);
  if (caller instanceof Response) return caller;

  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) return response(request, { error: 'unable to moderate feedback' }, 500);
  const service = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (request.method === 'GET') {
    const { data, error } = await service
      .from('reviewer_feedback')
      .select('id, github_login, target_type, target_key, category, comment, status, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    return error
      ? response(request, { error: 'unable to moderate feedback' }, 500)
      : response(request, { feedback: data });
  }

  let decision;
  try {
    decision = parseDecision(await request.json());
  } catch {
    return response(request, { error: 'invalid decision' }, 400);
  }

  const { data, error } = await service
    .from('reviewer_feedback')
    .update({
      status: decision.decision,
      moderated_at: new Date().toISOString(),
      moderated_by_login: caller.login,
      moderator_note: decision.note,
    })
    .eq('id', decision.id)
    .eq('status', 'pending')
    .select('id, status')
    .maybeSingle();

  if (error) return response(request, { error: 'unable to moderate feedback' }, 500);
  if (!data) return response(request, { error: 'feedback decision conflict' }, 409);
  return response(request, { feedback: data });
}

Deno.serve(async (request) => {
  try {
    return await handleRequest(request);
  } catch {
    return response(request, { error: 'unable to moderate feedback' }, 500);
  }
});

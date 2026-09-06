# Reviewer feedback hosted setup

This is a free, remote Supabase setup. Docker and the local Supabase stack are not required. Use a non-production project until the smoke checklist passes.

## Deploy

From this repository, run:

    npx supabase@2.116.0 login
    read -r -p "Supabase project ref: " SUPABASE_PROJECT_REF
    test -n "$SUPABASE_PROJECT_REF"
    npx supabase@2.116.0 link --project-ref "$SUPABASE_PROJECT_REF"
    npx supabase@2.116.0 db push
    read -r -p "Moderator GitHub login: " MODERATOR_GITHUB_LOGIN
    test -n "$MODERATOR_GITHUB_LOGIN"
    npx supabase@2.116.0 secrets set MODERATOR_GITHUB_LOGINS="$MODERATOR_GITHUB_LOGIN"
    npx supabase@2.116.0 functions deploy moderate-feedback --no-verify-jwt

MODERATOR_GITHUB_LOGINS is a non-committable Supabase secret. The entered login is passed only to the hosted secret store.

--no-verify-jwt does not make moderation anonymous. It delegates JWT validation to the function's explicit auth.getUser(jwt) call, which then verifies the caller's GitHub identity and moderator membership before it uses the service-role key.

## GitHub OAuth and redirects

Create a GitHub OAuth application in Supabase Auth with no optional GitHub scopes. Its callback URL is:

    https://${SUPABASE_PROJECT_REF}.supabase.co/auth/v1/callback

In Supabase Auth, allow these exact application redirect URLs:

    https://vatsalyab.github.io/hiring-observatory/docs/evidence/
    http://localhost:8000/docs/evidence/
    http://127.0.0.1:8000/docs/evidence/

The client passes the full dashboard URL with #feedback-comment as redirectTo. Supabase JS
URL-encodes that full value as redirect_to. GoTrue ignores the fragment only when matching redirect
allowlists, so add the base dashboard URLs above without #feedback-comment. The browser receives
the fragment after OAuth and the client restores focus to the feedback form. If a local server uses a
different dashboard path, allow that full /docs/evidence/ URL for its actual origin rather than only
the origin.

Keep GitHub's OAuth client secret in Supabase Auth only; never commit it or place it in browser configuration.

## Publish the dashboard

In public/docs/evidence/feedback-config.mjs, set only these public values for the chosen project:

    enabled: true,
    supabaseUrl: 'https://<project-ref>.supabase.co',
    supabasePublishableKey: '<publishable-key>',

The URL and publishable key are public configuration. Do not add a service-role key, OAuth secret, moderator login list, or any other secret there. Export the public tree, publish the public repository, then configure GitHub Pages to deploy from main /docs.

To disable feedback safely, change enabled back to false, rebuild with npm run build:feedback, export and publish the updated public tree. The evidence dashboard remains usable while feedback is disabled or unavailable.

## Local configuration

.env.example documents optional local values. Never commit .env, Supabase CLI sessions, browser-storage data, service keys, OAuth secrets, or moderator login values.

Before enabling any production feedback, complete and record every item in docs/FEEDBACK-SMOKE.md.

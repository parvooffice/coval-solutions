# COVAL

COVAL uses a React/Vite web client, an Express 5 API, Supabase for authentication and persistent application data, and a separate Python FastAPI repository analyzer. The web application uses JavaScript and JSX; it does not use TypeScript.

## Local development

Copy `.env.example` to `.env` and add your Supabase project URL and publishable key. Vite embeds these public values into the client build, so restart the dev server after changing them. Add a random `CODE_EVALUATION_FUNCTION_SECRET` shared with the Python analyzer. Then install dependencies and start the Vite client and Express API:

```bash
npm install
npm run dev
```

In a second terminal, install and run the analyzer:

```bash
python -m pip install -r analyzer_service/requirements.txt
npm run analyzer
```

Open [http://localhost:3000](http://localhost:3000). Vite serves the React app and proxies API requests to Express on port 3001. FastAPI listens on port 8000. Public repository analysis does not need a GitHub token; private repository analysis needs a read-only `GITHUB_TOKEN` on the analyzer service.

## Supabase setup

Supabase is the only authentication and application database. It stores member accounts and profiles, featured repositories and profile visibility, connections and notifications, messages, code evaluation results, and profile banner files. The Express API forwards each signed-in user's Supabase access token to PostgREST. Row-level security policies scope reads and writes to the current member and their conversations. The app does not use a service-role key.

Configure the Supabase URL and publishable key in `.env`. In Supabase **Authentication → Providers**, configure Google and GitHub. Set each OAuth provider's callback URL to `https://<project-ref>.supabase.co/auth/v1/callback`. In **Authentication → URL Configuration**, set the COVAL site URL and allow local and deployed redirects such as `http://localhost:3000/dashboard` and `https://<coval-domain>/dashboard`. Enable manual identity linking if members should add GitHub to an existing Google account.

In the Supabase SQL Editor, apply these migrations in filename order:

- [`202610250001_coval_communication.sql`](./supabase/migrations/202610250001_coval_communication.sql) — profiles, connections, conversations, and messages.
- [`202610250002_coval_code_evaluations.sql`](./supabase/migrations/202610250002_coval_code_evaluations.sql) — per-user evaluation report storage.
- [`202610250003_coval_shared_evaluations.sql`](./supabase/migrations/202610250003_coval_shared_evaluations.sql) — opt-in sharing of scores for public repositories.
- [`202610250004_coval_linked_github_profiles.sql`](./supabase/migrations/202610250004_coval_linked_github_profiles.sql) — synchronization of profiles when GitHub is linked or unlinked.
- [`202610250005_coval_member_presence.sql`](./supabase/migrations/202610250005_coval_member_presence.sql) — presence and connections for Google-only members.
- [`202610250006_coval_social_notifications.sql`](./supabase/migrations/202610250006_coval_social_notifications.sql) — mutual connections and notifications.
- [`202610250007_coval_network_tree_visibility.sql`](./supabase/migrations/202610250007_coval_network_tree_visibility.sql) — per-connection network tree visibility.
- [`202610260001_coval_public_profiles.sql`](./supabase/migrations/202610260001_coval_public_profiles.sql) — editable profile details, featured repositories, and section visibility.
- [`202610260002_coval_profile_banners.sql`](./supabase/migrations/202610260002_coval_profile_banners.sql) — the Supabase Storage bucket and scoped banner upload policies.
- [`202611200001_coval_teams.sql`](./supabase/migrations/202611200001_coval_teams.sql) — teams, admin invites, team-admin access to member evaluations, and team-wide agent averages.

Existing Supabase accounts and records stay in place. Apply any application migrations above that have not already been applied to your project.

## Python repository analyzer

The separate FastAPI service exposes `GET /health` and `POST /api/code-evaluation-python`. The Express API calls it using `x-coval-evaluation-secret`; configure the same `CODE_EVALUATION_FUNCTION_SECRET` for both services. The analyzer runs Documentation, Modularity, Security, Error Handling, Readability, and Test Coverage scorers and accepts up to five GitHub repository URLs per run.

Readability (`readability/`) scores function size, nesting, branching complexity, line length, naming, and file size. Test Coverage (`test-coverage/`) statically estimates how many source modules have matching tests, test volume, assertion density, and whether a test runner, CI, and coverage tooling are configured. Performance (`performance/`), Maintainability (`maintainability/`), Scalability (`scalability/`), and Standards compliance (`standards/`) share helpers in `agent-kit/` and report their top fixes with file and line. All six of these use only the Python standard library and never execute repository code.

Repositories are downloaded to temporary directories and removed after scoring. The analyzers do not modify remote repositories. Private analysis requires a server-side `GITHUB_TOKEN` with read access to the target repositories. Private results cannot be shared.

## Vercel

COVAL deploys from this repository to two Vercel projects that share `vercel.json`:

- **Web app** builds the Vite client into `app/dist` and serves `/api/*` from `api/index.js`, which runs the same Express app as `npm start` (`server/app.js`).
- **Code-review agents** run in `api/code-evaluation-python.py`, a Python function that executes all ten agents (Documentation, Modularity, Security, Error handling, Readability, Test coverage, Performance, Maintainability, Scalability, Standards compliance) on their own in the cloud.

In the web app project, set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, default `gpt-4o-mini`) for the report assistant, the Supabase URL and publishable key, `CODE_EVALUATION_API_URL` to the agents project's `https://<agents-domain>/api/code-evaluation-python`, and `CODE_EVALUATION_FUNCTION_SECRET`. Set the same `CODE_EVALUATION_FUNCTION_SECRET` in the agents project. Both functions allow up to 300 seconds per run.

## Docker Compose

Copy `.env.example` to `.env`, configure Supabase and the analyzer secret, then run `docker compose up --build`. Compose builds the client using the public Supabase URL and publishable key, runs Express and FastAPI, and publishes the web app on port 3000. Supabase remains the authentication provider, database, and file storage.

## Environment variables

See [`.env.example`](./.env.example). The Supabase URL and publishable key are included in the browser bundle; database access is protected by RLS. `GITHUB_TOKEN` and `CODE_EVALUATION_FUNCTION_SECRET` are server-only. Do not commit `.env`, a service-role key, OAuth client secrets, or GitHub tokens.

## API

- `/api/dashboard`, `/api/members`, and `/api/github-repositories` provide GitHub and directory data.
- `/api/profile` and `/api/profile/banner` read and update Supabase profiles and Storage banners.
- `/api/connections`, `/api/notifications`, `/api/conversations`, and `/api/messages` serve Supabase-backed community features.
- `GET /api/code-evaluation` loads saved results; `POST /api/code-evaluation` runs and stores an evaluation.
- `GET /api/health` reports Express and Supabase configuration status.
- `GET /api/teams` and `POST /api/teams` list teams and pending invites, and create teams, invite members, accept or decline invites, change roles, and remove members. Admins receive each active member's score summary; members receive only team-wide averages.
- `POST /api/report-chat` answers questions about the signed-in member's saved reports. It retrieves the relevant report passages and sends only those to OpenAI; `OPENAI_API_KEY` stays on the server.

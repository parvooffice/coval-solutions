# COVAL dashboard

COVAL is a GitHub engineering dashboard for repository health, contributors, organization activity, pull requests, code evaluation, and direct messages.

## Deploy on Vercel

COVAL uses two Vercel projects connected to this same GitHub repository. The dashboard is a Next.js project. The repository analyzers use a Python Vercel Function. Vercel's Next.js framework routing takes precedence over file-based Python functions, so the Python service is deployed separately from the same repository. See [Next.js on Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs) and [Python functions in `/api`](https://vercel.com/docs/functions/runtimes/python/api-directory).

### 1. Deploy the analyzer service

1. In Vercel, import this repository as a new project named something like `coval-code-evaluation-api`.
2. Set **Root Directory** to the repository root (`.`) and **Framework Preset** to **Other**. Do not select Next.js for this project. Leave the build command and output directory empty; Vercel builds the Python function from `api/code-evaluation-python.py` and installs the root `requirements.txt`.
3. Add these Production and Preview environment variables to this project:
   - `CODE_EVALUATION_FUNCTION_SECRET` — a long random value. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and keep it private.
   - `GITHUB_TOKEN` — optional for public repositories; required to evaluate private repositories. Use a read-only token for the repositories being evaluated.
4. Deploy the project. In **Settings → Domains**, use its stable production project domain and append `/api/code-evaluation-python`, for example `https://coval-code-evaluation-api.vercel.app/api/code-evaluation-python`.

The analyzer endpoint is internet-routable but rejects requests unless the shared secret matches. Keep that secret out of browser code and leave Vercel Deployment Protection disabled on the analyzer project so the dashboard server can reach it. The shared secret protects the endpoint.

### 2. Deploy the dashboard

1. Import the same repository again as a second Vercel project, for example `coval-dashboard`.
2. Keep **Root Directory** at the repository root and use the **Next.js** framework preset. The project uses `npm run build`; no custom build command is needed.
3. Add the frontend environment variables from the table below. Set `CODE_EVALUATION_API_URL` to the full analyzer endpoint copied in step 1. Set `CODE_EVALUATION_FUNCTION_SECRET` to the exact same random value configured in the analyzer project.
4. Deploy the dashboard. In Vercel **Settings → Domains**, copy its production URL for the GitHub/Supabase OAuth setup below.

Vercel environment changes apply to new deployments, so redeploy each project after editing its variables. Vercel's [environment variable guide](https://vercel.com/docs/environment-variables) explains Production and Preview scopes.

### Environment variables

The [`.env.example`](./.env.example) lists the required variables. Local `.env` files are ignored by Git; keep their credentials private. Configure deployment values in each Vercel project's **Settings → Environment Variables**.

| Variable | Vercel project | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Dashboard | Supabase project URL used by sign-in and browser auth. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Dashboard | Supabase publishable key; safe for browser use when database row-level security is enabled. |
| `GITHUB_TOKEN` | Dashboard and analyzer | Server-only GitHub token for repository/org data and private repository archives. Never prefix it with `NEXT_PUBLIC_`. |
| `GITHUB_ORG` | Dashboard | GitHub organization whose projects, people, and activity populate the workspace. Use this or `GITHUB_REPOS`. |
| `GITHUB_REPOS` | Dashboard | Optional comma-separated `owner/repository` list when not loading an organization. |
| `COVAL_ALLOWED_GITHUB_USERS` | Dashboard | Comma-separated GitHub logins allowed when `GITHUB_REPOS` is used without `GITHUB_ORG`. |
| `CODE_EVALUATION_API_URL` | Dashboard | Full HTTPS URL to the analyzer project's `/api/code-evaluation-python` endpoint. |
| `CODE_EVALUATION_FUNCTION_SECRET` | Both projects | Same random secret in both projects; protects the internal analyzer endpoint. |
| `GITHUB_USERNAME` | Dashboard, optional | Primary contribution account fallback if the GitHub profile cannot be inferred. |
| `GITHUB_REPO_PAGES` | Dashboard, optional | Organization repository pages to fetch; defaults to `2`. |
| `GITHUB_MEMBER_PAGES` | Dashboard, optional | Organization member pages to fetch; defaults to `2`. |
| `GITHUB_ACTIVITY_REPOS` | Dashboard, optional | Recent repositories used for activity; defaults to `20`. |
| `GITHUB_MAX_REPOS` | Dashboard, optional | Maximum workspace repositories; defaults to `100`. |
| `GITHUB_MAX_PEOPLE` | Dashboard, optional | Maximum workspace people; defaults to `100`. |
| `SUPABASE_URL` | Dashboard, optional fallback | Legacy server-side fallback for `NEXT_PUBLIC_SUPABASE_URL`. |
| `SUPABASE_PUBLISHABLE_KEY` | Dashboard, optional fallback | Legacy server-side fallback for the Supabase publishable key. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard, optional fallback | Legacy browser key fallback; prefer the publishable key above. |
| `CODE_EVALUATION_PYTHON` | Not used on Vercel | Optional Python executable path for the standalone local CLI only. |

If the workspace uses a fixed repository list rather than an organization, configure `GITHUB_REPOS` and allowlist its signed-in users in `COVAL_ALLOWED_GITHUB_USERS`. The app does not use a Supabase service-role key. Keep database writes scoped to the signed-in user's row through the included row-level security policies.

### 3. Connect GitHub sign-in through Supabase

GitHub sign-in identifies the user to COVAL. A linked GitHub identity lets the dashboard load that user's public repositories and repository activity. `GITHUB_TOKEN` remains a server-only token for configured organization data, GraphQL contribution details, and API rate limits; it is not used to expose private repositories to other COVAL users.

1. In Supabase, open **Authentication → Sign In / Providers → GitHub** and enable GitHub.
2. Create a GitHub OAuth App under **GitHub → Settings → Developer settings → OAuth Apps**. Set its homepage URL to the dashboard's Vercel URL. Set its authorization callback URL to `https://<supabase-project-ref>.supabase.co/auth/v1/callback`.
3. Copy the OAuth app's client ID and client secret into the Supabase GitHub provider settings. Keep the client secret in Supabase; do not add it to Vercel or frontend code.
4. In Supabase **Authentication → URL Configuration**, set the Site URL to the dashboard's Vercel URL and add the production dashboard redirect, such as `https://<dashboard-project>.vercel.app/dashboard`, to the redirect allow list. Add Preview URLs if users need to sign in on preview deployments.
5. In Supabase Authentication settings, enable **manual identity linking** so a user who signed in with Google can attach GitHub to the same COVAL account.
6. In Vercel, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` on the dashboard project, then redeploy.

After deployment, sign in, open **Settings → Active workspace → Connect GitHub**, and authorize the GitHub account. The dashboard then loads that account's public repositories, contributors, pull requests, repository activity, and profile. Private repositories are not included in this per-user connection. A dashboard `GITHUB_TOKEN` can supply GraphQL contribution details and higher GitHub API rate limits.

For private repository access, create a GitHub token with read-only access to the required repositories. Organization people/teams also require permission to read organization membership. Set the token as `GITHUB_TOKEN` in the dashboard project and the analyzer project when private repositories are evaluated. The token is only read by server functions.

References: [GitHub OAuth App setup](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) · [Supabase GitHub sign-in](https://supabase.com/docs/guides/auth/social-login/auth-github).

### 4. Configure Supabase tables

In the Supabase SQL Editor, apply these migrations in filename order:

- [`202610250001_coval_communication.sql`](./supabase/migrations/202610250001_coval_communication.sql) — GitHub-linked profiles, connections, private conversations, and messages.
- [`202610250002_coval_code_evaluations.sql`](./supabase/migrations/202610250002_coval_code_evaluations.sql) — per-user code evaluation result storage.
- [`202610250003_coval_shared_evaluations.sql`](./supabase/migrations/202610250003_coval_shared_evaluations.sql) — opt-in sharing of scores for public repositories with signed-in COVAL members.

The migrations enable row-level security and use the user's Supabase session for reads and writes. Existing authenticated users are backfilled from their GitHub OAuth metadata.

### 5. Verify the deployment

Open the dashboard's Vercel URL and sign in with GitHub. Any GitHub-connected member can score up to five public GitHub repositories per run by pasting URLs, importing their public repositories, or loading a URL file. Each run uses the existing Documentation, Modularity, Security, and Error handling analyzers. Scores are saved to the evaluator's own Supabase account. The evaluator can opt in to share that run with other signed-in COVAL members; only scores for repositories verified as public are published. Private reports remain private. Community results appear in the Code Evaluation page. Public repository analysis does not require a shared `GITHUB_TOKEN`.

The GitHub workspace dashboard is a separate, configured organization/repository view. If `GITHUB_ORG` is set, its membership check can restrict access to that workspace; evaluation of public repository URLs is available to any signed-in user whose account is connected to GitHub. Private repository analysis is not per-user yet: it requires the workspace owner's server-side `GITHUB_TOKEN`, so don't use that shared-token path to promise access to each member's private repositories.

The Python service downloads source archives into temporary storage and removes them after analysis. It limits each archive to 75 MB compressed and 150 MB extracted. The analyzers do not modify the remote repositories. The Vercel Function duration is configured to 300 seconds; large repositories or five-repository batches may need to be split into smaller runs if they exceed the plan's execution limit.

## GitHub data and workspace behavior

When a user connects GitHub in Settings, the dashboard uses that user's public repositories and their contributors, stars, languages, update times, activity, and pull requests. Otherwise, it uses the configured `GITHUB_ORG` or `GITHUB_REPOS` workspace, which may require organization membership or the `COVAL_ALLOWED_GITHUB_USERS` allowlist. GitHub GraphQL supplies the primary account's one-year contribution calendar, pull-request/review contributions, and active/best streak when `GITHUB_TOKEN` is configured. Organization merged/open pull-request counts come from GitHub search. The recent pull-request list is limited to the ten most recently updated pull requests per repository.

GitHub does not provide online presence, job titles, career history, or private messages for arbitrary users. Those values are not fabricated. Direct messages require both people to sign into COVAL with GitHub.

## API routes

- `GET /api/dashboard` — configured repositories, contributors, teams, activity, pull requests, metrics, and contribution calendar.
- `GET /api/github-repositories` — the signed-in GitHub account's public repositories for the import control.
- `GET /api/code-evaluation`, `POST /api/code-evaluation` — load the current user's saved results and signed-in community results, run analyzers, and optionally share a verified-public-repository score bundle.
- `POST /api/code-evaluation-python` — Python Vercel function that runs the existing four analyzers; accepts requests only from the dashboard backend with the shared secret.
- `GET /api/profile?login=...` — public GitHub profile and optional contribution data.
- `GET /api/connections`, `POST /api/connections`, `DELETE /api/connections` — signed-in user's saved connections.
- `GET /api/conversations` — inbox; optionally pass `conversationId` for its messages.
- `POST /api/conversations`, `DELETE /api/conversations` — create or leave a private direct conversation.
- `POST /api/messages`, `PATCH /api/messages` — send a message or update the read timestamp.

Dashboard data is cached in the server process for five minutes to stay within GitHub API limits. Supabase routes forward the signed-in user's session to PostgREST so row-level security remains in effect.

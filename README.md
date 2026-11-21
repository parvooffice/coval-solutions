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
- [`202611210001_coval_feed.sql`](./supabase/migrations/202611210001_coval_feed.sql) — the Feed: score showcases, job openings, and team-formation posts with an "Interested" queue (accepting a team post sends a team invite).
- [`202611200004_coval_early_access.sql`](./supabase/migrations/202611200004_coval_early_access.sql) — early access: every member gets Pro features until you switch the paywall on (instructions at the top of the file).
- [`202611200003_coval_shared_reports.sql`](./supabase/migrations/202611200003_coval_shared_reports.sql) — public share links and README badges for public repositories.
- [`202611200002_coval_billing.sql`](./supabase/migrations/202611200002_coval_billing.sql) — Free and Pro plans, monthly usage limits, and signed plan updates. After applying it, store your `COVAL_BILLING_SIGNING_SECRET` with the `insert` shown at the top of the file.

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

## Plans and payments (Razorpay)

Free accounts get 5 evaluation runs and 10 report-assistant questions per month and can join teams. COVAL Pro adds unlimited runs, 300 assistant questions, and creating teams. Limits are enforced in Supabase.

1. In Razorpay, create a monthly **Plan** with your Pro price and copy its plan ID.
2. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_PLAN_ID`, `RAZORPAY_WEBHOOK_SECRET`, and a random 32+ character `COVAL_BILLING_SIGNING_SECRET` in the web app's environment.
3. Apply the billing migration and store the same signing secret in `coval_billing_config`.
4. In Razorpay **Webhooks**, add `https://<web-domain>/api/billing/webhook` with the webhook secret and the `subscription.authenticated`, `activated`, `charged`, `pending`, `halted`, `cancelled`, and `completed` events.

The app has no Supabase service-role key, so the server signs every plan change and the database verifies the signature before storing it. Use Razorpay test mode keys until you are ready to charge.

## Guest preview and Feed

Visitors can choose **Explore without signing in** on the landing page (`/dashboard?guest=1`). The guest preview shows the Flask sample report, sample Teams and Network views, and the public Feed. Reads of private data return empty results, any action that needs an account opens a sign-in prompt, a prompt also appears after a minute (dismissable once), and a final prompt after two more minutes requires signing in.

The **Feed** lets members post a verified score (from a shared report), a job opening, or a team-formation request. Others tap **Interested** (with an optional note) to join the author's queue; the author can accept, decline, or message them, and accepting a team post linked to a team sends a team invite. `GET /api/feed` is public; posting and responding use `POST /api/feed`.

## CLI and pull request reviews

[`cli/`](./cli/README.md) provides `coval scan` and `coval review`. `coval review` compares a branch with its base using the same agents and comment format as the VS Code extension and the GitHub App, can post the comment on a pull request, and can fail CI when scores drop. CI runs it on every pull request to this repository.

Releases: pushing a tag such as `v0.1.0` runs `.github/workflows/release.yml`, which tests and builds the `.vsix` and the CLI package and attaches them to a [GitHub Release](https://github.com/parvooffice/coval-solutions/releases/latest). Because the repository is private, the website also hosts both files at [`/download.html`](./public/download.html) (`public/downloads/`); copy the new builds there when you release a new version.

## VS Code extension

[`ide-extension/`](./ide-extension/README.md) runs six of the agents (Readability, Test coverage, Performance, Maintainability, Scalability, Standards compliance) locally on the open folder and shows each fix as an inline warning, in the Problems panel, and in a COVAL scores view. Code never leaves the machine. Build it with `cd ide-extension && npm run package`, then install the `.vsix` from the Extensions view.

## GitHub App (private repositories and pull request comments)

1. On GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Set the homepage to your COVAL URL and the webhook URL to `https://<web-domain>/api/github/webhook`, with a random webhook secret.
3. Repository permissions: **Contents: Read-only**, **Metadata: Read-only**, **Pull requests: Read and write**. Subscribe to the **Pull request** event.
4. Create the app, generate a private key, and note the App ID and the app's URL name (slug).
5. Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, and `COVAL_PUBLIC_URL` in the web app's environment.

Members install the app on the repositories they choose. Scoring a private repository requires Pro, a GitHub sign-in that can read the repository, and the app installed on it; COVAL then uses a one-hour, read-only token for that repository only. On each pull request, COVAL scores the base and head commits and keeps one comment updated with score changes and new findings. GitHub stops waiting for the webhook after 10 seconds; the comment appears when scoring finishes.

Add a `.coval.yml` to a repository to skip paths:

```yaml
ignore:
  - legacy/
  - "**/*.generated.ts"
```

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
- `GET /api/billing` returns the plan and monthly usage; `POST /api/billing` starts a Razorpay subscription, verifies checkout, or cancels at the end of the period. `POST /api/billing/webhook` receives Razorpay subscription events.
- `POST /api/explain-finding` explains one finding and suggests a fix using the surrounding code (OpenAI).
- `POST /api/share`, `GET /api/share?token=`, and `DELETE /api/share` manage public report links; `GET /api/badge?token=` returns the README badge. Pages: `/report/<token>` and `/report/sample`.
- `POST /api/github/webhook` receives GitHub App pull request events; `GET /api/github/app` returns the install link.
- `POST /api/report-chat` answers questions about the signed-in member's saved reports. It retrieves the relevant report passages and sends only those to OpenAI; `OPENAI_API_KEY` stays on the server.

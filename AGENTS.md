# COVAL stack

- The web client is React with Vite. Use JavaScript and JSX; do not add TypeScript.
- The API runs on Express 5. Route implementations under `app/api/` use standard Web `Request` and `Response` objects and are registered in `server/index.js`.
- Supabase is the only authentication, database, and profile-file storage service. Keep authenticated reads and writes scoped to the signed-in user's bearer token and the existing row-level security policies. Never add a Supabase service-role key to the app.
- Repository analyzers run in the separate Python FastAPI service under `analyzer_service/`.
- Configure local services through an ignored `.env` copied from `.env.example`. Do not commit OAuth secrets, database credentials, tokens, or analyzer secrets.
- Read `README.md` for local startup, Supabase setup, and deployment instructions.

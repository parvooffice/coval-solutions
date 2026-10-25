import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";

export async function GET(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ connections: [] });
    const connections = await supabaseRest(user, `coval_connections?select=target_github_login,created_at&user_id=eq.${user.id}&order=created_at.desc`);
    return Response.json({ connections });
  } catch (error) { return apiError(error); }
}

export async function POST(request) {
  try {
    const user = await requireUser(request);
    const { login } = await request.json();
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login || "")) return Response.json({ error: "Enter a valid GitHub username." }, { status: 400 });
    if (login.toLowerCase() === user.login.toLowerCase()) return Response.json({ error: "You are already connected to your own account." }, { status: 400 });
    if (!user.token) return Response.json({ error: "Sign in with GitHub to save connections." }, { status: 503 });
    const rows = await supabaseRest(user, "coval_connections", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ user_id: user.id, target_github_login: login }),
    });
    return Response.json({ connection: rows?.[0] || null });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request) {
  try {
    const user = await requireUser(request);
    const { login } = await request.json();
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login || "")) return Response.json({ error: "Enter a valid GitHub username." }, { status: 400 });
    if (!user.token) return Response.json({ error: "Sign in with GitHub to update connections." }, { status: 503 });
    await supabaseRest(user, `coval_connections?user_id=eq.${user.id}&target_github_login=eq.${encodeURIComponent(login)}`, { method: "DELETE" });
    return Response.json({ removed: true });
  } catch (error) { return apiError(error); }
}

import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";

export async function GET(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ connections: [], memberConnections: [] });
    const [connections, memberConnections] = await Promise.all([
      supabaseRest(user, `coval_connections?select=target_github_login,created_at&user_id=eq.${user.id}&order=created_at.desc`),
      supabaseRest(user, `coval_member_connections?select=target_user_id,created_at&user_id=eq.${user.id}&order=created_at.desc`),
    ]);
    return Response.json({ connections, memberConnections });
  } catch (error) { return apiError(error); }
}

export async function POST(request) {
  try {
    const user = await requireUser(request);
    const { login, userId } = await request.json();
    if (userId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) return Response.json({ error: "Choose a valid COVAL member." }, { status: 400 });
      if (userId === user.id) return Response.json({ error: "You are already connected to your own account." }, { status: 400 });
      const connected = await supabaseRest(user, "rpc/coval_connect_member", {
        method: "POST",
        body: JSON.stringify({ target_user_id: userId }),
      });
      return Response.json({ connected: Boolean(connected) });
    }
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login || "")) return Response.json({ error: "Enter a valid GitHub username." }, { status: 400 });
    if (user.login && login.toLowerCase() === user.login.toLowerCase()) return Response.json({ error: "You are already connected to your own account." }, { status: 400 });
    if (!user.token) return Response.json({ error: "Sign in to save connections." }, { status: 503 });
    const [member] = await supabaseRest(user, `coval_profiles?select=user_id,github_login&github_login=ilike.${encodeURIComponent(login)}&limit=1`);
    if (member?.user_id) {
      const connected = await supabaseRest(user, "rpc/coval_connect_member", {
        method: "POST",
        body: JSON.stringify({ target_user_id: member.user_id }),
      });
      await supabaseRest(user, `coval_connections?user_id=eq.${encodeURIComponent(user.id)}&target_github_login=eq.${encodeURIComponent(member.github_login)}`, { method: "DELETE" });
      return Response.json({ connected: Boolean(connected) });
    }
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
    const { login, userId } = await request.json();
    if (userId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) return Response.json({ error: "Choose a valid COVAL member." }, { status: 400 });
      const [target] = await supabaseRest(user, `coval_profiles?select=github_login&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
      await supabaseRest(user, "rpc/coval_disconnect_member", {
        method: "POST",
        body: JSON.stringify({ member_id: userId }),
      });
      if (target?.github_login) {
        await supabaseRest(user, `coval_connections?user_id=eq.${encodeURIComponent(user.id)}&target_github_login=eq.${encodeURIComponent(target.github_login)}`, { method: "DELETE" });
      }
      return Response.json({ removed: true });
    }
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login || "")) return Response.json({ error: "Enter a valid GitHub username." }, { status: 400 });
    if (!user.token) return Response.json({ error: "Sign in to update connections." }, { status: 503 });
    const [member] = await supabaseRest(user, `coval_profiles?select=user_id,github_login&github_login=ilike.${encodeURIComponent(login)}&limit=1`);
    if (member?.user_id) {
      await supabaseRest(user, "rpc/coval_disconnect_member", {
        method: "POST",
        body: JSON.stringify({ member_id: member.user_id }),
      });
    }
    await supabaseRest(user, `coval_connections?user_id=eq.${user.id}&target_github_login=eq.${encodeURIComponent(login)}`, { method: "DELETE" });
    return Response.json({ removed: true });
  } catch (error) { return apiError(error); }
}

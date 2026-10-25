import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";

export async function POST(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ updated: false });

    await supabaseRest(user, `coval_profiles?user_id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
    });
    return Response.json({ updated: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

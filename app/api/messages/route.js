import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request) {
  try {
    const user = await requireUser(request);
    const { conversationId, content } = await request.json();
    const message = String(content || "").trim();
    if (!uuidPattern.test(conversationId || "")) return Response.json({ error: "Choose a valid conversation." }, { status: 400 });
    if (!message || message.length > 4000) return Response.json({ error: "Messages must contain 1–4000 characters." }, { status: 400 });
    if (!user.token) return Response.json({ error: "Sign in to send messages." }, { status: 503 });
    const rows = await supabaseRest(user, "coval_messages", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ conversation_id: conversationId, sender_id: user.id, content: message }),
    });
    return Response.json({ message: rows?.[0] || null }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function PATCH(request) {
  try {
    const user = await requireUser(request);
    const { conversationId } = await request.json();
    if (!uuidPattern.test(conversationId || "")) return Response.json({ error: "Choose a valid conversation." }, { status: 400 });
    if (!user.token) return Response.json({ updated: false });
    await supabaseRest(user, `coval_conversation_members?user_id=eq.${user.id}&conversation_id=eq.${conversationId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_read_at: new Date().toISOString() }),
    });
    return Response.json({ updated: true });
  } catch (error) { return apiError(error); }
}

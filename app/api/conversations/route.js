import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ conversations: [], messages: [] });
    const { searchParams } = new URL(request.url);
    const conversationId = searchParams.get("conversationId");
    if (conversationId) {
      if (!uuidPattern.test(conversationId)) return Response.json({ error: "Invalid conversation ID." }, { status: 400 });
      const [conversationRows, messages, members] = await Promise.all([
        supabaseRest(user, `coval_conversations?select=id,title,kind,created_at,created_by&id=eq.${conversationId}&limit=1`),
        supabaseRest(user, `coval_messages?select=id,conversation_id,content,sender_id,created_at&conversation_id=eq.${conversationId}&order=created_at.asc&limit=500`),
        supabaseRest(user, `coval_conversation_members?select=user_id,coval_profiles(github_login,display_name,avatar_url)&conversation_id=eq.${conversationId}`),
      ]);
      if (!conversationRows?.length) return Response.json({ error: "Conversation not found." }, { status: 404 });
      return Response.json({ conversation: conversationRows[0], messages, members });
    }

    const memberships = await supabaseRest(user, `coval_conversation_members?select=conversation_id&user_id=eq.${user.id}`);
    const ids = [...new Set((memberships || []).map((row) => row.conversation_id))];
    if (!ids.length) return Response.json({ conversations: [] });
    const filter = `in.(${ids.join(",")})`;
    const conversations = await supabaseRest(user, `coval_conversations?select=id,title,kind,created_at,created_by&id=${encodeURIComponent(filter)}&order=created_at.desc`);
    const summaries = await Promise.all((conversations || []).map(async (conversation) => {
      const [members, latest] = await Promise.all([
        supabaseRest(user, `coval_conversation_members?select=user_id,coval_profiles(github_login,display_name,avatar_url)&conversation_id=eq.${conversation.id}`),
        supabaseRest(user, `coval_messages?select=content,sender_id,created_at&conversation_id=eq.${conversation.id}&order=created_at.desc&limit=1`),
      ]);
      return { ...conversation, members, latestMessage: latest?.[0] || null };
    }));
    return Response.json({ conversations: summaries });
  } catch (error) { return apiError(error); }
}

export async function POST(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ error: "Sign in to start a persistent conversation." }, { status: 503 });
    const { recipientLogin, title } = await request.json();
    if (!/^[A-Za-z0-9-]{1,39}$/.test(recipientLogin || "")) return Response.json({ error: "Choose a valid GitHub teammate." }, { status: 400 });
    const result = await supabaseRest(user, "rpc/coval_create_conversation", {
      method: "POST",
      body: JSON.stringify({ recipient_login: recipientLogin, conversation_title: String(title || "").slice(0, 120) }),
    });
    const conversationId = typeof result === "string" ? result : result?.id || result?.conversation_id;
    return Response.json({ conversationId }, { status: 201 });
  } catch (error) { return apiError(error); }
}

export async function DELETE(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ error: "Sign in to leave a conversation." }, { status: 503 });
    const { conversationId } = await request.json();
    if (!uuidPattern.test(conversationId || "")) return Response.json({ error: "Invalid conversation ID." }, { status: 400 });
    const left = await supabaseRest(user, "rpc/coval_leave_conversation", { method: "POST", body: JSON.stringify({ target_conversation_id: conversationId }) });
    return Response.json({ left: Boolean(left) });
  } catch (error) { return apiError(error); }
}

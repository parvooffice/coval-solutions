"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, PageHeading } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { apiRequest } from "../lib/client-api";

function clockTime(value) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

export default function MessagesPage({ notify, targetLogin = "" }) {
  const { people, projects, currentUser } = useDashboardData();
  const [threads, setThreads] = useState([]);
  const [messageMap, setMessageMap] = useState({});
  const [activeId, setActiveId] = useState("");
  const [activeMembers, setActiveMembers] = useState([]);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [showList, setShowList] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [newRecipient, setNewRecipient] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [pageError, setPageError] = useState("");
  const messageEndRef = useRef(null);
  const active = threads.find((thread) => thread.id === activeId) || null;
  const messages = messageMap[activeId] || [];
  const participant = people.find((person) => person.login === active?.login);
  const project = projects.find((item) => item.name === active?.name || item.id === active?.id);
  const filteredThreads = useMemo(() => threads.filter((thread) => thread.name.toLowerCase().includes(query.toLowerCase()) || thread.login?.toLowerCase().includes(query.toLowerCase())), [query, threads]);

  const loadConversation = useCallback(async (conversationId) => {
    const result = await apiRequest(`/api/conversations?conversationId=${encodeURIComponent(conversationId)}`);
    const memberRows = result.members || [];
    setActiveMembers(memberRows);
    const parsedMessages = result.messages.map((message) => {
      const member = memberRows.find((row) => row.user_id === message.sender_id)?.coval_profiles;
      const mine = message.sender_id === currentUser?.id;
      return { id: message.id, from: mine ? "You" : member?.display_name || member?.github_login || "Teammate", login: member?.github_login || "", text: message.content, time: clockTime(message.created_at), mine };
    });
    setMessageMap((current) => ({ ...current, [conversationId]: parsedMessages }));
    await apiRequest("/api/messages", { method: "PATCH", body: JSON.stringify({ conversationId }) }).catch(() => {});
    return parsedMessages;
  }, [currentUser?.id]);

  const createConversation = useCallback(async (recipientLogin) => {
    const result = await apiRequest("/api/conversations", { method: "POST", body: JSON.stringify({ recipientLogin }) });
    if (!result.conversationId) throw new Error("The conversation was not created. Apply the COVAL Supabase migration and try again.");
    const [details, list] = await Promise.all([
      apiRequest(`/api/conversations?conversationId=${encodeURIComponent(result.conversationId)}`),
      apiRequest("/api/conversations"),
    ]);
    const rows = list.conversations || [];
    setThreads(rows.map((conversation) => toThread(conversation, currentUser?.id)));
    setActiveId(result.conversationId);
    setActiveMembers(details.members || []);
    setMessageMap((current) => ({ ...current, [result.conversationId]: [] }));
    setShowNewMessage(false);
    setNewRecipient("");
    setShowList(false);
  }, [currentUser?.id]);

  useEffect(() => {
    let activeEffect = true;
    async function loadInbox() {
      setLoading(true);
      setPageError("");
      try {
        const result = await apiRequest("/api/conversations");
        if (!activeEffect) return;
        const mapped = (result.conversations || []).map((conversation) => toThread(conversation, currentUser?.id));
        setThreads(mapped);
        const requested = targetLogin ? mapped.find((thread) => thread.login?.toLowerCase() === targetLogin.toLowerCase()) : null;
        if (requested) {
          setActiveId(requested.id);
          await loadConversation(requested.id);
        } else if (targetLogin) {
          await createConversation(targetLogin);
        } else if (mapped[0]) {
          setActiveId(mapped[0].id);
          await loadConversation(mapped[0].id);
        } else setActiveId("");
      } catch (error) {
        if (activeEffect) setPageError(error.message);
      } finally {
        if (activeEffect) setLoading(false);
      }
    }
    loadInbox();
    return () => { activeEffect = false; };
  }, [targetLogin, currentUser?.id, loadConversation, createConversation]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeId, messages.length]);

  useEffect(() => {
    if (!activeId) return undefined;
    let mounted = true;
    const refreshMessages = () => { if (mounted) loadConversation(activeId).catch(() => {}); };
    const poll = window.setInterval(refreshMessages, 15000);
    const client = window.covalSupabase;
    const channel = client?.channel(`coval-messages-${activeId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "coval_messages", filter: `conversation_id=eq.${activeId}` }, refreshMessages)
      .subscribe();
    return () => {
      mounted = false;
      window.clearInterval(poll);
      if (channel) client.removeChannel(channel);
    };
  }, [activeId, loadConversation]);

  async function selectThread(id) {
    setActiveId(id);
    setShowList(false);
    setDraft("");
    setPageError("");
    try { await loadConversation(id); }
    catch (error) { setPageError(error.message); }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !activeId || sending) return;
    setSending(true);
    setPageError("");
    try {
      const result = await apiRequest("/api/messages", { method: "POST", body: JSON.stringify({ conversationId: activeId, content }) });
      const message = result.message;
      const sent = { id: message.id, from: "You", text: message.content, time: clockTime(message.created_at), mine: true };
      setMessageMap((current) => ({ ...current, [activeId]: [...(current[activeId] || []), sent] }));
      setThreads((current) => current.map((thread) => thread.id === activeId ? { ...thread, preview: `You: ${content}`, time: "Now" } : thread));
      setDraft("");
    } catch (error) { setPageError(error.message); }
    finally { setSending(false); }
  }

  async function leaveConversation() {
    if (!activeId) return;
    try {
      await apiRequest("/api/conversations", { method: "DELETE", body: JSON.stringify({ conversationId: activeId }) });
      const remaining = threads.filter((thread) => thread.id !== activeId);
      setThreads(remaining);
      setMessageMap((current) => { const next = { ...current }; delete next[activeId]; return next; });
      setActiveId(remaining[0]?.id || "");
      setMenuOpen(false);
      if (remaining[0]) await loadConversation(remaining[0].id);
      notify("You left the conversation.");
    } catch (error) { setPageError(error.message); }
  }

  const activeProfile = activeMembers.find((row) => row.user_id !== currentUser?.id)?.coval_profiles;
  const activeProjects = participant ? projects.filter((item) => item.team.includes(participant.login)) : [];

  return <>
    <PageHeading eyebrow="TEAM COMMUNICATION / MESSAGES" title="Good work happens together." description="Private conversations are stored in Supabase and restricted to conversation members." action={<button type="button" className="button button-primary" onClick={() => setShowNewMessage(true)}><Icon name="plus" size={17} /> New message</button>} />
    {pageError && <div className="backend-status-banner" role="alert"><div><strong>Messaging needs attention.</strong><p>{pageError}</p></div><button type="button" className="button" onClick={() => { setPageError(""); window.location.reload(); }}>Retry</button></div>}
    <section className={`chat-workspace surface-card${showList ? " mobile-list-open" : ""}${showDetails ? " details-open" : ""}`} aria-label="Team messages">
      <aside className="chat-sidebar"><div className="chat-sidebar-heading"><div><span className="eyebrow">INBOX</span><h2>Messages <span>{threads.length}</span></h2></div><button type="button" className="quiet-icon" aria-label="New conversation" onClick={() => setShowNewMessage(true)}><Icon name="plus" size={18} /></button></div>
        <label className="search-field chat-search"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations…" aria-label="Search conversations" /></label>
        <div className="conversation-list">{filteredThreads.map((thread) => {const person = people.find((candidate) => candidate.login === thread.login);return <button type="button" className={`conversation-item${thread.id === activeId ? " active" : ""}`} key={thread.id} onClick={() => selectThread(thread.id)} aria-current={thread.id === activeId ? "true" : undefined}><span className="conversation-avatar">{person ? <Avatar initials={person.initials} name={person.name} color={person.color} size="md" /> : <span className="thread-icon thread-mint"><Icon name="message" size={17} /></span>}</span><span className="conversation-copy"><span className="conversation-title">{thread.name}</span><span className="conversation-preview">{thread.preview}</span></span><span className="conversation-meta"><time>{thread.time}</time></span></button>;})}{!filteredThreads.length && <div className="conversation-empty">{loading ? "Loading conversations…" : "No conversations yet. Start a message with a teammate who has signed in."}</div>}</div>
        <div className="chat-sidebar-footer"><Avatar initials={currentUser?.user_metadata?.user_name?.slice(0, 2).toUpperCase() || "GH"} name={currentUser?.user_metadata?.full_name || currentUser?.email || "GitHub account"} color="mint" size="sm" /><span><b>{currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.user_name || "Sign in with GitHub"}</b><small>{currentUser?.email || "COVAL account"}</small></span></div>
      </aside>
      <section className="chat-main" aria-label={active ? `Conversation with ${active.name}` : "Conversation"}>
        {active ? <>
          <header className="chat-header"><button type="button" className="quiet-icon mobile-chat-back" aria-label="Show conversations" onClick={() => setShowList(true)}><Icon name="arrowRight" size={18} /></button><span className="chat-header-avatar">{participant ? <Avatar initials={participant.initials} name={participant.name} color={participant.color} size="md" /> : <span className="thread-icon thread-mint"><Icon name="message" size={17} /></span>}</span><div className="chat-header-copy"><h2>{active.name}</h2><span>{active.login ? `@${active.login}` : "COVAL conversation"}</span></div><button type="button" className={`quiet-icon${showDetails ? " selected" : ""}`} aria-label="Toggle conversation details" aria-expanded={showDetails} onClick={() => setShowDetails((value) => !value)}><Icon name="info" size={18} /></button><button type="button" className="quiet-icon" aria-label="Conversation options" title="Conversation options" onClick={() => setMenuOpen((value) => !value)}><Icon name="more" size={18} /></button>{menuOpen && <div className="chat-options-menu"><button type="button" onClick={leaveConversation}>Leave conversation</button></div>}</header>
          <div className="message-history" role="log" aria-live="polite" aria-relevant="additions">{messages.map((message) => <article key={message.id} className={`message-row${message.mine ? " message-mine" : ""}`}>{!message.mine && <Avatar initials={message.login?.slice(0, 2).toUpperCase() || "GH"} name={message.from} color={participant?.color || "mint"} size="xs" />}<div className="message-content"><div className="message-sender">{message.from}<time>{message.time}</time></div><p className="message-bubble">{message.text}</p></div>{message.mine && <Avatar initials={currentUser?.user_metadata?.user_name?.slice(0, 2).toUpperCase() || "ME"} name="You" color="mint" size="xs" />}</article>)}{!messages.length && <div className="message-empty"><span className="thread-icon thread-mint"><Icon name="message" size={20} /></span><strong>This conversation is ready</strong><p>Send a message to get things started.</p></div>}<div ref={messageEndRef} /></div>
          <form className="message-composer" onSubmit={sendMessage}><label className="composer-label" htmlFor="message-draft">Write a message</label><div className="composer-box"><textarea id="message-draft" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={`Message ${active.name}…`} rows={1} maxLength={4000} /><div className="composer-actions"><span>Enter to send <i>·</i> Shift + Enter for a new line</span><button type="submit" className="send-button" disabled={!draft.trim() || sending} aria-label="Send message"><Icon name="send" size={16} /></button></div></div></form>
        </> : <div className="message-empty"><span className="thread-icon thread-mint"><Icon name="message" size={20} /></span><strong>{loading ? "Loading your inbox…" : "Your inbox is ready"}</strong><p>{loading ? "Fetching saved conversations." : "Start a conversation with a teammate who has signed in to COVAL."}</p><button type="button" className="button button-primary" onClick={() => setShowNewMessage(true)}><Icon name="plus" size={16} /> New message</button></div>}
      </section>
      {active && <aside className="chat-details"><div className="details-heading"><span className="eyebrow">CONVERSATION</span><button type="button" className="quiet-icon mobile-details-close" aria-label="Close conversation details" onClick={() => setShowDetails(false)}><Icon name="x" size={18} /></button></div>{participant ? <><Avatar initials={participant.initials} name={participant.name} color={participant.color} size="xl" /><h3>{participant.name}</h3><p>@{participant.login}</p><a className="text-button" href={participant.url} target="_blank" rel="noreferrer">GitHub profile <Icon name="arrowUpRight" size={13} /></a><div className="details-divider" /><span className="eyebrow">SHARED REPOSITORIES</span><div className="shared-projects">{activeProjects.slice(0, 5).map((item) => <div key={item.id}><Icon name="repo" size={15} /><span>{item.name}</span></div>)}{!activeProjects.length && <span className="details-value">No shared public repositories</span>}</div></> : <><span className="details-project-icon thread-mint"><Icon name="message" size={20} /></span><h3>{active.name}</h3><p>{activeProfile?.github_login ? `@${activeProfile.github_login}` : "COVAL member"}</p></>}</aside>}
    </section>
    {showNewMessage && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowNewMessage(false); }}><section className="project-dialog new-message-dialog" role="dialog" aria-modal="true" aria-label="Start a new conversation"><button type="button" className="icon-button dialog-close" aria-label="Close new conversation" onClick={() => setShowNewMessage(false)}><Icon name="x" /></button><span className="eyebrow">NEW CONVERSATION</span><h2>Choose a teammate.</h2><p>Both people need a COVAL account linked to GitHub before the conversation can start.</p><label className="search-field"><span>GitHub teammate</span><select value={newRecipient} onChange={(event) => setNewRecipient(event.target.value)}><option value="">Select a person</option>{people.filter((person) => person.login !== currentUser?.user_metadata?.user_name).map((person) => <option key={person.login} value={person.login}>{person.name} (@{person.login})</option>)}</select></label><div className="project-dialog-meta"><button type="button" className="button" onClick={() => setShowNewMessage(false)}>Cancel</button><button type="button" className="button button-primary" disabled={!newRecipient} onClick={async () => { try { setPageError(""); await createConversation(newRecipient); notify("Conversation created."); } catch (error) { setPageError(error.message); } }}>Start conversation</button></div></section></div>}
  </>;
}

function toThread(conversation, currentUserId) {
  const other = (conversation.members || []).find((member) => member.user_id !== currentUserId)?.coval_profiles;
  const login = other?.github_login || "";
  const name = other?.display_name || login || conversation.title || "Conversation";
  const latest = conversation.latestMessage;
  const preview = latest ? `${latest.sender_id === currentUserId ? "You: " : ""}${latest.content}` : "Start a conversation";
  return { id: conversation.id, name, login, kind: conversation.kind, preview, time: clockTime(latest?.created_at || conversation.created_at), color: "mint" };
}

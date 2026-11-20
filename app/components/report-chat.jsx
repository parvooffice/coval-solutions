import { useEffect, useRef, useState } from "react";
import Icon from "./dashboard-icon";
import { apiRequest } from "../lib/client-api";

const SUGGESTIONS = [
  "What should I fix first?",
  "Why is my lowest score low?",
  "Which security findings matter most?",
  "What changed since my last run?",
];

// Light formatting for answers: paragraphs, "- " bullets, and `code` spans.
function Answer({ text }) {
  const blocks = text.split(/\n{2,}/);
  const inline = (line) => line.split(/(`[^`]+`)/g).map((part, index) => part.startsWith("`") && part.endsWith("`")
    ? <code key={index}>{part.slice(1, -1)}</code>
    : part.replace(/\*\*/g, ""));
  return blocks.map((block, index) => {
    const lines = block.split("\n").filter(Boolean);
    if (lines.length && lines.every((line) => /^\s*([-*•]|\d+\.)\s/.test(line))) {
      return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{inline(line.replace(/^\s*([-*•]|\d+\.)\s/, ""))}</li>)}</ul>;
    }
    return <p key={index}>{inline(lines.join(" "))}</p>;
  });
}

export default function ReportChat({ targets }) {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [targetUrl, setTargetUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, busy]);

  async function ask(text) {
    const value = text.trim();
    if (!value || busy) return;
    setError("");
    setQuestion("");
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, { role: "user", content: value }]);
    setBusy(true);
    try {
      const { answer } = await apiRequest("/api/report-chat", { method: "POST", body: JSON.stringify({ question: value, targetUrl, history }) });
      setMessages((current) => [...current, { role: "assistant", content: answer }]);
    } catch (cause) {
      setError(cause.message || "The assistant could not answer.");
      setMessages((current) => current.slice(0, -1));
      setQuestion(value);
    } finally {
      setBusy(false);
    }
  }

  return <section className="report-chat surface-card" aria-label="Ask about your scores">
    <header className="report-chat-head">
      <div><span className="eyebrow">REPORT ASSISTANT</span><h2>Ask about your scores</h2><p>Answers come only from your saved reports, so they cite real agents, files and lines.</p></div>
      <label className="report-chat-target">
        <span>Repository</span>
        <select value={targetUrl} onChange={(event) => { setTargetUrl(event.target.value); setMessages([]); }}>
          <option value="">All scored repositories</option>
          {targets.map((target) => <option key={`${target.url}-${target.name}`} value={target.url || target.input}>{target.name}</option>)}
        </select>
      </label>
    </header>
    {messages.length > 0 && <div className="report-chat-messages" ref={listRef} aria-live="polite">
      {messages.map((message, index) => <div key={index} className={`report-chat-message is-${message.role}`}>
        {message.role === "assistant" ? <Answer text={message.content} /> : <p>{message.content}</p>}
      </div>)}
      {busy && <div className="report-chat-message is-assistant is-thinking"><span /><span /><span /></div>}
    </div>}
    {!messages.length && <div className="report-chat-suggestions">
      {SUGGESTIONS.map((suggestion) => <button key={suggestion} type="button" onClick={() => ask(suggestion)} disabled={busy}>{suggestion}</button>)}
    </div>}
    {error && <p className="evaluation-run-error" role="alert">{error}</p>}
    <form className="report-chat-input" onSubmit={(event) => { event.preventDefault(); ask(question); }}>
      <input value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={1000} placeholder="e.g. How do I raise my scalability score?" aria-label="Question about your scores" disabled={busy} />
      <button type="submit" className="button button-primary" disabled={busy || !question.trim()}><Icon name="send" size={15} /> {busy ? "Thinking…" : "Ask"}</button>
      {messages.length > 0 && <button type="button" className="button button-quiet" onClick={() => { setMessages([]); setError(""); }} disabled={busy}>Clear</button>}
    </form>
  </section>;
}

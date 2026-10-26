"use client";

import { useEffect, useState } from "react";
import Icon from "./dashboard-icon";

const visibilityOptions = [
  ["contributions", "Contribution activity", "Show contribution totals and activity summary."],
  ["repositories", "Featured repositories", "Choose the repositories people see on your profile."],
  ["activity", "Recent activity", "Show recent public work on your profile."],
  ["evaluations", "Code evaluation results", "Show results you have shared with the COVAL community."],
];

function repositoryKey(repository) {
  return repository.repo || repository.url || repository.id;
}

export default function ProfileEditorDialog({ profile, repositories, onClose, onSave }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const visibility = profile.profileVisibility || {};
    setForm({
      profileName: profile.profileName || profile.name || "",
      headline: profile.headline || "",
      bio: profile.bio || "",
      location: profile.location || "",
      company: profile.company || "",
      profileVisibility: Object.fromEntries(visibilityOptions.map(([key]) => [key, visibility[key] !== false])),
      featuredRepositories: profile.featuredRepositories || repositories.map(repositoryKey),
    });
  }, [profile, repositories]);

  if (!form) return null;

  const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const toggleVisibility = (key) => setForm((current) => ({ ...current, profileVisibility: { ...current.profileVisibility, [key]: !current.profileVisibility[key] } }));
  const toggleRepository = (key) => setForm((current) => ({
    ...current,
    featuredRepositories: current.featuredRepositories.includes(key)
      ? current.featuredRepositories.filter((item) => item !== key)
      : [...current.featuredRepositories, key],
  }));

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSave(form);
      onClose();
    } catch (cause) {
      setError(cause.message || "Your profile could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="profile-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title">
      <header className="profile-editor-header"><div><span className="eyebrow">YOUR COVAL PROFILE</span><h2 id="profile-editor-title">Make it yours.</h2><p>Choose what people see when they visit your profile.</p></div><button type="button" className="icon-button" aria-label="Close profile editor" disabled={saving} onClick={onClose}><Icon name="x" size={17} /></button></header>
      <form onSubmit={submit}>
        <div className="profile-editor-fields">
          <label>Display name<input maxLength={80} value={form.profileName} onChange={(event) => setField("profileName", event.target.value)} placeholder="Your name" /></label>
          <label>Headline<input maxLength={120} value={form.headline} onChange={(event) => setField("headline", event.target.value)} placeholder="What are you building?" /></label>
          <label className="profile-editor-wide">About<textarea maxLength={500} rows={3} value={form.bio} onChange={(event) => setField("bio", event.target.value)} placeholder="A few words about your work and what you want to connect over." /></label>
          <label>Location<input maxLength={100} value={form.location} onChange={(event) => setField("location", event.target.value)} placeholder="City or region" /></label>
          <label>Organization<input maxLength={100} value={form.company} onChange={(event) => setField("company", event.target.value)} placeholder="Team or company" /></label>
        </div>
        <fieldset className="profile-editor-section"><legend>What appears on your profile</legend>{visibilityOptions.map(([key, title, description]) => <label className="profile-editor-toggle" key={key}><input type="checkbox" checked={form.profileVisibility[key]} onChange={() => toggleVisibility(key)} /><span><strong>{title}</strong><small>{description}</small></span></label>)}</fieldset>
        {form.profileVisibility.repositories && <fieldset className="profile-editor-section"><legend>Choose repositories to feature</legend>{repositories.length ? <div className="profile-repository-picker">{repositories.map((repository) => {
          const key = repositoryKey(repository);
          return <label className="profile-repository-choice" key={key}><input type="checkbox" checked={form.featuredRepositories.includes(key)} onChange={() => toggleRepository(key)} /><span><strong>{repository.name || repository.repo || "Repository"}</strong><small>{repository.description || repository.repo || "Contributed repository"}</small></span></label>;
        })}</div> : <p className="profile-muted">Connect repositories to choose which ones to feature.</p>}</fieldset>}
        <p className="profile-editor-note">Only code evaluation results you have shared with COVAL members can appear publicly.</p>
        {error && <p className="profile-editor-error" role="alert">{error}</p>}
        <footer className="profile-editor-actions"><button type="button" className="button button-quiet" disabled={saving} onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={saving}>{saving ? "Saving…" : "Save profile"}</button></footer>
      </form>
    </section>
  </div>;
}

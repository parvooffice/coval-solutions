import { useEffect, useState } from "react";
import Icon from "./dashboard-icon";
import { DEFAULT_PORTFOLIO, PORTFOLIO_ACCENTS, PORTFOLIO_SECTIONS, PORTFOLIO_STATUSES, normalizePortfolio } from "../lib/portfolio";

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
  const [form, setForm] = useState(() => {
    const visibility = profile.profileVisibility || {};
    return {
      profileName: profile.profileName || profile.name || "",
      headline: profile.headline || "",
      bio: profile.bio || "",
      location: profile.location || "",
      company: profile.company || "",
      profileVisibility: Object.fromEntries(visibilityOptions.map(([key]) => [key, visibility[key] !== false])),
      featuredRepositories: profile.featuredRepositories || repositories.map(repositoryKey),
      portfolio: normalizePortfolio(profile.portfolio || DEFAULT_PORTFOLIO),
    };
  });
  const [skillDraft, setSkillDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [bannerFile, setBannerFile] = useState(null);
  const [removeBanner, setRemoveBanner] = useState(false);
  const [bannerPreview, setBannerPreview] = useState("");

  useEffect(() => () => { if (bannerPreview.startsWith("blob:")) URL.revokeObjectURL(bannerPreview); }, [bannerPreview]);

  const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const toggleVisibility = (key) => setForm((current) => ({ ...current, profileVisibility: { ...current.profileVisibility, [key]: !current.profileVisibility[key] } }));
  const toggleRepository = (key) => setForm((current) => ({
    ...current,
    featuredRepositories: current.featuredRepositories.includes(key)
      ? current.featuredRepositories.filter((item) => item !== key)
      : [...current.featuredRepositories, key],
  }));

  const setPortfolio = (changes) => setForm((current) => ({ ...current, portfolio: { ...current.portfolio, ...changes } }));
  function addSkills(text) {
    const additions = text.split(",").map((skill) => skill.trim()).filter(Boolean);
    if (!additions.length) return;
    setPortfolio({ skills: [...new Set([...form.portfolio.skills, ...additions])].slice(0, 15) });
    setSkillDraft("");
  }
  const setLink = (index, key, value) => setPortfolio({ links: form.portfolio.links.map((link, position) => (position === index ? { ...link, [key]: value } : link)) });
  function moveSection(index, step) {
    const order = [...form.portfolio.sectionOrder];
    const target = index + step;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    setPortfolio({ sectionOrder: order });
  }

  async function submit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const pendingSkills = skillDraft.split(",").map((skill) => skill.trim()).filter(Boolean);
      const portfolio = {
        ...form.portfolio,
        skills: [...new Set([...form.portfolio.skills, ...pendingSkills])].slice(0, 15),
        links: form.portfolio.links.filter((link) => link.url.trim() || link.label.trim()),
      };
      await onSave({ ...form, portfolio }, { bannerFile, removeBanner });
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
          <div className="profile-editor-wide profile-banner-editor">
            <span className="profile-editor-label">Profile banner</span>
            <div className="profile-banner-preview" style={(bannerPreview || (!removeBanner && profile.bannerUrl)) ? { backgroundImage: `linear-gradient(90deg, rgb(9 9 11 / 40%), rgb(9 9 11 / 8%)), url("${bannerPreview || profile.bannerUrl}")` } : undefined}><span>{bannerPreview ? "PREVIEW" : profile.bannerUrl && !removeBanner ? "CURRENT BANNER" : "COVAL PROFILE"}</span></div>
            <div className="profile-banner-actions">
              <label className="button button-quiet profile-banner-upload">{bannerFile ? "Choose another image" : "Upload banner"}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const nextFile = event.target.files?.[0] || null; setBannerPreview(nextFile ? URL.createObjectURL(nextFile) : ""); setBannerFile(nextFile); setRemoveBanner(false); event.target.value = ""; }} /></label>
              {(bannerFile || profile.bannerUrl) && !removeBanner && <button type="button" className="button button-quiet" onClick={() => { setBannerFile(null); setBannerPreview(""); setRemoveBanner(true); }}>Remove banner</button>}
              {removeBanner && <button type="button" className="button button-quiet" onClick={() => setRemoveBanner(false)}>Keep current banner</button>}
              <small>PNG, JPEG, or WebP · up to 5 MB</small>
            </div>
          </div>
        </div>
        <fieldset className="profile-editor-section portfolio-editor"><legend>Portfolio style</legend>
          <div className="portfolio-row">
            <span className="profile-editor-label">Accent color</span>
            <div className="accent-swatches" role="radiogroup" aria-label="Accent color">{Object.entries(PORTFOLIO_ACCENTS).map(([key, accent]) => <button type="button" key={key} role="radio" aria-checked={form.portfolio.accent === key} aria-label={accent.label} title={accent.label} className={`accent-swatch${form.portfolio.accent === key ? " is-selected" : ""}`} style={{ "--swatch": accent.color }} onClick={() => setPortfolio({ accent: key })} />)}</div>
          </div>
          <label className="portfolio-row">Status badge<select value={form.portfolio.status} onChange={(event) => setPortfolio({ status: event.target.value })}>{Object.entries(PORTFOLIO_STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <div className="portfolio-row">
            <span className="profile-editor-label">Skills <small>{form.portfolio.skills.length}/15</small></span>
            <div className="skill-editor">
              {form.portfolio.skills.map((skill) => <span className="skill-chip" key={skill}>{skill}<button type="button" aria-label={`Remove ${skill}`} onClick={() => setPortfolio({ skills: form.portfolio.skills.filter((item) => item !== skill) })}><Icon name="x" size={11} /></button></span>)}
              {form.portfolio.skills.length < 15 && <input value={skillDraft} maxLength={120} placeholder={form.portfolio.skills.length ? "Add more…" : "React, Python, system design…"} aria-label="Add skills" onChange={(event) => { const value = event.target.value; if (value.endsWith(",")) addSkills(value); else setSkillDraft(value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSkills(skillDraft); } if (event.key === "Backspace" && !skillDraft && form.portfolio.skills.length) setPortfolio({ skills: form.portfolio.skills.slice(0, -1) }); }} onBlur={() => addSkills(skillDraft)} />}
            </div>
          </div>
          <div className="portfolio-row">
            <span className="profile-editor-label">Links <small>{form.portfolio.links.length}/5</small></span>
            <div className="link-editor">
              {form.portfolio.links.map((link, index) => <div className="link-editor-row" key={index}>
                <input value={link.label} maxLength={30} placeholder="Label (e.g. Website)" aria-label={`Link ${index + 1} label`} onChange={(event) => setLink(index, "label", event.target.value)} />
                <input value={link.url} maxLength={200} placeholder="https://" aria-label={`Link ${index + 1} address`} inputMode="url" onChange={(event) => setLink(index, "url", event.target.value)} />
                <button type="button" className="icon-button" aria-label={`Remove link ${index + 1}`} onClick={() => setPortfolio({ links: form.portfolio.links.filter((_, position) => position !== index) })}><Icon name="x" size={14} /></button>
              </div>)}
              {form.portfolio.links.length < 5 && <button type="button" className="button button-quiet" onClick={() => setPortfolio({ links: [...form.portfolio.links, { label: "", url: "" }] })}><Icon name="plus" size={14} /> Add a link</button>}
            </div>
          </div>
          <div className="portfolio-row">
            <span className="profile-editor-label">Section order</span>
            <ol className="section-order">{form.portfolio.sectionOrder.map((key, index) => <li key={key}><span>{PORTFOLIO_SECTIONS[key]}</span><button type="button" className="icon-button" aria-label={`Move ${PORTFOLIO_SECTIONS[key]} up`} disabled={index === 0} onClick={() => moveSection(index, -1)}><Icon name="chevronDown" size={14} className="icon-flip" /></button><button type="button" className="icon-button" aria-label={`Move ${PORTFOLIO_SECTIONS[key]} down`} disabled={index === form.portfolio.sectionOrder.length - 1} onClick={() => moveSection(index, 1)}><Icon name="chevronDown" size={14} /></button></li>)}</ol>
          </div>
        </fieldset>
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

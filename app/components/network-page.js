"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, PageHeading } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { apiRequest } from "../lib/client-api";

function initials(name = "COVAL member") {
  return name.trim().split(/[\s-]+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "CV";
}

function position(index, total) {
  const angle = (Math.PI * 2 * index) / Math.max(total, 1) - Math.PI / 2;
  const radius = total < 3 ? 29 : 37;
  return [50 + Math.cos(angle) * radius, 53 + Math.sin(angle) * radius];
}

export default function NetworkPage({ navigate, notify }) {
  const { currentUser, dashboard } = useDashboardData();
  const [members, setMembers] = useState([]);
  const [connections, setConnections] = useState([]);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const [directory, saved] = await Promise.all([apiRequest("/api/members"), apiRequest("/api/connections")]);
        if (!active) return;
        setMembers(directory.members || []);
        setConnections(saved.memberConnections || []);
        setError("");
      } catch (cause) {
        if (active) setError(cause.message || "Could not load your COVAL connections.");
      }
    }
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const membersById = useMemo(() => new Map(members.map((member) => [member.userId, member])), [members]);
  const connectedPeople = useMemo(() => connections.map((connection) => {
    const member = membersById.get(connection.target_user_id);
    if (!member) return null;
    const name = member.name || member.githubLogin || "COVAL member";
    return {
      id: member.githubLogin || `member-${member.userId}`,
      userId: member.userId,
      login: member.githubLogin,
      name,
      initials: initials(name),
      avatar: member.avatar,
      color: "mint",
      url: member.githubLogin ? `https://github.com/${member.githubLogin}` : "",
      isActive: member.isActive,
      showInNetwork: connection.show_in_network,
    };
  }).filter(Boolean), [connections, membersById]);
  const visiblePeople = useMemo(() => connectedPeople.filter((person) => person.showInNetwork), [connectedPeople]);
  const self = {
    id: currentUser?.id || "me",
    name: dashboard.primaryProfile?.name || currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || currentUser?.email?.split("@")[0] || "You",
    initials: initials(dashboard.primaryProfile?.name || currentUser?.user_metadata?.full_name || currentUser?.email || "You"),
    avatar: dashboard.primaryProfile?.avatar || currentUser?.user_metadata?.avatar_url || "",
    login: dashboard.primaryProfile?.login || "",
  };
  const points = useMemo(() => [[50, 53], ...visiblePeople.map((_, index) => position(index, visiblePeople.length))], [visiblePeople]);

  async function toggleTreeVisibility(person) {
    if (busyId) return;
    setBusyId(person.userId);
    setError("");
    try {
      await apiRequest("/api/connections", {
        method: "PATCH",
        body: JSON.stringify({ userId: person.userId, showInNetwork: !person.showInNetwork }),
      });
      setConnections((saved) => saved.map((connection) => connection.target_user_id === person.userId
        ? { ...connection, show_in_network: !person.showInNetwork }
        : connection));
      notify?.(person.showInNetwork ? `Removed ${person.name} from your network tree.` : `Added ${person.name} to your network tree.`);
    } catch (cause) {
      setError(cause.message || "Could not update your network tree.");
    } finally { setBusyId(""); }
  }

  return <>
    <PageHeading eyebrow="COVAL / CONNECTIONS" title="Your network" action={<button type="button" className="button button-primary" onClick={() => navigate("engineering")}><Icon name="users" size={16} /> Find people</button>} />
    {error && <div className="backend-status-banner" role="alert"><div><strong>Network update needs attention.</strong><p>{error}</p></div><button type="button" className="button" onClick={() => setError("")}>Dismiss</button></div>}
    <section className="network-canvas surface-card" aria-label="Your COVAL network tree">
      <div className="network-canvas-header"><div><span className="eyebrow">YOUR NETWORK TREE</span><h2>{visiblePeople.length ? `${visiblePeople.length} people added` : "Choose people to add"}</h2></div><span className="network-legend"><i /> Your COVAL connections</span></div>
      {currentUser ? <>
        <svg className="network-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {visiblePeople.map((person, index) => <line key={person.userId} x1={points[0][0]} y1={points[0][1]} x2={points[index + 1][0]} y2={points[index + 1][1]} />)}
        </svg>
        <div className="network-nodes">
          <button type="button" className="network-node network-node-self" style={{ left: `${points[0][0]}%`, top: `${points[0][1]}%` }} onClick={() => self.login && navigate(`profile/${self.login}`)} title="Your COVAL profile"><Avatar initials={self.initials} name={self.name} color="mint" size="md" src={self.avatar} /><span>You</span></button>
          {visiblePeople.map((person, index) => <button key={person.userId} type="button" className="network-node" style={{ left: `${points[index + 1][0]}%`, top: `${points[index + 1][1]}%` }} onClick={() => navigate(`profile/${person.id}`)} title={person.name}><Avatar initials={person.initials} name={person.name} color={person.color} size="md" src={person.avatar} online={person.isActive} /><span>{person.name.split(" ")[0]}</span></button>)}
        </div>
      </> : <div className="empty-state"><Icon name="network" size={22} /><strong>Sign in to build your network</strong><p>Your COVAL connections appear here.</p></div>}
      {!visiblePeople.length && currentUser && <p className="network-tree-empty">Select “Add to tree” beside a connection below to place them here.</p>}
    </section>

    <section className="network-connections-section surface-card">
      <div className="section-title-row"><div><span className="eyebrow">YOUR COVAL CONNECTIONS</span><h2>Choose who appears in the tree</h2></div><span className="live-count"><i /> {connectedPeople.length} CONNECTED</span></div>
      {connectedPeople.length ? <div className="network-connection-list">{connectedPeople.map((person) => <article className="network-connection-row" key={person.userId}><button type="button" className="network-connection-person" onClick={() => navigate(`profile/${person.id}`)}><Avatar initials={person.initials} name={person.name} color={person.color} size="md" src={person.avatar} online={person.isActive} /><span><strong>{person.name}</strong><small>{person.login ? `@${person.login}` : "COVAL member"}</small></span></button><button type="button" className={`button ${person.showInNetwork ? "button-connected" : "button-quiet"}`} disabled={busyId === person.userId} aria-pressed={person.showInNetwork} onClick={() => toggleTreeVisibility(person)}><Icon name={person.showInNetwork ? "check" : "plus"} size={15} />{busyId === person.userId ? "Saving…" : person.showInNetwork ? "In tree" : "Add to tree"}</button></article>)}</div> : <div className="empty-state network-no-connections"><Icon name="users" size={22} /><strong>No COVAL connections yet</strong><p>Connect with a member from People, then choose whether to add them to this tree.</p><button type="button" className="button button-quiet" onClick={() => navigate("engineering")}>Browse People</button></div>}
    </section>
  </>;
}

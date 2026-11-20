import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, PageHeading } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { apiRequest } from "../lib/client-api";
import { GROUP_MODES, buildGroups, fitView, layoutTree } from "./network-layout";

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.4;
const LIST_FILTERS = [
  { id: "all", label: "All" },
  { id: "in", label: "In tree" },
  { id: "out", label: "Not in tree" },
];

function initials(name = "COVAL member") {
  return name.trim().split(/[\s-]+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "CV";
}

const clampZoom = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

function matches(person, query) {
  if (!query) return true;
  const haystack = `${person.name} ${person.login} ${person.company} ${person.location} ${person.headline}`.toLowerCase();
  return haystack.includes(query);
}

// Local-only sample graph so the tree can be previewed in development without a Supabase session.
function samplePeople() {
  const rows = [
    ["Ava Patel", "avap", "Northwind", "Bengaluru", "Platform engineer", true],
    ["Liam Chen", "liamc", "Northwind", "Singapore", "Frontend lead", false],
    ["Noah Kim", "noahk", "Northwind", "Seoul", "SRE", true],
    ["Mia Rossi", "miar", "Lumen Labs", "Milan", "ML engineer", false],
    ["Ethan Ortiz", "ethano", "Lumen Labs", "Madrid", "Data engineer", false],
    ["Zara Ali", "zaraa", "", "Dubai", "Independent consultant", true],
    ["Kabir Rao", "kabirr", "Orbit", "Pune", "Backend engineer", false],
    ["Sofia Lind", "sofial", "Orbit", "Stockholm", "Security engineer", false],
    ["Arjun Das", "arjund", "", "", "Student", false],
  ];
  return rows.map(([name, login, company, location, headline, isActive], index) => ({
    userId: `sample-${index}`, id: login, login, name, initials: initials(name), avatar: "", company, location, headline, isActive,
    showInNetwork: index !== rows.length - 1,
  }));
}

export default function NetworkPage({ navigate, notify }) {
  const { currentUser, dashboard } = useDashboardData();
  const [members, setMembers] = useState([]);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [sample, setSample] = useState(null);
  const [groupMode, setGroupMode] = useState("company");
  const [treeQuery, setTreeQuery] = useState("");
  const [listQuery, setListQuery] = useState("");
  const [listFilter, setListFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [hoverId, setHoverId] = useState("");
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const viewportRef = useRef(null);
  const userMovedRef = useRef(false);
  const pointersRef = useRef(new Map());
  const gestureRef = useRef(null);

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
      } finally {
        if (active) setLoading(false);
      }
    }
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const membersById = useMemo(() => new Map(members.map((member) => [member.userId, member])), [members]);
  const livePeople = useMemo(() => connections.map((connection) => {
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
      company: member.company || "",
      location: member.location || "",
      headline: member.headline || "",
      isActive: member.isActive,
      showInNetwork: connection.show_in_network,
    };
  }).filter(Boolean), [connections, membersById]);

  const connectedPeople = sample || livePeople;
  const treePeople = useMemo(() => connectedPeople.filter((person) => person.showInNetwork), [connectedPeople]);
  const layout = useMemo(() => layoutTree(treePeople, groupMode), [treePeople, groupMode]);
  const groupCount = useMemo(() => buildGroups(treePeople, groupMode).length, [treePeople, groupMode]);
  const nodesById = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);
  const query = treeQuery.trim().toLowerCase();
  const onlineCount = treePeople.filter((person) => person.isActive).length;
  const self = {
    name: dashboard.primaryProfile?.name || currentUser?.displayName || currentUser?.email?.split("@")[0] || "You",
    avatar: dashboard.primaryProfile?.avatar || currentUser?.avatarUrl || "",
    login: dashboard.primaryProfile?.login || "",
  };
  const canShowTree = Boolean(currentUser || sample);

  // Path from the focused node back to "You", used to highlight a branch.
  const focusId = hoverId || selectedId;
  const highlighted = useMemo(() => {
    const ids = new Set();
    let node = nodesById.get(focusId);
    while (node) {
      ids.add(node.id);
      if (node.kind === "group" && node.id === focusId) node.group.members.forEach((person) => ids.add(person.userId));
      node = node.parentId ? nodesById.get(node.parentId) : null;
    }
    return ids;
  }, [focusId, nodesById]);

  const fit = useCallback(() => {
    if (!viewport.width || !viewport.height) return;
    userMovedRef.current = false;
    setView(fitView(layout.bounds, viewport.width, viewport.height));
  }, [layout.bounds, viewport.width, viewport.height]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [canShowTree]);

  // Re-fit when the viewport resizes (unless the member has panned or zoomed) and always when the tree's shape changes.
  const layoutKey = `${groupMode}:${treePeople.length}`;
  const fittedLayoutRef = useRef("");
  useEffect(() => {
    if (fittedLayoutRef.current !== layoutKey) userMovedRef.current = false;
    fittedLayoutRef.current = layoutKey;
    if (!userMovedRef.current) fit();
  }, [fit, layoutKey]);

  useEffect(() => {
    if (selectedId && !nodesById.has(selectedId)) setSelectedId("");
  }, [nodesById, selectedId]);

  const zoomAt = useCallback((factor, clientX, clientY) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = clientX == null ? rect.width / 2 : clientX - rect.left;
    const py = clientY == null ? rect.height / 2 : clientY - rect.top;
    userMovedRef.current = true;
    setView((current) => {
      const k = clampZoom(current.k * factor);
      const ratio = k / current.k;
      return { k, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    // Ctrl/⌘ + wheel (and trackpad pinch) zooms; a plain wheel keeps scrolling the page.
    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(Math.exp(-event.deltaY * 0.0022), event.clientX, event.clientY);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt, canShowTree]);

  function onPointerDown(event) {
    if (event.target.closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointersRef.current.values()];
    gestureRef.current = points.length >= 2
      ? { type: "pinch", distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y), view }
      : { type: "pan", x: event.clientX, y: event.clientY, view, moved: false };
  }

  function onPointerMove(event) {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.type === "pan") {
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) gesture.moved = true;
      userMovedRef.current = true;
      setView({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy });
    } else {
      const points = [...pointersRef.current.values()];
      if (points.length < 2) return;
      const rect = viewportRef.current.getBoundingClientRect();
      const cx = (points[0].x + points[1].x) / 2 - rect.left;
      const cy = (points[0].y + points[1].y) / 2 - rect.top;
      const k = clampZoom(gesture.view.k * (Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / gesture.distance));
      const ratio = k / gesture.view.k;
      userMovedRef.current = true;
      setView({ k, x: cx - (cx - gesture.view.x) * ratio, y: cy - (cy - gesture.view.y) * ratio });
    }
  }

  function onPointerUp(event) {
    const gesture = gestureRef.current;
    pointersRef.current.delete(event.pointerId);
    if (gesture?.type === "pan" && !gesture.moved) setSelectedId("");
    gestureRef.current = null;
  }

  function onCanvasKeyDown(event) {
    if (event.key === "Escape") setSelectedId("");
    if (event.key === "+" || event.key === "=") zoomAt(1.2);
    if (event.key === "-") zoomAt(1 / 1.2);
    if (event.key === "0") fit();
  }

  async function setTreeVisibility(people, showInNetwork) {
    const changes = people.filter((person) => person.showInNetwork !== showInNetwork);
    if (!changes.length || busyId) return;
    if (sample) {
      const ids = new Set(changes.map((person) => person.userId));
      setSample((current) => current.map((person) => ids.has(person.userId) ? { ...person, showInNetwork } : person));
      return;
    }
    setBusyId(changes.length === 1 ? changes[0].userId : "bulk");
    setError("");
    const saved = [];
    try {
      for (const person of changes) {
        await apiRequest("/api/connections", { method: "PATCH", body: JSON.stringify({ userId: person.userId, showInNetwork }) });
        saved.push(person.userId);
      }
      notify?.(changes.length === 1
        ? `${showInNetwork ? "Added" : "Removed"} ${changes[0].name} ${showInNetwork ? "to" : "from"} your network tree.`
        : `${showInNetwork ? "Added" : "Removed"} ${changes.length} people ${showInNetwork ? "to" : "from"} your network tree.`);
    } catch (cause) {
      setError(cause.message || "Could not update your network tree.");
    } finally {
      const ids = new Set(saved);
      setConnections((current) => current.map((connection) => ids.has(connection.target_user_id) ? { ...connection, show_in_network: showInNetwork } : connection));
      setBusyId("");
    }
  }

  const selectedNode = nodesById.get(selectedId);
  const listQueryValue = listQuery.trim().toLowerCase();
  const listedPeople = connectedPeople
    .filter((person) => listFilter === "all" || (listFilter === "in" ? person.showInNetwork : !person.showInNetwork))
    .filter((person) => matches(person, listQueryValue));
  const notInTree = connectedPeople.filter((person) => !person.showInNetwork);

  function openProfile(person) {
    if (!sample) navigate(`profile/${person.id}`);
  }

  function renderDetails() {
    if (selectedNode?.kind === "person") {
      const person = selectedNode.person;
      return <div className="nt-details">
        <div className="nt-details-person">
          <Avatar initials={person.initials} name={person.name} color="mint" size="lg" src={person.avatar} online={person.isActive} />
          <div><strong>{person.name}</strong><small>{person.login ? `@${person.login}` : "COVAL member"}</small></div>
        </div>
        {person.headline && <p className="nt-details-headline">{person.headline}</p>}
        <dl className="nt-details-facts">
          <div><dt>Status</dt><dd><span className={`nt-status ${person.isActive ? "is-online" : ""}`} />{person.isActive ? "Online now" : "Offline"}</dd></div>
          <div><dt>Company</dt><dd>{person.company || "Not shared"}</dd></div>
          <div><dt>Location</dt><dd>{person.location || "Not shared"}</dd></div>
        </dl>
        <div className="nt-details-actions">
          <button type="button" className="button button-primary" onClick={() => openProfile(person)} disabled={Boolean(sample)}><Icon name="users" size={15} /> View profile</button>
          {person.login && <button type="button" className="button button-quiet" onClick={() => navigate(`chat/${person.login}`)} disabled={Boolean(sample)}><Icon name="message" size={15} /> Message</button>}
          <button type="button" className="button button-quiet" onClick={() => setTreeVisibility([person], false)} disabled={Boolean(busyId)}><Icon name="x" size={15} /> Remove from tree</button>
        </div>
      </div>;
    }
    if (selectedNode?.kind === "group") {
      const { group } = selectedNode;
      return <div className="nt-details">
        <div className="nt-details-group"><span className={`nt-swatch nt-color-${selectedNode.colorIndex}`} /><div><strong>{group.label}</strong><small>{group.members.length} {group.members.length === 1 ? "person" : "people"} · grouped by {groupMode}</small></div></div>
        <ul className="nt-details-members">
          {group.members.map((person) => <li key={person.userId}><button type="button" onClick={() => setSelectedId(person.userId)}><Avatar initials={person.initials} name={person.name} color="mint" size="sm" src={person.avatar} online={person.isActive} /><span>{person.name}</span><Icon name="chevronRight" size={14} /></button></li>)}
        </ul>
      </div>;
    }
    return <div className="nt-details">
      <span className="eyebrow">TREE SUMMARY</span>
      <div className="nt-stats">
        <div><strong>{treePeople.length}</strong><small>In tree</small></div>
        <div><strong>{onlineCount}</strong><small>Online</small></div>
        <div><strong>{groupCount > 1 ? groupCount : "—"}</strong><small>{groupMode === "none" ? "Groups" : `${GROUP_MODES.find((mode) => mode.id === groupMode).label} groups`}</small></div>
      </div>
      <p className="nt-details-hint">Select a person or a branch to see details. Drag to pan, use the zoom buttons or Ctrl + scroll to zoom.</p>
      {notInTree.length > 0 && <button type="button" className="button button-quiet" onClick={() => setTreeVisibility(notInTree, true)} disabled={Boolean(busyId)}><Icon name="plus" size={15} /> Add all {notInTree.length} remaining {notInTree.length === 1 ? "connection" : "connections"}</button>}
    </div>;
  }

  return <>
    <PageHeading
      eyebrow="COVAL / CONNECTIONS"
      title="Your network"
      description="See how your COVAL connections branch out by company or location, and choose who appears in your tree."
      action={<button type="button" className="button button-primary" onClick={() => navigate("engineering")}><Icon name="users" size={16} /> Find people</button>}
    />
    {error && <div className="backend-status-banner" role="alert"><div><strong>Network update needs attention.</strong><p>{error}</p></div><button type="button" className="button" onClick={() => setError("")}>Dismiss</button></div>}
    {sample && <div className="nt-sample-banner" role="status"><Icon name="info" size={15} /><span><strong>Sample network.</strong> Development preview only — changes are not saved.</span><button type="button" className="button button-quiet" onClick={() => { setSample(null); setSelectedId(""); }}>Exit preview</button></div>}

    <section className="nt-workspace surface-card" aria-label="Your COVAL network tree">
      <div className="nt-toolbar">
        <div className="nt-title"><span className="eyebrow">NETWORK TREE</span><h2>{treePeople.length ? `${treePeople.length} ${treePeople.length === 1 ? "person" : "people"} in your tree` : "Your tree is empty"}</h2></div>
        <div className="nt-controls">
          <label className="nt-search"><Icon name="search" size={14} /><input type="search" value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="Find in tree" aria-label="Find a person in your tree" /></label>
          <div className="nt-segmented" role="radiogroup" aria-label="Group branches by">
            {GROUP_MODES.map((mode) => <button key={mode.id} type="button" role="radio" aria-checked={groupMode === mode.id} className={groupMode === mode.id ? "is-active" : ""} onClick={() => setGroupMode(mode.id)}>{mode.label}</button>)}
          </div>
        </div>
      </div>

      <div className="nt-body">
        {canShowTree ? <div
          ref={viewportRef}
          className="nt-viewport"
          tabIndex={0}
          role="group"
          aria-label="Network tree canvas. Use plus and minus to zoom, 0 to fit."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onCanvasKeyDown}
        >
          <div className="nt-stage" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            <svg className="nt-links" width="1" height="1" aria-hidden="true">
              {layout.links.map((link) => {
                const target = nodesById.get(link.to);
                const dimmed = (focusId && !highlighted.has(link.to)) || (query && target?.kind === "person" && !matches(target.person, query));
                const active = focusId && highlighted.has(link.to) && highlighted.has(link.from);
                return <path key={link.id} d={link.d} className={`nt-link ${link.colorIndex != null ? `nt-stroke-${link.colorIndex}` : ""} ${active ? "is-active" : ""} ${dimmed ? "is-dimmed" : ""}`} />;
              })}
            </svg>
            {layout.nodes.map((node) => {
              if (node.kind === "self") {
                return <button key="self" type="button" className="nt-node nt-node-self" style={{ left: 0, top: 0 }} onClick={() => self.login && !sample ? navigate(`profile/${self.login}`) : setSelectedId("")} title="Your COVAL profile">
                  <Avatar initials={initials(self.name)} name={self.name} color="mint" size="lg" src={self.avatar} />
                  <span className="nt-label">You</span>
                </button>;
              }
              if (node.kind === "group") {
                const dimmed = focusId && !highlighted.has(node.id);
                return <button key={node.id} type="button" className={`nt-node nt-node-group nt-color-${node.colorIndex} ${selectedId === node.id ? "is-selected" : ""} ${dimmed ? "is-dimmed" : ""}`} style={{ left: node.x, top: node.y }} onClick={() => setSelectedId(node.id)} onMouseEnter={() => setHoverId(node.id)} onMouseLeave={() => setHoverId("")} onFocus={() => setHoverId(node.id)} onBlur={() => setHoverId("")} aria-pressed={selectedId === node.id}>
                  <span className="nt-swatch" /><span className="nt-group-label">{node.group.label}</span><b>{node.group.members.length}</b>
                </button>;
              }
              const { person } = node;
              const dimmed = (query && !matches(person, query)) || (focusId && !highlighted.has(node.id));
              const hit = query && matches(person, query);
              return <button key={node.id} type="button" className={`nt-node nt-node-person ${node.colorIndex != null ? `nt-color-${node.colorIndex}` : ""} ${selectedId === node.id ? "is-selected" : ""} ${dimmed ? "is-dimmed" : ""} ${hit ? "is-match" : ""}`} style={{ left: node.x, top: node.y }} onClick={() => setSelectedId(node.id)} onDoubleClick={() => openProfile(person)} onMouseEnter={() => setHoverId(node.id)} onMouseLeave={() => setHoverId("")} onFocus={() => setHoverId(node.id)} onBlur={() => setHoverId("")} aria-pressed={selectedId === node.id} title={`${person.name}${person.login ? ` (@${person.login})` : ""}`}>
                <Avatar initials={person.initials} name={person.name} color="mint" size="md" src={person.avatar} online={person.isActive} />
                <span className="nt-label">{person.name.split(" ")[0]}</span>
              </button>;
            })}
          </div>

          {!treePeople.length && <div className="nt-empty-overlay"><Icon name="network" size={20} /><strong>{loading ? "Loading your network…" : connectedPeople.length ? "Add connections to grow your tree" : "No connections yet"}</strong><p>{connectedPeople.length ? "Use “Add to tree” in the list below, or add everyone at once." : "Connect with members from People, then place them here."}</p>{!loading && connectedPeople.length > 0 && <button type="button" className="button button-primary" onClick={() => setTreeVisibility(notInTree, true)} disabled={Boolean(busyId)}><Icon name="plus" size={15} /> Add all {notInTree.length}</button>}</div>}

          <div className="nt-zoom" aria-label="Zoom controls">
            <button type="button" onClick={() => zoomAt(1.2)} aria-label="Zoom in" title="Zoom in (+)"><Icon name="zoomIn" size={15} /></button>
            <button type="button" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out" title="Zoom out (−)"><Icon name="zoomOut" size={15} /></button>
            <button type="button" onClick={fit} aria-label="Fit tree to view" title="Fit to view (0)"><Icon name="expand" size={15} /></button>
            <span className="nt-zoom-level">{Math.round(view.k * 100)}%</span>
          </div>
        </div> : <div className="nt-viewport nt-viewport-empty"><div className="empty-state"><Icon name="network" size={22} /><strong>Sign in to build your network</strong><p>Your COVAL connections appear here.</p>{import.meta.env.DEV && <button type="button" className="button button-quiet" onClick={() => setSample(samplePeople())}>Preview with sample data</button>}</div></div>}

        <aside className="nt-panel" aria-live="polite">
          {selectedNode && <button type="button" className="nt-panel-back" onClick={() => setSelectedId("")}><Icon name="arrowRight" size={13} /> Back to summary</button>}
          {renderDetails()}
        </aside>
      </div>
    </section>

    <section className="nt-manager surface-card" aria-label="Manage who appears in your tree">
      <div className="nt-manager-head">
        <div><span className="eyebrow">YOUR COVAL CONNECTIONS</span><h2>Choose who appears in the tree</h2></div>
        <span className="live-count"><i /> {connectedPeople.length} CONNECTED</span>
      </div>
      {connectedPeople.length > 0 && <div className="nt-manager-tools">
        <label className="nt-search"><Icon name="search" size={14} /><input type="search" value={listQuery} onChange={(event) => setListQuery(event.target.value)} placeholder="Search connections" aria-label="Search your connections" /></label>
        <div className="nt-segmented" role="radiogroup" aria-label="Filter connections">
          {LIST_FILTERS.map((filter) => <button key={filter.id} type="button" role="radio" aria-checked={listFilter === filter.id} className={listFilter === filter.id ? "is-active" : ""} onClick={() => setListFilter(filter.id)}>{filter.label}</button>)}
        </div>
        <div className="nt-bulk">
          <button type="button" className="button button-quiet" onClick={() => setTreeVisibility(listedPeople, true)} disabled={Boolean(busyId) || !listedPeople.some((person) => !person.showInNetwork)}><Icon name="plus" size={14} /> Add shown</button>
          <button type="button" className="button button-quiet" onClick={() => setTreeVisibility(listedPeople, false)} disabled={Boolean(busyId) || !listedPeople.some((person) => person.showInNetwork)}><Icon name="x" size={14} /> Remove shown</button>
        </div>
      </div>}
      {connectedPeople.length ? (listedPeople.length ? <ul className="nt-connection-list">{listedPeople.map((person) => <li key={person.userId} className={selectedId === person.userId ? "is-selected" : ""}>
        <button type="button" className="nt-connection-person" onClick={() => person.showInNetwork ? setSelectedId(person.userId) : openProfile(person)}>
          <Avatar initials={person.initials} name={person.name} color="mint" size="md" src={person.avatar} online={person.isActive} />
          <span><strong>{person.name}</strong><small>{[person.login ? `@${person.login}` : "COVAL member", person.company, person.location].filter(Boolean).join(" · ")}</small></span>
        </button>
        <button type="button" className={`button ${person.showInNetwork ? "button-connected" : "button-quiet"}`} disabled={Boolean(busyId)} aria-pressed={person.showInNetwork} onClick={() => setTreeVisibility([person], !person.showInNetwork)}>
          <Icon name={person.showInNetwork ? "check" : "plus"} size={15} />{busyId === person.userId ? "Saving…" : person.showInNetwork ? "In tree" : "Add to tree"}
        </button>
      </li>)}</ul> : <p className="nt-no-results">No connections match “{listQuery}”.</p>)
        : <div className="empty-state nt-no-connections"><Icon name="users" size={22} /><strong>{loading ? "Loading connections…" : "No COVAL connections yet"}</strong><p>Connect with a member from People, then choose whether to add them to this tree.</p><button type="button" className="button button-quiet" onClick={() => navigate("engineering")}>Browse People</button></div>}
    </section>
  </>;
}

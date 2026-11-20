// Pure layout helpers for the network tree. Coordinates are in stage pixels with "You" at (0, 0).

export const GROUP_MODES = [
  { id: "company", label: "Company" },
  { id: "location", label: "Location" },
  { id: "none", label: "None" },
];

const GROUP_FALLBACK = { company: "Independent", location: "Location not shared" };
const LEAF_SPACING = 84;
const TAU = Math.PI * 2;
const START_ANGLE = -Math.PI / 2;

const polar = (angle, radius) => [Math.cos(angle) * radius, Math.sin(angle) * radius];

export function groupKey(person, mode) {
  if (mode === "none") return "";
  const value = String(person[mode] || "").trim();
  return value || GROUP_FALLBACK[mode];
}

export function buildGroups(people, mode) {
  if (mode === "none") return [];
  const groups = new Map();
  for (const person of people) {
    const key = groupKey(person, mode);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(person);
  }
  return [...groups.entries()]
    .map(([label, members]) => ({ id: `group:${label}`, label, members: [...members].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
}

// Curved link from a parent to a child, bending along the child's direction so branches fan out cleanly.
function linkPath(from, to, bendRadius) {
  if (!bendRadius) return `M${from[0]},${from[1]} L${to[0]},${to[1]}`;
  const angle = Math.atan2(to[1], to[0]);
  const [cx, cy] = polar(angle, bendRadius);
  return `M${from[0]},${from[1]} Q${cx},${cy} ${to[0]},${to[1]}`;
}

/**
 * Returns { nodes, links, bounds } for a radial tree:
 * root ("You") → optional group branches → people.
 */
export function layoutTree(people, mode) {
  const root = { id: "self", kind: "self", x: 0, y: 0 };
  const nodes = [root];
  const links = [];
  const count = people.length;
  if (!count) return { nodes, links, bounds: { minX: -120, maxX: 120, minY: -120, maxY: 120 } };

  // A single branch adds no information, so it collapses into a flat ring.
  const allGroups = buildGroups(people, mode);
  const groups = allGroups.length > 1 ? allGroups : [];
  // Dense trees stagger alternate leaves onto a second ring so labels do not collide.
  const stagger = count > 18;
  const ringFactor = stagger ? 1.85 : 1;

  if (!groups.length) {
    // An even slot count keeps inner/outer rings alternating all the way around when staggered.
    const slots = stagger && count % 2 ? count + 1 : count;
    const radius = Math.max(150, (slots * LEAF_SPACING) / TAU / ringFactor);
    [...people].sort((a, b) => a.name.localeCompare(b.name)).forEach((person, index) => {
      const angle = START_ANGLE + (TAU * index) / slots;
      const r = stagger && index % 2 ? radius + 78 : radius;
      const [x, y] = polar(angle, r);
      nodes.push({ id: person.userId, kind: "person", person, x, y, angle, parentId: root.id });
      links.push({ id: `self-${person.userId}`, from: root.id, to: person.userId, d: linkPath([0, 0], [x, y]) });
    });
  } else {
    const padding = 0.8;
    const slots = count + padding * groups.length;
    const groupRadius = Math.max(120, Math.min(220, 70 + groups.length * 16));
    const leafRadius = Math.max(groupRadius + 120, (slots * LEAF_SPACING) / TAU / ringFactor);
    let cursor = START_ANGLE - (TAU * (groups[0].members.length + padding)) / slots / 2;
    let leafIndex = 0;
    for (const [groupIndex, group] of groups.entries()) {
      const sector = (TAU * (group.members.length + padding)) / slots;
      const usable = sector - (TAU * padding) / slots;
      const center = cursor + sector / 2;
      const [gx, gy] = polar(center, groupRadius);
      nodes.push({ id: group.id, kind: "group", group, x: gx, y: gy, angle: center, colorIndex: groupIndex % 6, parentId: root.id });
      links.push({ id: `self-${group.id}`, from: root.id, to: group.id, d: linkPath([0, 0], [gx, gy]), colorIndex: groupIndex % 6 });
      group.members.forEach((person, index) => {
        const angle = center - usable / 2 + (usable * (index + 0.5)) / group.members.length;
        const r = stagger && leafIndex % 2 ? leafRadius + 78 : leafRadius;
        leafIndex += 1;
        const [x, y] = polar(angle, r);
        nodes.push({ id: person.userId, kind: "person", person, x, y, angle, colorIndex: groupIndex % 6, parentId: group.id });
        links.push({ id: `${group.id}-${person.userId}`, from: group.id, to: person.userId, d: linkPath([gx, gy], [x, y], (groupRadius + r) / 2), colorIndex: groupIndex % 6 });
      });
      cursor += sector;
    }
  }

  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  return {
    nodes,
    links,
    bounds: { minX: Math.min(...xs) - 70, maxX: Math.max(...xs) + 70, minY: Math.min(...ys) - 60, maxY: Math.max(...ys) + 80 },
  };
}

// Scale and offset that fit the bounds inside a viewport of the given size.
export function fitView(bounds, width, height, maxScale = 1.25) {
  const boundsWidth = bounds.maxX - bounds.minX;
  const boundsHeight = bounds.maxY - bounds.minY;
  const k = Math.max(0.25, Math.min(maxScale, (width - 32) / boundsWidth, (height - 32) / boundsHeight));
  return {
    k,
    x: width / 2 - ((bounds.minX + bounds.maxX) / 2) * k,
    y: height / 2 - ((bounds.minY + bounds.maxY) / 2) * k,
  };
}

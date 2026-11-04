// "Inside your top …": the listening mix's items opened up, as rings around a middle circle. Artists, then their
// albums, then their songs (albums: their songs; genres: their artists, their albums, then their songs; tracks: just
// the tracks), each slice as wide as its hours, with "Everyone else" (the rest of the period, opening into the view's
// other items) last when its toggle is on. At most TIERS rings show at once: going in moves each level in a ring and
// brings the next one in at the edge. Slices show their share of the middle circle where it fits, the name where both fit, and once
// gone in, their share of everything (of the items the mix bar shows, so the two agree) small below; the middle
// shows only that. Clicking a slice goes in: it opens out into the middle circle and its insides fill the rings;
// clicking the middle circle goes back out, and clicking a song opens it in Tracks, pinned (in Tracks, pins it).
// A slice with nothing drawn outside it reaches out to the edge, marked as tune.sunTeeth says. A slice under
// tune.sunMinShare of the middle folds into its parent's "Other …", so going in brings out what was too small
// before (out of that slice). Every move (going in or out, a new period, items coming and going) is one morph of
// every slice from where it is on screen, the shares counting along with it.
// Drawn by hand in SVG rather than with ECharts' sunburst, which drops slices without animating them. Colors follow
// the item (the chart's palette slots); a slice under an item takes its color, lighter the deeper it lies. Hovering
// lights the item everywhere on the page, pins show as in every graph (litLook), and the hidden ones are left out.

import { $, state, noun, shownPlays, putOff, hooks, OTHER, otherLabel } from "./state.js";
import { tune } from "./tune.js";
import { focusArtist } from "./charts.js";
import { ENTER_MS, MORPH_MS, dur, easeInOut, easeOut, litLook } from "./motion.js";
import { fmtHours } from "./format.js";
import { HOUR } from "./aggregate.js";

const SVGNS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const SEP = "\u0000"; // between the names in a node's id, its path from the root
const REST = SEP + "\u0001"; // after a parent's id, its "Other …"
const MAX_SIZE = 560; // px, the circle's widest
const HOLE = 0.22; // the middle circle's radius, as a share of the whole
const GAP = 1; // px of surface on each side of a slice
const PAD = 4; // px a label keeps from its slice's edges
const TIERS = 3; // the most rings shown at once

// What each view's items open into: how to name a play at each level below the item, what the "Other …" slice that
// holds the level's smallest is called, and what kind of thing the level is (a song opens in Tracks)
const LEVELS = {
  artist: [[(p) => p.album || "Unknown album", "Other albums", "album"], [(p) => p.track, "Other songs", "track"]],
  album: [[(p) => p.track, "Other songs", "track"]],
  genre: [[(p) => p.by, "Other artists", "artist"], [(p) => p.album || "Unknown album", "Other albums", "album"], [(p) => p.trackKey, "Other songs", "track"]],
  track: [],
};
// A genre's song is called as Tracks calls it, with its artist after it where another artist has one of that name
const untag = (key, by) => (by != null && key.endsWith(" · " + by) ? key.slice(0, -by.length - 3) : key);
// What a node at each level stands for, whatever view it's in ({ genre, artist, album }), so a tab change can keep
// the same thing in the middle: means(name, the parent's meaning) per level below the root
const MEANS = {
  artist: [(n) => ({ artist: n }), (n, up) => ({ ...up, album: n }), (n, up) => ({ ...up, track: n })],
  album: [(n) => ({ artist: state.owner?.get(n), album: state.titles?.get(n) ?? n }), (n, up) => ({ ...up, track: n })],
  genre: [(n) => ({ genre: n }), (n, up) => ({ ...up, artist: n }), (n, up) => ({ ...up, album: n }), (n, up) => ({ ...up, track: untag(n, up.artist) })],
  track: [(n) => ({ artist: state.owner?.get(n), track: state.titles?.get(n) ?? n })],
};
const NOTES = {
  artist: "Each artist's albums, then their songs",
  album: "Each album's songs",
  genre: "Each genre's artists, their albums, then their songs",
  track: "Your top tracks",
};

const fmtShare = (s) => (s >= 0.005 ? Math.round(s * 100) + "%" : "<1%");

let svg, layers, tip;
const nodes = new Map(); // id -> node, as on screen (including those leaving)
let root = null; // the whole tree
let focusId = ""; // the node in the middle circle, by id ("" is the root)
// What the reader last opened stands for (see MEANS). A tab change opens the same thing in the new view; until it's
// there (genres still arriving, or it isn't among the view's top items), the middle waits at the root and each paint
// looks again, until the reader opens something else
let focusMeans = {};
let lastDim = null;
let seeking = false;
let total = 0;
let pins = null;
let hoveredItem = null; // lit from anywhere on the page
let hoverNode = null; // the slice under the pointer here, if any
let raf = 0;
let fonts = null;

const make = (tag, cls) => {
  const el = document.createElementNS(SVGNS, tag);
  if (cls) el.setAttribute("class", cls);
  return el;
};

function setup() {
  const el = $("sunburst");
  svg = make("svg", "sun-svg");
  layers = { slices: make("g"), outlines: make("g"), labels: make("g") };
  svg.append(layers.slices, layers.outlines, layers.labels);
  tip = document.createElement("div");
  tip.className = "sun-tip";
  el.append(svg, tip);
  // A slice's node is found from the element under the pointer
  svg.addEventListener("pointermove", (ev) => pointAt(ev.target.__node ?? null, ev));
  svg.addEventListener("pointerleave", () => pointAt(null));
  svg.addEventListener("click", (ev) => {
    const n = ev.target.__node;
    if (!n) return;
    if (n.id === focusId) {
      if (n.parent) zoomTo(n.parent.id);
    } else if (n.kids.length) zoomTo(n.id);
    else if (opens(n)) hooks.openPart(itemOf(n), "track", n.name);
    else if (pinnable(n)) {
      pins?.toggle(pinName(n));
      tip.__node = null;
    }
  });
  // (out to the card, the card's size matters too: its row of sliders, say)
  const resized = new ResizeObserver(() => {
    edge = null;
    if (!raf) draw();
  });
  resized.observe(el);
  resized.observe($("sunburst-card"));
}

// ---------- the tree ----------

// The period's plays of the shown items, as a tree: the root, the items (in the mix bar's order, Everyone else last),
// and below each the levels its view opens into, every node with its hours, and x0..x1 its place around the circle
// (0..1). Everything is in it; `fold` picks what's drawn.
function build(plays, items, withOther) {
  const levels = LEVELS[state.dim].map((l) => l[0]);
  const below = [(p) => p.artist, ...levels]; // Everyone else's: the view's other items, then their insides
  const want = new Set(items);
  const top = new Map(items.map((a) => [a, new Map()]));
  if (withOther) top.set(OTHER, new Map());
  for (const p of plays) {
    const mine = want.has(p.artist);
    if (!mine && !withOther) continue;
    const keys = mine ? levels : below;
    // (a track has nothing below it: just its hours)
    if (!keys.length) {
      const v = top.get(p.artist);
      top.set(p.artist, (typeof v === "number" ? v : 0) + p.ms / HOUR);
      continue;
    }
    let m = top.get(mine ? p.artist : OTHER);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i](p);
      if (i === keys.length - 1) m.set(k, (m.get(k) ?? 0) + p.ms / HOUR);
      else {
        if (!m.has(k)) m.set(k, new Map());
        m = m.get(k);
      }
    }
  }
  const titles = state.titles;
  const sum = (x) => (typeof x === "number" ? x : [...x.values()].reduce((a, y) => a + sum(y), 0));
  // level: 0 for one of the view's items, 1.. for the levels below it (Everyone else's are one further out)
  const node = (parent, name, x, depth, item, inOther) => {
    const id = parent ? (parent.id ? parent.id + SEP : "") + name : "";
    const level = depth - 1 - (inOther ? 1 : 0);
    const means = depth === 0 ? {} : MEANS[state.dim][level]?.(name, parent.means) ?? parent.means;
    const kind = level >= 1 ? LEVELS[state.dim][level - 1]?.[2] : null;
    const shown = depth === 1 && inOther ? otherLabel() : level === 0 && titles ? titles.get(name) ?? name : kind === "track" ? means.track ?? name : name;
    const n = { id, name, shown, parent, depth, item, level, inOther, means, value: sum(x), kids: [] };
    if (typeof x === "number" || !x.size) return n;
    const kids = [...x].map(([k, y]) => [k, y, sum(y)]).filter((k) => k[2] > 0);
    if (depth > 0) kids.sort((a, b) => b[2] - a[2]); // the items keep the mix bar's order
    n.kids = kids.map(([k, y]) => node(n, k, y, depth + 1, item ?? k, inOther || (depth === 0 && k === OTHER)));
    return n;
  };
  const r = node(null, "", top, 0, null, false);
  // Places around the circle
  const place = (n, x0) => {
    n.x0 = x0;
    n.x1 = x0 + (r.value ? n.value / r.value : 0);
    let x = x0;
    for (const k of n.kids) x = place(k, x);
    return n.x1;
  };
  place(r, 0);
  r.x1 = 1;
  return r;
}

// What's drawn with f in the middle: in f, the slices of at least tune.sunMinShare of f; in what f lies in, as when
// that was in the middle (and f's way down); elsewhere (closed up at the top, but on their way there or back), that
// share of everything. The rest of a parent's (its smallest, so the end of its span) fold into one "Other …"; the
// items themselves never do.
function fold(f) {
  const min = tune.sunMinShare / 100;
  const path = new Map(); // what f lies in -> the one of its kids on the way to f
  for (let p = f; p.parent; p = p.parent) path.set(p.parent, p);
  const inside = (n) => {
    for (let p = n; p; p = p.parent) if (p === f) return true;
    return false;
  };
  const copy = (n, parent) => {
    const c = { ...n, parent, kids: [] };
    const floor = (path.has(n) ? n.value : inside(n) ? f.value : root.value) * min;
    let i = n.depth ? n.kids.findIndex((k) => k.value < floor) : -1;
    if (i >= 0 && path.has(n)) i = Math.max(i, n.kids.indexOf(path.get(n)) + 1);
    if (i < 0 || i >= n.kids.length - 1) i = n.kids.length; // (one alone is shown as itself)
    c.kids = n.kids.slice(0, i).map((k) => copy(k, c));
    const rest = n.kids.slice(i);
    if (rest.length) {
      const name = n.level < 0 ? `Other ${noun().many}` : LEVELS[state.dim][n.level][1];
      c.kids.push({
        id: n.id + REST, name, shown: name, parent: c, depth: n.depth + 1, item: n.item, level: n.level + 1,
        inOther: n.inOther, means: n.means, other: true, value: rest.reduce((a, k) => a + k.value, 0),
        x0: rest[0].x0, x1: n.x1, kids: [],
      });
    }
    return c;
  };
  return copy(root, null);
}

// What a node's level is ("album", "track"…), the view's item it lies in, and whether clicking it opens it elsewhere
const kindOf = (n) => (n.level >= 1 ? LEVELS[state.dim][n.level - 1]?.[2] ?? null : null); // (none for a slice of the view just left)
const itemOf = (n) => {
  for (let p = n; p; p = p.parent) if (p.level === 0) return p.name;
  return null;
};
const opens = (n) => !n.other && !n.kids.length && kindOf(n) === "track";
// In Tracks, a track itself (or one of Everyone else's), which a click pins
const pinnable = (n) => state.dim === "track" && !n.other && !n.kids.length && n.level === 0;
const pinName = (n) => (n.inOther ? n.name : n.item);

const eachNode = (n, fn) => {
  fn(n);
  for (const k of n.kids) eachNode(k, fn);
};

// ---------- layout ----------

// Where every node sits with `f` in the middle: its angles a0..a1 (from 12 o'clock, clockwise) and radii r0..r1
// (shares of the whole radius). f fills the middle circle and the levels below it share the rings; whatever lies
// outside f closes up to nothing at the top, whatever lies inside the circle (f's ancestors) shrinks to the middle, and
// whatever lies past the rings waits at the edge. A slice with nothing drawn outside it (tune.sunTeeth) reaches out
// to the edge too: rn is where its own ring ends, and step how deep a ring is, to mark the rings it crosses.
function layout(n, f, rings) {
  const span = f.x1 - f.x0 || 1;
  const ang = (x) => Math.min(1, Math.max(0, (x - f.x0) / span)) * TAU;
  const step = (1 - HOLE) / rings;
  let r0, r1;
  if (n.depth < f.depth) r0 = r1 = 0;
  else if (n.depth === f.depth) [r0, r1] = [0, HOLE];
  else if (n.depth - f.depth > rings) r0 = r1 = 1; // (the levels past the rings, until they're gone into)
  else {
    r0 = HOLE + (n.depth - f.depth - 1) * step;
    r1 = r0 + step;
  }
  const rn = r1;
  if (tune.sunTeeth && n.depth > f.depth && !n.kids.length) r1 = 1;
  return { a0: ang(n.x0), a1: ang(n.x1), r0, r1, rn, step };
}

// What a slice stands for in any view but Genres, which adds a genre to the same artists and albums: the key a slice
// keeps through a tab change. None for a genre itself, or an "Other …" slice
const meaningOf = (n) => {
  const m = n.means;
  return !n.other && m?.artist != null ? [m.artist, m.album ?? "", m.track ?? ""].join(SEP) : null;
};

// Every node's place now, and where it's going: nodes new to the tree grow from nothing where they'll sit (or, coming
// out of their parent's "Other …", from its start, so they open it up; or from their new parent's start), and those
// leaving it close up into the place of the next one that stays (or their parent's end), which folds them into it.
// swap: the view changed, so the slices of the old view's tree that stand for the same thing as one of the new
// view's (an artist's album and that album in Albums, the same song in both) become that slice: it moves to its new
// place and takes its new color on the same morph, rather than one shrinking away while the other grows
function retarget(first, swap = false) {
  const was = new Map();
  if (swap) for (const n of nodes.values()) {
    const k = !n.leaving && meaningOf(n);
    if (k && !was.has(k)) was.set(k, n);
  }
  // The node in the middle, or the nearest of its parents still in the tree
  let f = null;
  for (let id = focusId; !f; id = id.includes(SEP) ? id.slice(0, id.lastIndexOf(SEP)) : "") f = id ? find(id) : root;
  focusId = f.id;
  // (the rings are shared out over the levels below the middle, up to TIERS, the same number whatever the item: one
  // with no albums still leaves room for them; Everyone else has one more level)
  const rings = Math.min(TIERS, LEVELS[state.dim].length + 1 - f.depth + (f.inOther ? 1 : 0));
  ring.to = 1 - (1 - HOLE) / rings;
  ring.from = first || ring.now == null ? ring.to : ring.now;
  const seen = new Set(), born = new Set();
  eachNode(fold(f), (n) => {
    seen.add(n.id);
    const to = layout(n, f, rings);
    const share = { p: f.value ? n.value / f.value : 0, s: total ? n.value / total : 0 };
    let kept = nodes.get(n.id);
    const k = swap && !kept && meaningOf(n);
    if (k && was.has(k)) {
      kept = was.get(k);
      was.delete(k);
      nodes.delete(kept.id);
      nodes.set(n.id, kept);
    }
    if (kept) {
      Object.assign(kept, { ...n, kids: n.kids, from: { ...kept.cur }, to, leaving: false, was: { ...kept.share }, will: share });
      kept.kids = n.kids.map((k) => k.id);
    } else {
      const up = n.parent && nodes.get(n.parent.id), rest = n.parent && nodes.get(n.parent.id + REST);
      let grow;
      if (first) grow = { ...to, r1: to.r0 };
      else if (up && born.has(up.id)) grow = { a0: up.from.a0, a1: up.from.a0, r0: up.from.r1, r1: up.from.r1 };
      else if (rest && !n.other) grow = { ...rest.cur, a1: rest.cur.a0 };
      else grow = { ...to, a1: to.a0 };
      born.add(n.id);
      nodes.set(n.id, { ...n, kids: n.kids.map((k) => k.id), from: grow, cur: { ...grow }, to, leaving: false, share, was: share, will: share });
    }
  });
  // Parents are rebuilt as stored nodes, so point them at the stored ones
  for (const n of nodes.values()) if (n.parent && seen.has(n.id)) n.parent = nodes.get(n.parent.id) ?? n.parent;
  const order = [...nodes.values()].filter((n) => !seen.has(n.id)).sort((a, b) => a.depth - b.depth);
  for (const n of order) {
    n.leaving = true;
    n.from = { ...n.cur };
    n.was = n.will = { ...n.share };
    let at = 0;
    for (let p = n; p; p = p.parent) {
      const sib = p.parent && nodes.get(p.parent.id);
      const next = sib?.kids.map((id) => nodes.get(id)).find((k) => k && seen.has(k.id) && k.x0 >= p.x0 && k.id !== p.id);
      if (next) { at = next.to.a0; break; }
      if (sib && seen.has(sib.id)) { at = sib.to.a1; break; }
    }
    n.to = { ...n.cur, a0: at, a1: at };
  }
  return f;
}

// The node of another view's tree that stands for what was in the middle: the deepest one that names nothing it
// didn't (but a genre, so an artist opened in Artists opens under their biggest genre in Genres), or none. An artist's
// album in Artists opens as that album in Albums, and back in Artists or in Genres it sits under its artist again,
// one more step from the outside.
function carried(tree) {
  let best = null, most = 0;
  eachNode(tree, (n) => {
    if (!n.kids.length || n.inOther || !n.depth) return;
    const keys = Object.keys(n.means);
    if (keys.some((k) => n.means[k] !== focusMeans[k] && !(k === "genre" && focusMeans[k] === undefined))) return;
    const score = keys.filter((k) => focusMeans[k] !== undefined).length;
    if (score > most || (score === most && score && n.value > best.value)) [best, most] = [n, score];
  });
  return best;
}

// A node of the whole tree by its id, down its path
const find = (id) => {
  let n = root;
  for (const name of id.split(SEP)) if (!(n = n?.kids.find((k) => k.name === name))) return null;
  return n;
};

// ---------- drawing ----------

const pt = (a, r) => `${(r * Math.sin(a)).toFixed(2)},${(-r * Math.cos(a)).toFixed(2)}`;

// Out to the card (tune.sunReach): the outer ring stretches to a box tune.sunMargin inside the card's sides and
// bottom, and level with the circle's top (so the title stays clear). Each radius r (a share of the whole) is warped
// at angle a: a circle up to the outer ring's inside (ring.now, which moves with the rings), and from there out to the
// box. Off, edge is null and everything is round.
let R = 0;
let edge = null; // { W, l, r, t, b, corners }: px from the middle to the box's sides, and its corners' angles
const ring = { from: null, to: null, now: null };
function measure(W) {
  const card = $("sunburst-card").getBoundingClientRect(), me = $("sunburst").getBoundingClientRect();
  const m = tune.sunMargin, cx = me.left + me.width / 2, cy = me.top + R + 1;
  const e = { W, l: Math.max(R, cx - card.left - m), r: Math.max(R, card.right - m - cx), t: R + 1 };
  // (stopping above the card's Visual tweaks while they show)
  const row = $("sunburst-card").querySelector(".tune-row"), bottom = row?.offsetHeight ? row.getBoundingClientRect().top : card.bottom;
  e.b = Math.max(e.t, bottom - m - cy);
  e.corners = [[e.r, -e.t], [e.r, e.b], [-e.l, e.b], [-e.l, -e.t]].map(([x, y]) => (Math.atan2(x, -y) + TAU) % TAU);
  return e;
}
function boxDist(a) {
  const s = Math.sin(a), c = -Math.cos(a);
  let d = Infinity;
  if (s > 1e-9) d = Math.min(d, edge.r / s);
  if (s < -1e-9) d = Math.min(d, edge.l / -s);
  if (c > 1e-9) d = Math.min(d, edge.b / c);
  if (c < -1e-9) d = Math.min(d, edge.t / -c);
  return d;
}
const inner = () => ring.now ?? 1;
const rad = (r, a) => {
  const k = inner();
  return !edge || r <= k ? r * R : k * R + ((r - k) / (1 - k)) * (boxDist(a) - k * R);
};
// Angles from b0 to b1, close enough for a curve, with the box's corners on the way
function samples(b0, b1) {
  const n = Math.max(1, Math.ceil((b1 - b0) / 0.03));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(b0 + ((b1 - b0) * i) / n);
  for (const c of edge?.corners ?? []) if (c > b0 && c < b1) out.push(c);
  return out.sort((x, y) => x - y);
}

// A slice from angle a0 to a1 and radius r0 to r1 (shares of the whole), `gap` px inside its edges: an arc, or out
// to the card, its warped outline
function slice(a0, a1, r0, r1, gap) {
  if (!edge || r1 <= inner()) return arc(a0, a1, r0 * R, r1 * R, gap);
  const out = (a) => rad(r1, a) - gap, inn = (a) => rad(r0, a) + gap, mid = (a0 + a1) / 2;
  if (out(mid) - (r0 > 0 ? inn(mid) : 0) <= 0.5) return "";
  const line = (as, f) => as.map((a) => pt(a, f(a))).join("L");
  if (a1 - a0 >= TAU - 1e-6) {
    const outside = "M" + line(samples(0, TAU), out) + "Z";
    return outside + (r0 > 0 ? "M" + line(samples(0, TAU).reverse(), inn) + "Z" : "");
  }
  const b0 = a0 + gap / out(a0), b1 = a1 - gap / out(a1);
  if (b1 - b0 <= 0.5 / out(mid)) return "";
  let d = "M" + line(samples(b0, b1), out);
  if (r0 > 0) {
    let c0 = a0 + gap / inn(a0), c1 = a1 - gap / inn(a1);
    if (c1 < c0) c0 = c1 = mid;
    d += "L" + line(samples(c0, c1).reverse(), inn);
  } else d += "L0,0";
  return d + "Z";
}

// The outline of a slice from angle a0 to a1 and radius r0 to r1 (px), drawn `gap` px inside its edges. A whole
// turn is a disc or a ring; a slice too thin for its gaps is nothing.
function arc(a0, a1, r0, r1, gap) {
  const ri = r0 > 0 ? r0 + gap : 0, ro = r1 - gap;
  if (ro - ri <= 0.5) return "";
  if (a1 - a0 >= TAU - 1e-6) {
    const ring = (r, sweep) => `M${pt(0, r)}A${r},${r} 0 1 ${sweep} ${pt(Math.PI, r)}A${r},${r} 0 1 ${sweep} ${pt(0, r)}Z`;
    return ring(ro, 1) + (ri > 0 ? ring(ri, 0) : "");
  }
  const b0 = a0 + gap / ro, b1 = a1 - gap / ro;
  if (b1 - b0 <= 0.5 / ro) return "";
  const large = b1 - b0 > Math.PI ? 1 : 0;
  let inner;
  if (ri > 0) {
    let c0 = a0 + gap / ri, c1 = a1 - gap / ri;
    if (c1 < c0) c0 = c1 = (a0 + a1) / 2;
    inner = `L${pt(c1, ri)}A${ri},${ri} 0 ${c1 - c0 > Math.PI ? 1 : 0} 0 ${pt(c0, ri)}`;
  } else inner = `L0,0`;
  return `M${pt(b0, ro)}A${ro},${ro} 0 ${large} 1 ${pt(b1, ro)}${inner}Z`;
}

// A slice's shape, and what marks where its own ring ends when it reaches past it to the edge (tune.sunTeeth): a
// light line along each ring's edge it crosses (ext), its rings cut apart as the others are, or what's past its
// ring lighter (ext). Also the part its label sits in.
function shapes(g) {
  const rn = Math.min(g.rn ?? g.r1, g.r1);
  const mode = g.r1 - rn > 1e-4 ? tune.sunTeeth : 1;
  const step = g.step > 1e-4 ? g.step : Infinity;
  if (mode === 3) {
    let d = "";
    for (let r = g.r0, to = rn; r < g.r1 - 1e-4; r = to, to = Math.min(g.r1, to + step)) d += slice(g.a0, g.a1, r, to, GAP);
    return [d, "", { ...g, r1: rn }];
  }
  if (mode === 4) return [slice(g.a0, g.a1, g.r0, rn, GAP), slice(g.a0, g.a1, rn, g.r1, GAP), { ...g, r1: rn }];
  const d = slice(g.a0, g.a1, g.r0, g.r1, GAP);
  let seams = "";
  if (mode === 2 && d) {
    const whole = g.a1 - g.a0 >= TAU - 1e-6;
    for (let r = rn; r < g.r1 - 1e-4; r += step) {
      const px = rad(r, g.a0);
      const b0 = whole ? 0 : g.a0 + GAP / px, b1 = whole ? TAU : g.a1 - GAP / rad(r, g.a1);
      if (b1 > b0) seams += "M" + samples(b0, b1).map((a) => pt(a, rad(r, a))).join("L") + (whole ? "Z" : "");
    }
  }
  return [d, seams, g];
}

// Text widths, measured once each in the label's own font
const widths = new Map();
let measureCtx = null;
function textWidth(s, font) {
  const k = font + "\u0000" + s;
  let w = widths.get(k);
  if (w === undefined) {
    measureCtx ??= document.createElement("canvas").getContext("2d");
    measureCtx.font = font;
    w = measureCtx.measureText(s).width;
    widths.set(k, w);
  }
  return w;
}

// Where a slice's label sits: its angles, and its radii in px across its middle
function spot(g) {
  const mid = (g.a0 + g.a1) / 2;
  return { a0: g.a0, a1: g.a1, mid, r0: rad(g.r0, mid), r1: rad(g.r1, mid), full: g.a1 - g.a0 >= TAU - 1e-6 && g.r0 <= 0 };
}

// Whether a w × h box, set level at the middle of a slice (its spot), stays PAD inside it
function fits(g, w, h) {
  const { r0, r1, mid } = g, da = g.a1 - g.a0;
  if (g.full) return w <= 1.7 * r1 - 2 * PAD && h <= 1.4 * r1 - 2 * PAD; // the middle circle
  const rm = (r0 + r1) / 2;
  const radial = w * Math.abs(Math.sin(mid)) + h * Math.abs(Math.cos(mid));
  const across = w * Math.abs(Math.cos(mid)) + h * Math.abs(Math.sin(mid));
  if (radial > r1 - r0 - 2 * PAD) return false;
  const inner = rm - radial / 2;
  return across <= 2 * inner * Math.sin(Math.min(da, Math.PI) / 2) - 2 * PAD;
}

// The name cut short to fit above the share, or null when not even a few letters would
function fitName(name, g, pctW) {
  const { name: font, line } = fonts;
  const h = line * 2;
  if (fits(g, Math.max(pctW, textWidth(name, font)), h)) return name;
  // The longest cut that fits, found by halving
  const cut = (n) => name.slice(0, n).trimEnd() + "…";
  let lo = 3, hi = name.length - 1; // lo: known not to be wanted; hi: the longest to try
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2);
    if (fits(g, Math.max(pctW, textWidth(cut(m), font)), h)) lo = m;
    else hi = m - 1;
  }
  return lo >= 4 ? cut(lo) : null;
}

// A node's slice, label and (for the items, the first ring) outline; a slice carried to another ring by a tab change
// takes that ring's shade and gains or loses its outline
function els(n) {
  if (!n.path) {
    n.path = make("path", "sun-slice");
    n.path.__node = n;
    n.ext = make("path", "sun-slice sun-ext");
    n.ext.__node = n;
    n.label = make("g", "sun-label");
    n.pctEl = make("text", "sun-pct");
    n.nameEl = make("text", "sun-name");
    n.subEl = make("text", "sun-sub");
    n.label.append(n.nameEl, n.pctEl, n.subEl);
    layers.slices.append(n.path, n.ext);
    layers.labels.append(n.label);
  }
  for (let d = 0; d <= 3; d++) for (const e of [n.path, n.ext]) e.classList.toggle("d" + d, d === Math.min(n.depth, 3));
  if (n.depth === 1 && !n.outline) {
    n.outline = make("path", "sun-outline");
    layers.outlines.append(n.outline);
  } else if (n.depth !== 1 && n.outline) {
    n.outline.remove();
    n.outline = null;
  }
  if (!fonts) {
    const css = (el) => getComputedStyle(el);
    const font = (s) => `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const p = css(n.pctEl);
    fonts = { pct: font(p), name: font(css(n.nameEl)), sub: font(css(n.subEl)), line: parseFloat(p.fontSize) * 1.25 };
  }
}

function drop(n) {
  for (const el of [n.path, n.ext, n.label, n.outline]) el?.remove();
}

// Puts every slice, outline and label where its cur says, and shows the labels that fit
function draw() {
  const el = $("sunburst");
  const W = el.clientWidth;
  if (!W || !svg) return;
  const H = Math.min(W, MAX_SIZE);
  svg.setAttribute("viewBox", `${-W / 2} ${-H / 2} ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  R = H / 2 - 1;
  if (!tune.sunReach) edge = null;
  else if (edge?.W !== W) edge = measure(W);
  const zoomed = focusId !== "";
  for (const n of nodes.values()) {
    const g = n.cur;
    const middle = n.id === focusId;
    const [d, ext, at] = n.depth === 0 && !middle ? ["", "", g] : shapes(g);
    // The share of the middle, and once gone in, of everything (all the middle shows)
    const pct = n.depth === 0 || middle ? "" : fmtShare(n.share.p);
    const sub = n.depth === 0 || !zoomed ? "" : fmtShare(n.share.s);
    // (a slice that hasn't moved, or stays at nothing, is left alone)
    const key = `${d}|${ext}|${pct}|${sub}|${middle}|${n.leaving}|${n.shown}`;
    if (key === n.key) continue;
    n.key = key;
    els(n);
    n.path.setAttribute("d", d);
    n.ext.setAttribute("d", ext);
    n.ext.classList.toggle("seam", tune.sunTeeth === 2);
    // A pinned item's outline runs round all of it, out to the edge
    if (n.outline) n.outline.setAttribute("d", d && slice(g.a0, g.a1, g.r0, 1, GAP + 0.75));
    label(n, at, d, pct, sub, middle);
  }
}

// A slice's lines, the ones that fit: its name, its share of the middle, and below, small, its share of everything
// (the middle circle: its name and that)
function label(n, g, d, pct, sub, middle) {
  const at = spot(g);
  const lh = fonts.line;
  const pctW = textWidth(pct, fonts.pct), subW = textWidth(sub, fonts.sub);
  let name = null, showPct = false, showSub = false;
  if (d && !n.leaving && n.depth > 0) {
    if (middle) {
      showSub = !!sub && fits(at, subW, lh);
      name = fitName("‹ " + n.shown, at, showSub ? subW : 0);
    } else if ((showPct = fits(at, pctW, lh))) {
      name = fitName(n.shown, at, pctW);
      const w = Math.max(pctW, subW, name ? textWidth(name, fonts.name) : 0);
      showSub = !!sub && fits(at, w, lh * (name ? 3 : 2));
    }
  }
  const lines = [[n.nameEl, !!name], [n.pctEl, showPct], [n.subEl, showSub]].filter(([, on]) => on);
  const rm = at.full ? 0 : (at.r0 + at.r1) / 2;
  const x = rm * Math.sin(at.mid), y = -rm * Math.cos(at.mid);
  lines.forEach(([el], i) => {
    el.setAttribute("x", x.toFixed(1));
    el.setAttribute("y", (y + (i - (lines.length - 1) / 2) * lh).toFixed(1));
  });
  if (n.pctEl.textContent !== pct) n.pctEl.textContent = pct;
  if (sub && n.subEl.textContent !== sub) n.subEl.textContent = sub;
  if (name && n.nameEl.textContent !== name) n.nameEl.textContent = name; // from the user's files
  n.pctEl.classList.toggle("fits", showPct);
  n.subEl.classList.toggle("fits", showSub);
  n.nameEl.classList.toggle("fits", !!name);
}

function frame(p) {
  for (const n of nodes.values()) {
    const { from: a, to: b, was, will } = n;
    const lerp = (x, y) => x + (y - x) * p;
    n.cur = {
      a0: lerp(a.a0, b.a0), a1: lerp(a.a1, b.a1), r0: lerp(a.r0, b.r0), r1: lerp(a.r1, b.r1),
      rn: lerp(a.rn ?? a.r1, b.rn ?? b.r1), step: lerp(a.step ?? b.step ?? 0, b.step ?? a.step ?? 0),
    };
    n.share = { p: was.p + (will.p - was.p) * p, s: was.s + (will.s - was.s) * p };
  }
  ring.now = ring.from + (ring.to - ring.from) * p;
  draw();
}

// One morph of everything from where it is to where it's going, on one clock
function glide(ms, ease = easeInOut) {
  cancelAnimationFrame(raf);
  const done = () => {
    raf = 0;
    frame(1);
    svg.classList.remove("swapping");
    for (const [id, n] of nodes) {
      if (!n.leaving) continue;
      drop(n);
      nodes.delete(id);
    }
  };
  if (!ms || !$("sunburst").clientWidth) return done();
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    if (t === 1) return done();
    frame(ease(t));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

// ---------- looks ----------

// Every slice by the hover/pin rule, as its item: an item's slices are lit together. A slice hovered here lights
// itself, what it lies in and what lies in it, and leaves the rest of its item as it was
const related = (n, h) => {
  for (let p = h; p; p = p.parent) if (p.id === n.id) return true;
  for (let p = n; p; p = p.parent) if (p.id === h.id) return true;
  return false;
};
// (Everyone else lights only here, as an item of its own)
function restyle() {
  const pinned = new Set([...nodes.values()].filter((n) => n.depth === 1 && !n.leaving && pins?.has(n.item)).map((n) => n.item));
  const lit = hoverNode?.item === OTHER ? OTHER : hoveredItem;
  for (const n of nodes.values()) {
    if (!n.path) continue;
    let look = n.depth === 0 ? "rest" : litLook(pinned, lit, n.item);
    if ((look === "hover" || look === "pinHover") && hoverNode?.item === n.item && !related(n, hoverNode)) look = pinned.has(n.item) ? "pin" : "rest";
    if (n.path.dataset.look !== look) n.path.dataset.look = n.ext.dataset.look = n.label.dataset.look = look;
    n.outline?.classList.toggle("on", pinned.has(n.item));
    const go = n.kids.length > 0 || (n.id === focusId && !!n.parent) || opens(n) || pinnable(n);
    n.path.classList.toggle("go", go);
    n.ext.classList.toggle("go", go);
  }
}

// The slice under the pointer: lights its item everywhere (focusArtist), and its readout follows the pointer
function pointAt(n, ev) {
  if (n && n.depth === 0) n = null;
  if (n !== hoverNode) {
    hoverNode = n;
    focusArtist($("chart-rolling"), n && n.item !== OTHER ? n.item : null);
    restyle();
  }
  if (!n) return void tip.classList.remove("on");
  fillTip(n);
  const box = $("sunburst").getBoundingClientRect();
  const x = ev.clientX - box.left, y = ev.clientY - box.top;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${x + 16 + w > box.width ? Math.max(0, x - 16 - w) : x + 16}px`;
  tip.style.top = `${Math.min(Math.max(0, y + 16), box.height - h)}px`;
  tip.classList.add("on");
}

function fillTip(n) {
  if (tip.__node === n && tip.__value === n.value) return;
  tip.__node = n;
  tip.__value = n.value;
  const rows = [];
  const path = [];
  for (let p = n; p && p.depth > 0; p = p.parent) path.unshift(p);
  path.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = i === path.length - 1 ? "here" : "up";
    row.textContent = p.shown; // from the user's files
    rows.push(row);
  });
  const num = (text) => {
    const el = document.createElement("div");
    el.className = "num";
    el.textContent = text; // (the middle's name is from the user's files)
    rows.push(el);
  };
  const f = nodes.get(focusId), all = `${fmtShare(total ? n.value / total : 0)} of the period`;
  if (!focusId || n.id === focusId) num(`${fmtHours(n.value)} · ${all}`);
  else {
    num(`${fmtHours(n.value)} · ${fmtShare(f.value ? n.value / f.value : 0)} of ${f.shown}`);
    num(all);
  }
  const how = n.id === focusId ? "Click to go back out" : n.kids.length ? "Click to go in" : opens(n) ? "Click to pin it in Tracks"
    : pinnable(n) ? (pins?.has(pinName(n)) ? "Click to unpin it" : "Click to pin it") : "";
  if (how) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = how;
    rows.push(hint);
  }
  tip.replaceChildren(...rows);
}

// Every slice in its item's color (and the ones going in brings out)
function colorAll() {
  for (const n of nodes.values()) {
    els(n);
    const slot = n.item != null && n.item !== OTHER ? state.colorSlots.get(n.item) : undefined;
    const c = slot === undefined ? "var(--other)" : `var(--series-${slot + 1})`;
    for (const e of [n.path, n.ext, n.label, n.outline]) e?.style.setProperty("--c", c);
  }
}

function zoomTo(id) {
  focusId = id;
  focusMeans = id ? find(id).means : {};
  seeking = false;
  retarget(false);
  colorAll();
  hoverNode = null;
  tip.classList.remove("on");
  tip.__node = null;
  restyle();
  glide(dur(MORPH_MS));
}

// ---------- the page's side ----------

// Light one item from a hover anywhere on the page; null clears
export function focusSunburst(name) {
  if (!svg) return;
  hoveredItem = name;
  // (hovering Everyone else here lights nothing elsewhere)
  if (hoverNode && hoverNode.item !== name && !(hoverNode.item === OTHER && name == null)) hoverNode = null;
  restyle();
}

// Follows the chart's artists (the mix bar's), their colors, pins and hidden ones, and the period
export function paintSunburst(plays) {
  const card = $("sunburst-card");
  card.hidden = !LEVELS[state.dim];
  if (card.hidden || !state.mixArgs || putOff(card, () => paintSunburst())) return;
  if (!svg) setup();
  plays ??= shownPlays();
  const [artists, , , p] = state.mixArgs;
  pins = p;
  const off = new Set(state.hidden);
  const items = artists.filter((a) => !off.has(a));
  $("sunburst-title").textContent = `Inside your top ${noun().many}`;
  $("sunburst-sub").textContent = `${NOTES[state.dim]}, sized by hours. ` +
    (state.dim === "track" ? "Click one to pin it." : "Click a slice to go in; click the middle to come back out.");
  const first = nodes.size === 0;
  root = build(plays, items, $("sunburst-other").checked);
  edge = null; // (the card may have moved)
  const swap = !!lastDim && lastDim !== state.dim;
  if (lastDim && (swap || seeking)) {
    const n = carried(root);
    focusId = n?.id ?? "";
    seeking = !n && Object.keys(focusMeans).length > 0;
  }
  lastDim = state.dim;
  total = root.value;
  retarget(first, swap);
  // Colors cross-fade with the morph that carries slices into the new view (the class goes when it ends)
  if (swap) svg.classList.add("swapping");
  colorAll();
  $("sunburst").classList.toggle("empty", !total);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Inside your top ${noun().many}: ` + root.kids.map((k) => `${k.shown} ${fmtShare(k.value / (total || 1))}`).join(", "));
  restyle();
  glide(first ? dur(ENTER_MS) : dur(MORPH_MS), first ? easeOut : easeInOut);
}

$("sunburst-other").addEventListener("change", () => paintSunburst());

// "Inside your top …": the listening mix's items opened up, as rings around a middle circle. Artists, then their
// albums, then their songs (albums: their songs; genres: their artists, then those artists' albums), each slice
// as wide as its hours. Slices show their share of the period (of the items the mix bar shows, so the two agree)
// where it fits, and the name where both fit. Clicking a slice goes in: it opens out into the middle circle and its
// insides fill the rings; clicking the middle circle goes back out. Every move (going in or out, a new period, items
// coming and going) is one morph of every slice from where it is on screen.
// Drawn by hand in SVG rather than with ECharts' sunburst, which drops slices without animating them. Colors follow
// the item (the chart's palette slots); a slice under an item takes its color, lighter the deeper it lies. Hovering
// lights the item everywhere on the page, pins show as in every graph (litLook), and the hidden ones are left out.

import { $, state, noun, shownPlays, putOff } from "./state.js";
import { focusArtist } from "./charts.js";
import { mixArgs } from "./rollingview.js";
import { ENTER_MS, MORPH_MS, dur, easeInOut, easeOut, litLook } from "./motion.js";

const SVGNS = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
const SEP = "\u0000"; // between the names in a node's id, its path from the root
const HOUR = 3600000;
const MAX_SIZE = 560; // px, the circle's widest
const HOLE = 0.22; // the middle circle's radius, as a share of the whole
const GAP = 1; // px of surface on each side of a slice
const PAD = 4; // px a label keeps from its slice's edges

// What each view's items open into: how to name a play at each level below the item, how many to keep before the
// rest are folded into one "Other …" slice, and what that slice is called
const LEVELS = {
  artist: [[(p) => p.album || "Unknown album", 6, "Other albums"], [(p) => p.track, 8, "Other songs"]],
  album: [[(p) => p.track, 12, "Other songs"]],
  genre: [[(p) => p.by, 8, "Other artists"], [(p) => p.album || "Unknown album", 5, "Other albums"]],
};
// What a node at each level stands for, whatever view it's in ({ genre, artist, album }), so a tab change can keep
// the same thing in the middle: means(name, the parent's meaning) per level below the root
const MEANS = {
  artist: [(n) => ({ artist: n }), (n, up) => ({ ...up, album: n }), (n, up) => ({ ...up, track: n })],
  album: [(n) => ({ artist: state.owner?.get(n), album: state.titles?.get(n) ?? n }), (n, up) => ({ ...up, track: n })],
  genre: [(n) => ({ genre: n }), (n, up) => ({ ...up, artist: n }), (n, up) => ({ ...up, album: n })],
};
const NOTES = {
  artist: "Each artist's albums, then their songs",
  album: "Each album's songs",
  genre: "Each genre's artists, then their albums",
};

const fmtHours = (h) => h.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " h";
const fmtShare = (s) => (s >= 0.005 ? Math.round(s * 100) + "%" : "<1%");

let svg, layers, tip;
const nodes = new Map(); // id -> node, as on screen (including those leaving)
let root = null;
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
  });
  new ResizeObserver(() => !raf && draw()).observe(el);
}

// ---------- the tree ----------

// The period's plays of the shown items, as a tree: the root, the items (in the mix bar's order), and below each
// the levels its view opens into, every node with its hours, and x0..x1 its place around the circle (0..1)
function build(plays, items) {
  const levels = LEVELS[state.dim];
  const want = new Set(items);
  const top = new Map(items.map((a) => [a, new Map()]));
  for (const p of plays) {
    if (!want.has(p.artist)) continue;
    let m = top.get(p.artist);
    for (let i = 0; i < levels.length; i++) {
      const k = levels[i][0](p);
      if (i === levels.length - 1) m.set(k, (m.get(k) ?? 0) + p.ms / HOUR);
      else {
        if (!m.has(k)) m.set(k, new Map());
        m = m.get(k);
      }
    }
  }
  const sum = (x) => (typeof x === "number" ? x : [...x.values()].reduce((a, y) => a + sum(y), 0));
  const node = (parent, name, x, depth, item) => {
    const id = parent ? (parent.id ? parent.id + SEP : "") + name : "";
    const means = depth === 0 ? {} : MEANS[state.dim][depth - 1]?.(name, parent.means) ?? parent.means;
    const n = { id, name, parent, depth, item, means, value: sum(x), kids: [] };
    if (typeof x === "number" || !x.size) return n;
    const level = levels[depth - 1] ?? [null, Infinity];
    let kids = [...x].map(([k, y]) => [k, y, sum(y)]);
    if (depth > 0) kids.sort((a, b) => b[2] - a[2]); // the items keep the mix bar's order
    const [, cap, rest] = level;
    const restH = kids.slice(cap).reduce((a, k) => a + k[2], 0);
    kids = kids.slice(0, cap);
    n.kids = kids.filter((k) => k[2] > 0).map(([k, y]) => node(n, k, y, depth + 1, item ?? k));
    if (restH > 0) n.kids.push({ ...node(n, rest, restH, depth + 1, item), means: n.means, other: true });
    return n;
  };
  const r = node(null, "", top, 0, null);
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

const eachNode = (n, fn) => {
  fn(n);
  for (const k of n.kids) eachNode(k, fn);
};

// ---------- layout ----------

// Where every node sits with `f` in the middle: its angles a0..a1 (from 12 o'clock, clockwise) and radii r0..r1
// (shares of the whole radius). f fills the middle circle and the levels below it share the rings; whatever lies
// outside f closes up to nothing at the top, and whatever lies inside the circle (f's ancestors) shrinks to the middle.
function layout(n, f, rings) {
  const span = f.x1 - f.x0 || 1;
  const ang = (x) => Math.min(1, Math.max(0, (x - f.x0) / span)) * TAU;
  const step = (1 - HOLE) / rings;
  let r0, r1;
  if (n.depth < f.depth) r0 = r1 = 0;
  else if (n.depth === f.depth) [r0, r1] = [0, HOLE];
  else {
    r0 = HOLE + (n.depth - f.depth - 1) * step;
    r1 = r0 + step;
  }
  return { a0: ang(n.x0), a1: ang(n.x1), r0, r1 };
}

// Every node's place now, and where it's going: nodes new to the tree grow from nothing where they'll sit, and
// those leaving it close up into the place of the next one that stays (or their parent's end)
// What a slice stands for in any view but Genres, which adds a genre to the same artists and albums: the key a slice
// keeps through a tab change. None for a genre itself, or an "Other …" slice
const meaningOf = (n) => {
  const m = n.means;
  return !n.other && m?.artist != null ? [m.artist, m.album ?? "", m.track ?? ""].join(SEP) : null;
};

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
  // (the rings are shared out over the levels below the middle, the same number whatever the item: one with no
  // albums still leaves room for them)
  const rings = LEVELS[state.dim].length + 1 - f.depth;
  const seen = new Set();
  eachNode(root, (n) => {
    seen.add(n.id);
    const to = layout(n, f, rings);
    let kept = nodes.get(n.id);
    const k = swap && !kept && meaningOf(n);
    if (k && was.has(k)) {
      kept = was.get(k);
      was.delete(k);
      nodes.delete(kept.id);
      nodes.set(n.id, kept);
    }
    if (kept) {
      Object.assign(kept, { ...n, kids: n.kids, from: { ...kept.cur }, to, leaving: false });
      kept.kids = n.kids.map((k) => k.id);
    } else {
      const grow = first ? { ...to, r1: to.r0 } : { ...to, a1: to.a0 };
      nodes.set(n.id, { ...n, kids: n.kids.map((k) => k.id), from: grow, cur: { ...grow }, to, leaving: false });
    }
  });
  // Parents are rebuilt as stored nodes, so point them at the stored ones
  for (const n of nodes.values()) if (n.parent && seen.has(n.id)) n.parent = nodes.get(n.parent.id) ?? n.parent;
  const order = [...nodes.values()].filter((n) => !seen.has(n.id)).sort((a, b) => a.depth - b.depth);
  for (const n of order) {
    n.leaving = true;
    n.from = { ...n.cur };
    let at = 0;
    for (let p = n; p; p = p.parent) {
      const sib = p.parent && nodes.get(p.parent.id);
      const next = sib?.kids.map((id) => nodes.get(id)).find((k) => k && seen.has(k.id) && k.x0 >= p.x0 && k.id !== p.id);
      if (next) { at = next.to.a0; break; }
      if (sib && seen.has(sib.id)) { at = sib.to.a1; break; }
    }
    n.to = { a0: at, a1: at, r0: n.cur.r0, r1: n.cur.r1 };
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
    if (!n.kids.length || n.other || !n.depth) return;
    const keys = Object.keys(n.means);
    if (keys.some((k) => n.means[k] !== focusMeans[k] && !(k === "genre" && focusMeans[k] === undefined))) return;
    const score = keys.filter((k) => focusMeans[k] !== undefined).length;
    if (score > most || (score === most && score && n.value > best.value)) [best, most] = [n, score];
  });
  return best;
}

const find = (id) => {
  let hit = null;
  eachNode(root, (n) => hit == null && n.id === id && (hit = n));
  return hit;
};

// ---------- drawing ----------

const pt = (a, r) => `${(r * Math.sin(a)).toFixed(2)},${(-r * Math.cos(a)).toFixed(2)}`;

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

// Whether a w × h box, set level at the middle of a slice, stays PAD inside it
function fits(g, R, w, h) {
  const r0 = g.r0 * R, r1 = g.r1 * R, da = g.a1 - g.a0;
  if (da >= TAU - 1e-6 && r0 <= 0) return w <= 1.7 * r1 - 2 * PAD && h <= 1.4 * r1 - 2 * PAD; // the middle circle
  const mid = (g.a0 + g.a1) / 2, rm = (r0 + r1) / 2;
  const radial = w * Math.abs(Math.sin(mid)) + h * Math.abs(Math.cos(mid));
  const across = w * Math.abs(Math.cos(mid)) + h * Math.abs(Math.sin(mid));
  if (radial > r1 - r0 - 2 * PAD) return false;
  const inner = rm - radial / 2;
  return across <= 2 * inner * Math.sin(Math.min(da, Math.PI) / 2) - 2 * PAD;
}

// The name cut short to fit beside the share, or null when not even a few letters would
function fitName(name, g, R, pctW) {
  const { name: font, line } = fonts;
  const h = line * 2;
  if (fits(g, R, Math.max(pctW, textWidth(name, font)), h)) return name;
  // The longest cut that fits, found by halving
  const cut = (n) => name.slice(0, n).trimEnd() + "…";
  let lo = 3, hi = name.length - 1; // lo: known not to be wanted; hi: the longest to try
  while (lo < hi) {
    const m = Math.ceil((lo + hi) / 2);
    if (fits(g, R, Math.max(pctW, textWidth(cut(m), font)), h)) lo = m;
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
    n.label = make("g", "sun-label");
    n.pctEl = make("text", "sun-pct");
    n.nameEl = make("text", "sun-name");
    n.label.append(n.nameEl, n.pctEl);
    layers.slices.append(n.path);
    layers.labels.append(n.label);
  }
  for (let d = 0; d <= 3; d++) n.path.classList.toggle("d" + d, d === Math.min(n.depth, 3));
  if (n.depth === 1 && !n.outline) {
    n.outline = make("path", "sun-outline");
    layers.outlines.append(n.outline);
  } else if (n.depth !== 1 && n.outline) {
    n.outline.remove();
    n.outline = null;
  }
  if (!fonts) {
    const css = (el) => getComputedStyle(el);
    const p = css(n.pctEl), m = css(n.nameEl);
    fonts = { pct: `${p.fontWeight} ${p.fontSize} ${p.fontFamily}`, name: `${m.fontWeight} ${m.fontSize} ${m.fontFamily}`, line: parseFloat(p.fontSize) * 1.25 };
  }
}

function drop(n) {
  for (const el of [n.path, n.label, n.outline]) el?.remove();
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
  const R = H / 2 - 1;
  for (const n of nodes.values()) {
    const g = n.cur;
    const d = n.depth === 0 && n.id !== focusId ? "" : arc(g.a0, g.a1, g.r0 * R, g.r1 * R, GAP);
    // (a slice that hasn't moved, or stays at nothing, is left alone)
    const key = `${d}|${n.value}|${n.id === focusId}`;
    if (key === n.key) continue;
    n.key = key;
    els(n);
    n.path.setAttribute("d", d);
    if (n.outline) {
      // A pinned item's outline runs round all of it, out to the edge
      n.outline.setAttribute("d", d && arc(g.a0, g.a1, g.r0 * R, R, GAP + 0.75));
    }
    label(n, g, R, d);
  }
}

function label(n, g, R, d) {
  const share = total ? n.value / total : 0;
  const middle = n.id === focusId;
  const pct = n.depth === 0 ? "" : fmtShare(share);
  const pctW = textWidth(pct, fonts.pct);
  let showPct = !!d && !!pct && !n.leaving && fits(g, R, pctW, fonts.line);
  let name = showPct ? fitName((middle ? "‹ " : "") + n.shown, g, R, pctW) : null;
  if (n.depth === 0) [showPct, name] = [false, null];
  const full = g.a1 - g.a0 >= TAU - 1e-6 && g.r0 <= 0;
  const mid = (g.a0 + g.a1) / 2, rm = full ? 0 : ((g.r0 + g.r1) / 2) * R;
  const x = rm * Math.sin(mid), y = -rm * Math.cos(mid);
  const lh = fonts.line;
  n.pctEl.setAttribute("x", x.toFixed(1));
  n.pctEl.setAttribute("y", (name ? y + lh / 2 : y).toFixed(1));
  n.nameEl.setAttribute("x", x.toFixed(1));
  n.nameEl.setAttribute("y", (y - lh / 2).toFixed(1));
  if (n.pctEl.textContent !== pct) n.pctEl.textContent = pct;
  if (name && n.nameEl.textContent !== name) n.nameEl.textContent = name; // from the user's files
  n.pctEl.classList.toggle("fits", showPct);
  n.nameEl.classList.toggle("fits", !!name);
}

function frame(p) {
  for (const n of nodes.values()) {
    const { from: a, to: b } = n;
    n.cur = { a0: a.a0 + (b.a0 - a.a0) * p, a1: a.a1 + (b.a1 - a.a1) * p, r0: a.r0 + (b.r0 - a.r0) * p, r1: a.r1 + (b.r1 - a.r1) * p };
  }
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
function restyle() {
  const pinned = new Set([...nodes.values()].filter((n) => n.depth === 1 && !n.leaving && pins?.has(n.item)).map((n) => n.item));
  for (const n of nodes.values()) {
    if (!n.path) continue;
    let look = n.depth === 0 ? "rest" : litLook(pinned, hoveredItem, n.item);
    if ((look === "hover" || look === "pinHover") && hoverNode?.item === n.item && !related(n, hoverNode)) look = pinned.has(n.item) ? "pin" : "rest";
    if (n.path.dataset.look !== look) n.path.dataset.look = n.label.dataset.look = look;
    n.outline?.classList.toggle("on", pinned.has(n.item));
    n.path.classList.toggle("go", n.kids.length > 0 || (n.id === focusId && !!n.parent));
  }
}

// The slice under the pointer: lights its item everywhere (focusArtist), and its readout follows the pointer
function pointAt(n, ev) {
  if (n && n.depth === 0) n = null;
  if (n !== hoverNode) {
    hoverNode = n;
    focusArtist($("chart-rolling"), n?.item ?? null);
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
  const num = document.createElement("div");
  num.className = "num";
  num.textContent = `${fmtHours(n.value)} · ${fmtShare(total ? n.value / total : 0)} of the period`;
  rows.push(num);
  const how = n.id === focusId ? "Click to go back out" : n.kids.length ? "Click to go in" : "";
  if (how) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = how;
    rows.push(hint);
  }
  tip.replaceChildren(...rows);
}

function zoomTo(id) {
  focusId = id;
  focusMeans = id ? find(id).means : {};
  seeking = false;
  retarget(false);
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
  if (hoverNode && hoverNode.item !== name) hoverNode = null;
  restyle();
}

// Follows the chart's artists (the mix bar's), their colors, pins and hidden ones, and the period. Hidden in the
// tracks view, which has nothing inside its items.
export function paintSunburst(plays) {
  const card = $("sunburst-card");
  card.hidden = state.dim === "track" || !LEVELS[state.dim];
  if (card.hidden || !mixArgs || putOff(card, () => paintSunburst())) return;
  if (!svg) setup();
  plays ??= shownPlays();
  const [artists, , , p] = mixArgs;
  pins = p;
  const off = new Set(state.hidden);
  const items = artists.filter((a) => !off.has(a));
  $("sunburst-title").textContent = `Inside your top ${noun().many}`;
  $("sunburst-sub").textContent = `${NOTES[state.dim]}, sized by hours. Click a slice to go in; click the middle to come back out.`;
  const first = nodes.size === 0;
  root = build(plays, items);
  const swap = !!lastDim && lastDim !== state.dim;
  if (lastDim && (swap || seeking)) {
    const n = carried(root);
    focusId = n?.id ?? "";
    seeking = !n && Object.keys(focusMeans).length > 0;
  }
  lastDim = state.dim;
  total = root.value;
  const titles = state.titles;
  eachNode(root, (n) => (n.shown = n.depth === 1 && titles ? titles.get(n.name) ?? n.name : n.name));
  retarget(first, swap);
  // Colors cross-fade with the morph that carries slices into the new view (the class goes when it ends)
  if (swap) svg.classList.add("swapping");
  for (const n of nodes.values()) {
    els(n);
    const slot = n.item != null ? state.colorSlots.get(n.item) : undefined;
    const c = slot === undefined ? "var(--other)" : `var(--series-${slot + 1})`;
    for (const e of [n.path, n.label, n.outline]) e?.style.setProperty("--c", c);
  }
  $("sunburst").classList.toggle("empty", !total);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Inside your top ${noun().many}: ` + root.kids.map((k) => `${k.shown} ${fmtShare(k.value / (total || 1))}`).join(", "));
  restyle();
  glide(first ? dur(ENTER_MS) : dur(MORPH_MS), first ? easeOut : easeInOut);
}

// Rows flying between a gallery thumbnail and their card (arrivals.js; see docs/arrivals.md). A card whose plot is a
// list of HTML rows morphs it part by part: each bar, name or number the thumbnail also draws starts where the
// thumbnail draws it and glides to its own place, and everything else in the rows fades in around them (out, closing).
// The parts move by the CSS `translate` and `scale` properties, which stack on any `transform` a card sets itself.
//
// flyRows(card, plot, parts, to, ms): parts is [{ el, at, row }], `at` where the thumbnail draws the part, in the plot's
// own px (the thumbnail's px times the plot's width over the thumbnail's: the flight puts the two top left on top left):
//   { x, y, w, h }                     a box (a bar): stretched to it
//   { x, y, w, size, align }           text: scaled evenly to `size` (its font size there), its left edge (or right, with
//                                      align "right") at x and its middle at y, clipped to w when it's wider (Infinity:
//                                      never; a clip repaints every frame, so only where text would run into a bar)
//   null                               nothing there: it fades, moving with its row (`row`: its place in the list,
//                                      top first) as the row's bar does, or as the rows past the last placed one would
// to "thumb" or "card", over ms (in-out, from what's on screen), or at once when ms is 0. Imports only motion.js.
import { EASE_IN_OUT } from "./motion.js";

const ID = "rowfly";
const ORIGIN = { box: "0 0", left: "0 50%", right: "100% 50%" };

const HOME = { translate: "0px 0px", scale: "1", opacity: "1", clipPath: "inset(0px)" };
const CSS = { translate: "translate", scale: "scale", opacity: "opacity", clipPath: "clip-path" };
// What a part shows now (mid-flight, its animation's values), for the properties it moves
const onScreen = (cs, keys) => Object.fromEntries(keys.map((k) => {
  const v = cs.getPropertyValue(CSS[k]);
  return [k, v === "none" ? HOME[k] : v];
}));

// A part's form in the thumbnail, from its own box (n, in the plot's px; n.font its font size); dy: an unplaced part's
// row's offset. Only what the part needs moves: translate and scale (and opacity, fading) run on the compositor; a
// clip, which repaints every frame, only on text wider than the thumbnail's room for it.
function thumbForm(at, n, dy = 0) {
  if (!at) return { origin: ORIGIN.box, look: { translate: `0px ${dy}px`, opacity: 0 } };
  if (at.size == null) {
    const sx = n.w > 0.5 ? at.w / n.w : 1, sy = n.h > 0.5 ? at.h / n.h : 1;
    return { origin: ORIGIN.box, look: { translate: `${at.x - n.x}px ${at.y - n.y}px`, scale: `${sx} ${sy}` } };
  }
  const k = at.size / (n.font || at.size);
  const right = at.align === "right";
  const dx = right ? at.x - (n.x + n.w) : at.x - n.x;
  const look = { translate: `${dx}px ${at.y - (n.y + n.h / 2)}px`, scale: `${k}` };
  // (clipped to the room the thumbnail gave it, in its own px)
  const cut = n.text * k - at.w > 0.5 ? n.w - at.w / k : 0;
  if (cut > 0.5) look.clipPath = right ? `inset(0px 0px 0px ${cut}px)` : `inset(0px ${cut}px 0px 0px)`;
  return { origin: right ? ORIGIN.right : ORIGIN.left, look };
}

// Each row's offset (thumbnail over card, at its bar's middle), from the rows with a placed bar: between two, the one
// between; past the last (or before the first), the same as it, so the rest of the list stays together under it
function rowOffsets(parts, boxes) {
  const known = [];
  parts.forEach(({ at, row }, i) => {
    if (row == null || !at || at.size != null) return;
    known.push([row, at.y + at.h / 2 - (boxes[i].y + boxes[i].h / 2)]);
  });
  known.sort((a, b) => a[0] - b[0]);
  if (!known.length) return () => 0;
  const [r0, d0] = known[0], [r1, d1] = known.at(-1);
  return (r) => {
    if (r >= r1) return d1;
    if (r <= r0) return d0;
    const j = known.findIndex(([k]) => k >= r);
    const [ra, da] = known[j - 1], [rb, db] = known[j];
    return da + ((r - ra) / (rb - ra)) * (db - da);
  };
}

// The plot's own animations (rows growing in, gliding to their place) finish first, so the rows are where they rest
function settleOwn(plot) {
  for (const a of plot.getAnimations({ subtree: true })) {
    if (a.id === ID) continue;
    try { a.finish(); } catch { /* (an endless one stays) */ }
  }
}

// Clipping boxes between the parts and the card let the parts out while they fly (the card's own clip holds them)
function unclip(card, parts) {
  if (card._rowfly) return;
  const opened = [];
  const seen = new Set();
  for (const { el } of parts) {
    for (let p = el.parentElement; p && p !== card; p = p.parentElement) {
      if (seen.has(p)) break;
      seen.add(p);
      if (getComputedStyle(p).overflow !== "visible") opened.push([p, p.style.overflow]);
    }
  }
  for (const [p] of opened) p.style.overflow = "visible"; // (after every read, so the page's style is worked out once)
  card._rowfly = opened;
}
function restore(card, parts) {
  for (const { el } of parts) {
    el._fly?.cancel();
    el._fly = null;
    el.style.transformOrigin = el._flyOrigin ?? "";
    delete el._flyOrigin;
  }
  for (const [p, was] of card._rowfly ?? []) p.style.overflow = was;
  card._rowfly = null;
}

export function flyRows(card, plot, parts, to, ms) {
  // (every read before any write, so the page's style and layout are worked out once, not once a part)
  const was = parts.map(({ el }) => (el._fly ? { cs: getComputedStyle(el), keys: el._flyKeys } : null))
    .map((w) => w && onScreen(w.cs, w.keys));
  for (const { el } of parts) el._fly?.cancel();
  if (to === "card" && !ms) return restore(card, parts), true;
  settleOwn(plot);
  const P = plot.getBoundingClientRect();
  if (!P.width || !plot.offsetWidth) return false;
  const u = plot.offsetWidth / P.width; // (screen px to the plot's own, whatever the flight's scale)
  const boxes = parts.map(({ el, at }) => {
    const r = el.getBoundingClientRect();
    const box = { x: (r.left - P.left) * u, y: (r.top - P.top) * u, w: r.width * u, h: r.height * u };
    if (at?.size != null) Object.assign(box, { font: parseFloat(getComputedStyle(el).fontSize), text: Math.min(el.scrollWidth, el.clientWidth) });
    return box;
  });
  unclip(card, parts);
  const dy = rowOffsets(parts, boxes);
  const o = { duration: ms, easing: EASE_IN_OUT.css, fill: "forwards" };
  parts.forEach(({ el, at, row }, i) => {
    const thumb = thumbForm(at, boxes[i], row == null ? 0 : dy(row));
    const keys = Object.keys(thumb.look);
    const home = Object.fromEntries(keys.map((k) => [k, HOME[k]]));
    el._flyOrigin ??= el.style.transformOrigin;
    el.style.transformOrigin = thumb.origin;
    const from = was[i] && sameKeys(el._flyKeys, keys) ? was[i] : to === "card" ? thumb.look : home;
    const end = to === "card" ? home : thumb.look;
    let frames = [from, end];
    // What only the card has fades with its chrome: in by 40% of an open, out over the last 40% of a close
    const op = +from.opacity;
    if (!at && op === 0 && to === "card") frames = [from, { opacity: 1, offset: 0.4 }, end];
    else if (!at && op === 1 && to === "thumb") frames = [from, { opacity: 1, offset: 0.6 }, end];
    const a = el.animate(frames, o);
    a.id = ID;
    el._fly = a;
    el._flyKeys = keys;
  });
  // Landed as itself: the parts let go of their flight
  if (to === "card") {
    const last = parts.at(-1)?.el._fly;
    last?.finished.then(() => last === parts.at(-1).el._fly && restore(card, parts), () => {});
  }
  return true;
}
const sameKeys = (a, b) => a?.length === b.length && a.every((k, i) => k === b[i]);

// A thumbnail's shapes in the plot's px, for flyRows' `at`: ECharts `bar` series' rects and their labels' boxes,
// by series id and data index (each with its data name). u: the plot's px per thumbnail px.
export function thumbShapes(el, u) {
  const c = echarts.getInstanceByDom(el);
  const out = new Map();
  if (!c) return out;
  const scale = (b) => ({ x: b.x * u, y: b.y * u, w: b.width * u, h: b.height * u });
  c.getModel().eachSeries((s) => {
    const data = s.getData();
    const items = [];
    data.each((i) => {
      const g = data.getItemGraphicEl(i);
      const lay = data.getItemLayout(i);
      const bar = lay && scale({ x: Math.min(lay.x, lay.x + lay.width), y: Math.min(lay.y, lay.y + lay.height), width: Math.abs(lay.width), height: Math.abs(lay.height) });
      const t = g?.getTextContent?.();
      let label = null;
      if (t && !t.ignore && !t.invisible) {
        const b = t.getBoundingRect().clone();
        const m = t.getComputedTransform();
        if (m) b.applyTransform(m);
        label = { ...scale(b), size: (t.style?.fontSize ?? 12) * u };
      }
      items[i] = { name: data.getName(i), bar, label };
    });
    out.set(s.id, items);
  });
  return out;
}

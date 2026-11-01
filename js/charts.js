// ECharts renderers. Colors come from the CSS tokens so light/dark stay in one place (style.css).

import { FADE_MS, ENTER_MS, MORPH_MS, EASE_IN_OUT, EASE_OUT, drawnShapes, setOptionFaded, easeInOut, travel, dur } from "./motion.js";
import { MAX_PARTS } from "./aggregate.js";
import { shownName, putOff, owes } from "./state.js";
import { tune } from "./tune.js";

const instances = new Map();

function tokens() {
  // body, not the root: a chosen palette overrides the series colors there (see theme.js)
  const css = getComputedStyle(document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    surface: v("--surface"),
    primary: v("--text-primary"),
    secondary: v("--text-secondary"),
    muted: v("--text-muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    accent: v("--accent"),
    other: v("--other"),
    series: Array.from({ length: 10 }, (_, i) => i + 1).map((i) => v(`--series-${i}`)),
    seq: [0, 1, 2, 3, 4, 5].map((i) => v(`--seq-${i}`)),
    // Rolling chart fills, set per theme: the share of the artist's color mixed into the surface for a
    // band at rest, a hovered band, and the other bands while one is hovered; and the opacity under a
    // hovered hours line, and under a pinned one
    shade: { band: +v("--shade-band"), hover: +v("--shade-hover"), dim: +v("--shade-dim"), line: +v("--shade-line"), linePin: +v("--shade-line-pin") },
  };
}

function chart(el) {
  let c = instances.get(el);
  if (!c) {
    c = echarts.init(el, null, { renderer: "canvas" });
    instances.set(el, c);
    new ResizeObserver(() => c.resize()).observe(el);
  }
  return c;
}

// Theme changed: throw away instances so the next render picks up new tokens.
export function disposeAll() {
  for (const c of instances.values()) c.dispose();
  instances.clear();
}

// [startValue, endValue] of a chart's current zoom, so re-renders can keep the reader's place.
export function currentZoom(el) {
  const dz = instances.get(el)?.getOption()?.dataZoom?.[0];
  if (Number.isFinite(dz?.startValue)) return [dz.startValue, dz.endValue];
  // With every series hidden, ECharts reports the range as NaN; fall back to the last one the rolling
  // chart had
  return rollingState.get(el)?.zoom;
}

// Artist and track names come from user files: escape before they enter tooltip HTML.
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Blend two hex colors; w is the share of b
function mix(a, b, w) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v * (1 - w) + y[i] * w).toString(16).padStart(2, "0")).join("");
}

const fmtHours = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h.toFixed(1)) + " h";

function baseAxis(t) {
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.muted },
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
  };
}

function tooltipBase(t) {
  return {
    backgroundColor: t.surface,
    borderColor: t.grid,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: t.primary, fontSize: 13 },
    extraCssText: "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);",
  };
}

// Line-key row: value leads, label follows. `strong` picks out the row under the pointer.
const row = (color, value, label, strong = false) =>
  `<div style="display:flex;align-items:center;gap:8px;line-height:1.6;${strong ? `background:${color}26;margin:0 -6px;padding:0 6px;border-radius:4px` : ""}">` +
  `<span style="width:12px;height:${strong ? 4 : 2}px;background:${color};border-radius:1px"></span>` +
  `<b style="min-width:3.5em">${value}</b><span style="${strong ? "font-weight:600" : "opacity:.75"}">${esc(label)}</span></div>`;

// A part's row (an album or song) under its artist's: indented and quieter
// (strong: the part under the pointer)
const subRow = (color, value, label, strong = false) =>
  `<div style="display:flex;align-items:center;gap:8px;line-height:1.5;padding-left:20px;font-size:12px;${strong ? `background:${color}66;margin:0 -6px;padding-right:6px;padding-left:26px;border-radius:4px` : ""}">` +
  `<span style="width:8px;height:8px;background:${color};border-radius:2px"></span>` +
  `<b style="min-width:3.5em;font-weight:500">${value}</b><span style="${strong ? "font-weight:600" : "opacity:.75"}">${esc(label)}</span></div>`;

// Legend selections per rolling chart, kept across morphs and reset when the artist list changes.
const rollingState = new WeakMap();

// Called with the name of the artist lit in a rolling chart (or null) whenever that changes, whatever
// lit it (the plot, a legend, a list); lets other parts of the page follow the highlight.
const focusHooks = new WeakMap();
export const onFocusChange = (el, fn) => focusHooks.set(el, fn);
// fn runs whenever the chart's zoom range changes, however it got there
const zoomHooks = new Map();
export const onZoomChange = (el, fn) => zoomHooks.set(el, fn);

// Called with the artists hidden in a rolling chart's legend after every render, so the rest of the page
// can leave them out. It fires on each render, so a reset to all shown is reported too.
const selectionHooks = new WeakMap();
export const onSelectionChange = (el, fn) => selectionHooks.set(el, fn);
// The artists hidden in each rolling chart, by name, so a hidden artist stays hidden while the artist list changes
// (moving the period, changing the count), even if they drop out of it for a while
const hiddenNames = new WeakMap();

const artistsOf = (names, hasOther) => (hasOther ? names.slice(0, -1) : names);

// Series ids belong to an artist, not a rank: each name a chart has drawn keeps its number for good (per chart), and
// its band or line is s<n>, its outlines t<n> and b<n>, its parts p<n>_<j>. A merge then tweens each artist's own band
// or line from where it was to where it goes, however the artists are re-ranked, rather than morphing one into another.
const seriesNums = new WeakMap(); // el → Map name → n
function seriesNum(el, name) {
  let m = seriesNums.get(el);
  if (!m) seriesNums.set(el, (m = new Map()));
  if (!m.has(name)) m.set(name, m.size);
  return m.get(name);
}

// A rolling chart's hours strip: a second chart (the Hours per week card), drawn in hours mode from the same
// artists, that follows every render, zoom and hover of the main one (and lights the main one when hovered).
// The main chart holds the legend selection and the pins; the strip copies them on each render.
const stripOf = new WeakMap();
const mainOf = new WeakMap();
export function linkStrip(el, strip) {
  stripOf.set(el, strip);
  mainOf.set(strip, el);
}
let relaying = false; // a hover passed from one to the other isn't passed back
// The hours axis top for the zoom range: the tallest shown line in it, in whole hours
function hoursTop(data, names, window, hasOther, hide, zoom) {
  let m = 0;
  // The range's points and the one just past each end, which ECharts' filtering keeps (and scales to)
  const a = Math.max(0, data.dates.findLastIndex((d) => d < zoom[0]));
  const b = data.dates.findIndex((d) => d > zoom[1]);
  names.forEach((n, s) => {
    if (hasOther && s === names.length - 1) return;
    if (hide?.[n] === false) return;
    for (let i = a; i <= (b < 0 ? data.dates.length - 1 : b); i++) {
      if (data.share[s][i] != null) m = Math.max(m, (data.hours[s][i] / window) * 7);
    }
  });
  return Math.max(1, Math.ceil(m));
}

// Series can't tween in or out of existence, so "Everyone else" arrives and leaves as a band that grows
// from, or shrinks to, zero thickness on top of the stack. Returns true if it handled this render (share
// mode, same artists and window, "Everyone else" newly on or off), false for a plain render.
//  - On: draw the old data with a zero-thickness band added (instantly), then morph to the new data.
//  - Off: morph the new data with a zero-thickness band kept on top, then redraw without it.
function withOtherMorph(el, data, names, window, zoom, mode, hasOther, ms, pins, slots, smooth) {
  const st = rollingState.get(el);
  if (!st || mode !== "share" || st.mode !== "share" || st.hasOther === hasOther || st.window !== window) return false;
  if (artistsOf(st.names, st.hasOther).join("\u0000") !== artistsOf(names, hasOther).join("\u0000")) return false;
  if (!data.share.length) return false;
  const flat = (d) => ({
    ...d,
    share: [...d.share, d.dates.map((_, i) => (d.share[0][i] == null ? null : 0))],
    hours: [...d.hours, d.dates.map(() => 0)],
  });
  if (hasOther) {
    const [oldData, , , , , , , , oldSmooth] = st.args;
    renderRolling(el, flat(oldData), names, window, zoom, mode, true, false, pins, slots, oldSmooth);
    renderRolling(el, data, names, window, zoom, mode, true, ms, pins, slots, smooth);
  } else {
    renderRolling(el, flat(data), [...names, "Everyone else"], window, zoom, mode, true, ms, pins, slots, smooth);
    const was = rollingState.get(el), token = was.renderToken;
    setTimeout(() => {
      if (rollingState.get(el) !== was || was.renderToken !== token) return; // something re-rendered since
      renderRolling(el, data, names, window, currentZoom(el), mode, false, false, pins, slots, smooth);
    }, ms);
  }
  return true;
}

// Turning the split on or off (data.parts arriving or leaving, with the same artists, window and mode). The parts'
// series exist only while split, so they swell up from each band's floor, from no thickness, and shrink back
// down to it before they go.
function withSplitMorph(el, data, names, window, zoom, mode, hasOther, ms, pins, slots, smooth) {
  const st = rollingState.get(el);
  if (!st || st.mode !== mode || st.hasOther !== hasOther || st.window !== window || st.names.join("\u0000") !== names.join("\u0000")) return false;
  const [oldData] = st.args;
  if (!!oldData.parts === !!data.parts || oldData.dates.length !== data.dates.length) return false;
  const full = data.parts ? data : { ...data, parts: oldData.parts };
  const zero = (rows) => rows.map((list) => list.map((row) => row.map((v) => (v == null ? null : 0))));
  const flat = { ...full, parts: { ...full.parts, share: zero(full.parts.share), hours: zero(full.parts.hours) } };
  const draw = (d, morph) => renderRolling(el, d, names, window, currentZoom(el) ?? zoom, mode, hasOther, morph, pins, slots, smooth);
  if (data.parts) {
    draw(flat, false);
    draw(data, ms);
  } else {
    draw(flat, ms);
    const was = rollingState.get(el), token = was.renderToken;
    setTimeout(() => rollingState.get(el) === was && was.renderToken === token && draw(data, false), ms); // unless re-rendered since
  }
  return true;
}

// Each zoom step of a drag or a pan is a plain redraw. ECharts' animation is switched off for them, not just given no
// duration: with it on, every step still diffs each series' old and new points for a tween of no length (~150 ms a
// step at all time). A morph in flight lands where it was going, as a zero-length tween left it; fades
// (setOptionFaded) carry on. The next render switches the animation back on.
function stillChart(c, st) {
  if (st?.still) return;
  if (st?.tweens) for (const e of drawnShapes(c).values()) e.stopAnimation("update", true);
  c.setOption({ animation: false });
  if (st) {
    st.still = true;
    st.tweens = false;
  }
}

// A change of artists (a pin from outside the chart, the artist count, a new period's, a dragged period window's) as
// things coming and going. Each artist has its own series (seriesNum), but a series can't tween in or out of
// existence, so the change is drawn on the union of the old and new artists, in up to three steps:
//  1. The old picture again, in the old order, with the newcomers added (instantly, so nothing moves): with no
//     thickness (share), or drawn at their final values but clipped away to the plot's left edge (hours).
//  2. The morph, in the new order with the leavers kept: share bands grow from no thickness, shrink to none, or
//     travel to their new place in the stack (see strips); hours lines that arrive draw in from left to right
//     (paintReveals) while those that leave sink to 0 and fade out, and the rest move to their new values.
//  3. Once it's done, the new artists alone (instantly, the same picture).
// Step 1 is skipped when there are no newcomers. An interrupted change starts from where its bands had got to
// (flightData), so a dragged artist count keeps up. A live morph (a dragged period window) has no step 1: its
// newcomers grow from nothing as it moves (see liveFrom).
// Returns true if it handled this render.
let artistCtx = null; // set while those steps draw: { report, strip, fade, leaving, yMax, real } (see renderRolling)
const SEP = "\u0000";
// `base` in its own order, with each of `extra` (in `ref`'s order) placed among them: just after the last of `base`
// that comes before it in `ref` (after = true), or just before the first that comes after it. Placing the newcomers
// one way and the leavers the other gives both steps the same order when the artists who stay keep theirs.
function weave(base, extra, ref, after) {
  const out = [...base];
  const inBase = new Set(base);
  const list = after ? extra : [...extra].reverse();
  for (const n of list) {
    const r = ref.indexOf(n);
    if (after) {
      let k = r - 1;
      while (k >= 0 && !inBase.has(ref[k])) k--;
      const at = k < 0 ? 0 : out.indexOf(ref[k]) + 1;
      // past the extras already placed there, so they keep ref's order
      let p = at;
      while (p < out.length && !inBase.has(out[p])) p++;
      out.splice(p, 0, n);
    } else {
      let k = r + 1;
      while (k < ref.length && !inBase.has(ref[k])) k++;
      const at = k >= ref.length ? out.length : out.indexOf(ref[k]);
      out.splice(at, 0, n);
    }
  }
  return out;
}
function withArtistMorph(el, data, names, window, zoom, mode, hasOther, morph, pins, slots, smooth) {
  const st = rollingState.get(el);
  if (!morph || morph.pan || artistCtx || !st?.args || !data.share.length) return false;
  if (st.mode !== mode || st.hasOther !== hasOther || st.window !== window) return false;
  // (the leavers a live morph keeps while they shrink aren't part of what it went to; a newer one lets them go)
  const shown = st.real ?? st.names;
  const A = artistsOf(shown, hasOther), B = artistsOf(names, hasOther);
  if (A.join(SEP) === B.join(SEP) && shown.length === st.names.length) return false;
  const { ms: rawMs, easing = EASE_IN_OUT.echarts, live } = typeof morph === "object" ? morph : { ms: morph === true ? MORPH_MS : morph };
  const ms = dur(rawMs);
  const oldData = flightData(st) ?? st.args[0];
  if (!ms || oldData.dates.length !== data.dates.length || !!oldData.parts !== !!data.parts) return false;
  const inA = new Set(A), inB = new Set(B);
  const share = mode === "share";
  const arrivals = B.filter((n) => !inA.has(n));
  const leavers = A.filter((n) => !inB.has(n));
  const other = hasOther ? ["Everyone else"] : [];
  const before = [...weave(A, arrivals, B, false), ...other]; // step 1: the old order, newcomers among it
  const after = [...weave(B, leavers, A, true), ...other]; // step 2: the new order, leavers among it
  const iOld = new Map(st.names.map((n, i) => [n, i]));
  const iNew = new Map(names.map((n, i) => [n, i]));
  const oldSlots = st.args[7];
  const slotsOf = (list) => list.map((n) => (iNew.has(n) ? slots?.[iNew.get(n)] : oldSlots?.[iOld.get(n)]));
  const zero = (row) => row.map((v) => (v == null ? null : 0));
  // Each artist's rows from the old data (step 1) or the new (step 2); whoever isn't in that one gets none
  const build = (list, old) => {
    const pick = (o, f, n, flat) => {
      const has = old ? iOld.has(n) : iNew.has(n);
      const row = has === old ? o[iOld.get(n)] : f[iNew.get(n)];
      return !has && flat ? (Array.isArray(row?.[0]) ? row.map(zero) : row && zero(row)) : row;
    };
    const rows = (key, flat) => list.map((n) => pick(oldData[key], data[key], n, flat));
    const partRows = (key) => list.map((n) => pick(oldData.parts[key], data.parts[key], n, true));
    // Share: whoever isn't in the picture has no thickness. Hours: a newcomer is drawn at its values (clipped
    // away until it draws in), a leaver lies on 0 (fading out)
    return {
      ...data,
      share: rows("share", share || !old),
      hours: rows("hours", share || !old),
      parts: data.parts && { ...data.parts, names: list.map((n) => pick(oldData.parts.names, data.parts.names, n, false)), share: partRows("share"), hours: partRows("hours") },
    };
  };
  // A live morph keeps the stack's order while the hand moves (newcomers among it, leavers kept where they are), so
  // nothing crosses mid-drag; the bands take their new order in one morph once it rests (below)
  const list = live ? before : after;
  const from = build(before, true), to = build(list, false);
  const c = instances.get(el);
  const outer = artistCtx;
  try {
    if (!share && arrivals.length) {
      const R = reveals.get(el) ?? new Map();
      reveals.set(el, R);
      const t0 = performance.now();
      for (const n of arrivals) R.set(n, { t0, ms, ease: easeFn(easing) });
    }
    if (arrivals.length && !live) {
      const yMax = share ? null : c?.getModel().getComponent("yAxis", 0)?.axis.scale.getExtent()[1];
      // Lines already leaving when this change interrupted the last one carry on gone
      const fade = new Set(st.flight?.fade ?? []);
      artistCtx = { report: B, strip: null, fade, yMax: Number.isFinite(yMax) ? yMax : null };
      renderRolling(el, from, before, window, currentZoom(el) ?? zoom, mode, hasOther, false, pins, slotsOf(before), st.args[8]);
    }
    const real = live ? list.filter((n) => !leavers.includes(n)) : null;
    artistCtx = { report: B, strip: { data, names, slots }, fade: share ? null : new Set(leavers), leaving: new Set(leavers), real };
    renderRolling(el, to, list, window, zoom, mode, hasOther, live ? morph : { ms, easing }, pins, slotsOf(list), smooth);
  } finally {
    artistCtx = outer;
  }
  const now = rollingState.get(el);
  // (what the morph started from, in step 2's order; a live morph carries on from what's on screen by itself)
  if (!live) now.flight = { names: after.join(SEP), from: build(after, true), to, t0: performance.now(), ms, fade: share ? [] : leavers };
  now.final = [data, names, slots];
  if (list.join(SEP) !== names.join(SEP)) {
    const token = now.renderToken;
    setTimeout(() => {
      const st = rollingState.get(el);
      // (a change of artists gives the chart a new state, whose count starts afresh)
      if (st !== now || st.renderToken !== token) return; // something re-rendered since
      // The same picture with the new artists alone (after a live morph, the bands moving into their new order);
      // whatever's under the pointer stays lit
      artistCtx = live ? null : { report: B, strip: null };
      st.keepFocus = st.focused;
      try {
        renderRolling(el, data, names, window, currentZoom(el) ?? zoom, mode, hasOther, live && dur(MORPH_MS), pins, slots, smooth);
      } finally {
        artistCtx = outer;
        st.keepFocus = null;
        const fresh = rollingState.get(el);
        if (fresh) fresh.keepFocus = null;
      }
    }, ms);
  }
  return true;
}

const easeFn = (name) => (name === EASE_IN_OUT.echarts ? easeInOut : name === EASE_OUT.echarts ? EASE_OUT.js : (x) => x);

// The rows on screen now, partway through an artist change: each band's values blended along the morph's curve, so
// a change that interrupts it starts from what's drawn rather than from where it was going
function flightData(st) {
  const F = st.flight;
  if (!F || F.names !== st.names.join(SEP)) return null;
  const p = (performance.now() - F.t0) / F.ms;
  if (!(p < 1)) return null;
  const e = easeInOut(Math.max(0, p));
  const lerp = (a, b) =>
    !a || !b || a.length !== b.length ? b ?? a : Array.isArray(a[0]) ? a.map((r, j) => lerp(r, b[j])) : a.map((v, i) => (v == null || b[i] == null ? v : v + (b[i] - v) * e));
  const rows = (a, b) => a.map((r, k) => lerp(r, b[k]));
  const { from, to } = F;
  return {
    ...to,
    share: rows(from.share, to.share),
    hours: rows(from.hours, to.hours),
    parts: to.parts && { ...to.parts, share: rows(from.parts.share, to.parts.share), hours: rows(from.parts.hours, to.parts.hours) },
  };
}

// Hours lines drawing in from left to right (an artist arriving): each one's line and fill are clipped to a rect
// that grows across the plot along the morph's curve. Kept per chart by artist, so a re-render partway (which can
// replace the shapes) clips the new ones at the same point and the line carries on drawing in. Reaches into
// ECharts internals like setOptionFaded.
const reveals = new WeakMap(); // el → Map artist → { t0, ms, ease }
function paintReveals(el, c) {
  const R = reveals.get(el);
  if (!R?.size) return;
  cancelAnimationFrame(R.raf);
  const rect = c.getModel().getComponent("grid", 0)?.coordinateSystem?.getRect();
  const now = performance.now();
  const PAD = 8; // past the plot's edges, so line caps and strokes aren't cut
  for (const m of c.getModel().getSeries()) {
    if (m.id[0] !== "s" || !R.has(m.name)) continue;
    const r = R.get(m.name);
    const p = Math.min(1, (now - r.t0) / r.ms);
    const view = c.getViewOfSeriesModel(m);
    for (const shape of [view?._polyline, view?._polygon]) {
      if (!shape) continue;
      if (p >= 1 || !rect) {
        if (shape.__reveal) shape.removeClipPath();
        shape.__reveal = null;
        continue;
      }
      if (!shape.__reveal || shape.getClipPath() !== shape.__reveal) {
        shape.__reveal = new echarts.graphic.Rect({ shape: { x: rect.x - PAD, y: rect.y - rect.height, width: 0, height: rect.height * 3 } });
        shape.setClipPath(shape.__reveal);
      }
      shape.__reveal.setShape({ width: (rect.width + 2 * PAD) * r.ease(p) });
      shape.markRedraw();
    }
  }
  for (const [n, r] of R) if (now - r.t0 >= r.ms) R.delete(n);
  if (R.size) R.raf = requestAnimationFrame(() => paintReveals(el, c));
}

// Strips: share mode's bands are each filled down to the axis, the lower ones painted over the higher, which only
// works while the stack keeps its order. When it re-orders (the artists who stay ranked anew), each band's polygon
// gets a floor of its own for the morph, travelling from where its floor was to where it goes along the same curve
// as its top, so every band moves as a strip of its own thickness to its new place rather than being uncovered or
// buried by its neighbours' fills. The floor is a getter on the polygon's shape (stackedOnPoints, the polygon's lower
// edge), worked out once a frame from the floors' values (st.bottoms) and the x positions ECharts has laid out; the
// edge lines' clips read it too. Reaches into ECharts internals like setOptionFaded. A band with no floor to start
// from (a newcomer) starts from its new one.
function reordered(a, b) {
  const inA = new Set(a), inB = new Set(b);
  return a.filter((n) => inB.has(n)).join(",") !== b.filter((n) => inA.has(n)).join(",");
}
// The floors on screen now, per series id: partway from where the last render's morph started to where it went
// (st.floors: { from, at }), so a morph that interrupts one in flight starts from what's drawn
function shownBottoms(st) {
  const F = st?.floors;
  if (!st?.bottoms || !F?.from) return st?.bottoms ?? null;
  const e = Math.min(1, F.at());
  if (e >= 1) return st.bottoms;
  return new Map([...st.bottoms].map(([id, b]) => {
    const a = F.from.get(id) ?? b;
    return [id, b.map((v, i) => a[i] + (v - a[i]) * e)];
  }));
}
function endStrips(st) {
  const S = st?.strip;
  if (!S) return;
  cancelAnimationFrame(S.raf);
  for (const poly of S.polys) poly.__strip?.restore();
  if (S.back) S.back.__zr?.remove(S.back);
  // the outlines come back as the bands settle
  for (const [line, opacity] of S.edges) line.animateTo({ style: { opacity } }, { duration: dur(FADE_MS), easing: EASE_OUT.echarts, scope: "strip" });
  st.strip = null;
}
// below: band id → the band id under it in the new stack. A band's floor never rises above that band's top as drawn
// now, or two bands crossing would leave a stretch between them that no band covers.
// (Above the stack, the bands' tops travelling each on its own can stop short of 100% for a moment; a backdrop in the
// tint of the band that ends on top (topId, topFill) fills that, behind every band, where they have data.)
function installStrips(c, st, from, at, below, topId, topFill) {
  const S = (st.strip = { from, to: st.bottoms, at, polys: [], frame: 0 });
  const views = new Map(c.getModel().getSeries().map((m) => [m.id, c.getViewOfSeriesModel(m)]));
  const roof = views.get(topId)?._polygon;
  if (roof && topFill) {
    const back = new roof.constructor({ z: 1, silent: true, style: { fill: topFill } });
    back.shape = {
      get points() {
        const pts = roof.shape.points;
        const y1 = c.convertToPixel({ yAxisIndex: 0 }, 1);
        const out = new Float32Array(pts.length);
        for (let i = 0; i < pts.length; i += 2) {
          out[i] = pts[i];
          out[i + 1] = Number.isFinite(pts[i + 1]) ? y1 : NaN;
        }
        return out;
      },
      get stackedOnPoints() { return roof.shape.stackedOnPoints; },
      smooth: 0,
      stackedOnSmooth: 0,
    };
    back.isZeroArea = () => false;
    c.getZr().add(back);
    S.back = back;
  }
  for (const m of c.getModel().getSeries()) {
    const b = S.to.get(m.id);
    const poly = b && c.getViewOfSeriesModel(m)?._polygon;
    if (!poly) continue;
    const a = from.get(m.id) ?? b;
    let base = poly.shape.stackedOnPoints, cache = null, cacheAt = -1, cachePts = null;
    const compute = () => {
      const pts = poly.shape.points;
      const d = m.getData();
      const n = d.count();
      if (!pts || pts.length !== n * 2 || !base || base.length !== n * 2) return base;
      const e = S.at();
      const y0 = c.convertToPixel({ yAxisIndex: 0 }, 0);
      const dy = c.convertToPixel({ yAxisIndex: 0 }, 1) - y0;
      const out = new Float32Array(n * 2);
      const under = views.get(below.get(m.id))?._polygon?.shape.points;
      const cap = under?.length === n * 2 ? under : null;
      for (let i = 0; i < n; i++) {
        const r = d.getRawIndex(i);
        const v = a[r] + (b[r] - a[r]) * e;
        out[2 * i] = pts[2 * i];
        // (pixels run downward: the lower of the two floors is the larger y)
        const y = Number.isFinite(v) ? y0 + dy * v : base[2 * i + 1];
        out[2 * i + 1] = cap && Number.isFinite(cap[2 * i + 1]) ? Math.max(y, cap[2 * i + 1]) : y;
      }
      return out;
    };
    Object.defineProperty(poly.shape, "stackedOnPoints", {
      configurable: true,
      enumerable: true,
      get() {
        if (cacheAt !== S.frame || cachePts !== poly.shape.points || !cache) {
          cache = compute();
          cacheAt = S.frame;
          cachePts = poly.shape.points;
        }
        // a copy: zrender's animator may write a tween into the array it reads
        return cache?.slice();
      },
      set(v) {
        base = v;
        cache = null;
      },
    });
    poly.__strip = {
      restore() {
        delete poly.shape.stackedOnPoints;
        poly.shape.stackedOnPoints = base;
        poly.__strip = null;
        poly.markRedraw();
      },
    };
    S.polys.push(poly);
  }
  // Outlines fade while the bands slide: drawn over everything, they'd cross the bands a moving one passes over
  S.edges = [];
  for (const id of S.to.keys()) {
    if (id[0] !== "s") continue;
    for (const side of ["t", "b"]) {
      const line = views.get(side + id.slice(1))?._polyline;
      if (!line) continue;
      S.edges.push([line, line.style.opacity ?? 1]);
      line.animateTo({ style: { opacity: 0 } }, { duration: dur(FADE_MS), easing: EASE_OUT.echarts, scope: "strip" });
    }
  }
  const tick = () => {
    if (st.strip !== S) return;
    S.frame++;
    for (const poly of S.polys) poly.markRedraw();
    S.back?.markRedraw();
    if (S.at() < 1) S.raf = requestAnimationFrame(tick);
    else endStrips(st);
  };
  S.raf = requestAnimationFrame(tick);
}

// Shows [start, end] (dates) of the rolling chart's timeline right now, without redrawing the series
export function setZoom(el, [start, end]) {
  const c = instances.get(el);
  if (!c) return;
  const st = rollingState.get(el);
  // The range follows the reader's hand, so it mustn't tween behind it
  stillChart(c, st);
  c.dispatchAction({ type: "dataZoom", dataZoomIndex: 0, startValue: start, endValue: end });
  if (st?.live) paintLive(c, st); // the zoom redrew the new values; put the blend back before it's painted
  if (stripOf.has(el) && !owes(stripOf.get(el).closest(".card"))) setZoom(stripOf.get(el), [start, end]);
}

// A live morph (morph.live): new artists while the range is moving under the reader's hand, as in a drag
// of the period window. ECharts' own morph tweens points on screen, so every zoom step would restart it
// and the bands would trail the window. Instead the chart is drawn with the new data at once, and each
// frame every shape's points are moved back between the old values and the new ones, at x positions the
// zoom has just laid out. Values are kept per series id by data index (st.values), so a live morph
// interrupted by the next one carries on from what's on screen. Reaches into ECharts internals like
// setOptionFaded.
const liveEase = (t) => 1 - Math.pow(1 - t, 3); // starts quick, so a chain of interrupted morphs keeps up
const liveAt = (L, now = performance.now()) => liveEase(Math.min(1, (now - L.t0) / L.ms));

// The values on screen now, per series id
function liveValues(st) {
  if (!st?.live) return st?.values;
  const e = liveAt(st.live);
  return new Map([...st.live.to].map(([id, b]) => {
    const a = st.live.from.get(id);
    return [id, a ? b.map((v, i) => (Number.isNaN(v) || Number.isNaN(a[i]) ? v : a[i] + (v - a[i]) * e)) : b];
  }));
}

function stopLive(st) {
  if (!st?.live) return;
  cancelAnimationFrame(st.live.raf);
  st.live = null;
}

function paintLive(c, st) {
  const L = st.live;
  const e = liveAt(L);
  const y0 = c.convertToPixel({ yAxisIndex: 0 }, 0);
  const dy = c.convertToPixel({ yAxisIndex: 0 }, 1) - y0;
  for (const m of c.getModel().getSeries()) {
    const a = L.from.get(m.id), b = L.to.get(m.id);
    if (!a || !b) continue;
    const view = c.getViewOfSeriesModel(m);
    const d = m.getData();
    const n = d.count();
    for (const shape of [view?._polyline, view?._polygon]) {
      if (!shape) continue;
      // ECharts lays out a fresh points array on each update; keep it for its x positions
      if (shape.shape.points !== shape.__liveOut) shape.__liveFresh = shape.shape.points;
      const fresh = shape.__liveFresh;
      if (fresh?.length !== n * 2) continue;
      const out = new Float32Array(fresh);
      for (let i = 0; i < n; i++) {
        const r = d.getRawIndex(i);
        if (Number.isNaN(a[r]) || Number.isNaN(b[r]) || Number.isNaN(out[2 * i + 1])) continue;
        out[2 * i + 1] = y0 + dy * (a[r] + (b[r] - a[r]) * e);
      }
      shape.setShape({ points: out });
      shape.__liveOut = out;
    }
  }
}

// Moves the zoom range from `from` to `to` ([start, end] dates), a frame at a time like dragging the slider:
// a real scroll, or zoom if the span changes, of whatever is drawn. Calls `done` when it lands.
// yMax: optional { from, to } for the y-axis top (Hours mode), which tweens along with the range; otherwise
// it would step from one whole number to the next each time the window's tallest line changes.
// strip: optional { el, yMax } for the hours strip, which travels on the same clock
function panTo(el, from, to, { ms, easing, onFrame }, done, yMax, strip) {
  const c = chart(el);
  const st = rollingState.get(el);
  stillChart(c, st); // each frame is a plain redraw, not a tween
  const sc = strip && instances.get(strip.el);
  if (sc) stillChart(sc, rollingState.get(strip.el));
  st.panEnd = () => onFrame?.(1);
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    const e = easeInOut(t);
    onFrame?.(e);
    const [startValue, endValue] = travel(from, to, e);
    const step = (c, yMax) => {
      if (yMax) {
        const max = yMax.from + (yMax.to - yMax.from) * e;
        c.setOption({ yAxis: { max: () => max }, dataZoom: [{ startValue, endValue }] });
      } else c.dispatchAction({ type: "dataZoom", dataZoomIndex: 0, startValue, endValue });
    };
    step(c, yMax);
    if (sc) step(sc, strip.yMax);
    if (t < 1) st.panRaf = requestAnimationFrame(tick);
    else {
      st.panRaf = 0;
      done();
    }
  };
  st.panRaf = requestAnimationFrame(tick);
}

// mode "share": stacked bands of each artist's share of listening (the original rolling_window.py).
// mode "hours": the same artists as overlaid lines of hours per week.
//
// Both modes are the *same* series with the same ids; only their values and styles differ. That lets
// ECharts tween every point between the two (morph = true) instead of redrawing. To make that work the
// stacking is done here rather than with ECharts' `stack`: in share mode each series is the line at the
// top of its band (cumulative share) filled down to the axis, drawn top band first so lower bands paint
// over the bottom of higher ones. In hours mode the fills fade out and the lines move to hours per week.
// "Everyone else" flattens to zero and fades out in hours mode, where it would dwarf everyone.
//
// Share mode draws each band as a pale tint of the artist's color (t.shade.band), outlined on both edges
// by two silent overlay lines, its top (t) and bottom (b), drawn above every band and inset slightly so
// neighbors' borders sit side by side. Hours mode hides them.
//
// pins: optional { has(name), unpin(name), toggle(name) } for artists the reader pinned; clicking a band or
// line in the plot calls toggle.
// slots: optional palette slot per artist (aligned with names), so colors can follow the artist; by default
// an artist's color is their position.
// smooth: 0..1, how much each curve is rounded into a spline (the data itself is blurred by the caller).
//
// morph: false to redraw without animation, or true (or a duration in ms, or {ms, easing}) to tween from what's drawn to the
// new data, styles and smoothing. Switching "Everyone else" on or off morphs too, through a stand-in band
// of zero thickness (see withOtherMorph). {ms, live: true} morphs while the zoom range keeps moving (see
// paintLive); it needs the same mode, window and number of series, or it redraws.
export function renderRolling(el, data, names, window, zoom, mode = "share", hasOther = false, morph = false, pins = null, slots = null, smooth = 0) {
  // Any render ends a pan or a live morph in progress
  const prev = rollingState.get(el);
  if (prev?.panRaf) {
    cancelAnimationFrame(prev.panRaf);
    prev.panRaf = 0;
    if (!morph?.pan) prev.panEnd?.(); // whatever rides the pan lands with it (a newer pan carries on from where it was)
  }
  // New artists (a pin, the artist count, a new period's): they grow in and the leavers shrink away
  if (withArtistMorph(el, data, names, window, zoom, mode, hasOther, morph, pins, slots, smooth)) return;
  const liveFrom =
    morph?.live && prev?.mode === mode && prev.hasOther === hasOther && prev.window === window &&
    prev.values?.dates === data.dates.length ? liveValues(prev) : null;
  // The bands' bottoms on screen, for a re-ordering stack to start from (see strips), before anything stops
  const bottomsFrom = shownBottoms(prev);
  stopLive(prev);
  endStrips(prev);
  if (morph?.live && !liveFrom) morph = false;
  // A period change ({ms, easing, pan: true}) first scrolls (or zooms) the plot to the new range with the
  // artists already on screen, as if dragging the zoom slider, then morphs the bands into the new
  // period's artists. That needs the same series on screen; otherwise it redraws.
  if (morph?.pan) {
    // (the window can differ: switching to the tracks view changes it, and the pan is drawn with the old one)
    // (nor the artists: each keeps its own series, and a change of them comes and goes, see withArtistMorph)
    const same = prev && prev.mode === mode && prev.hasOther === hasOther;
    const from = same && currentZoom(el);
    // All time has no zoom range of its own; give it the whole timeline so there's a range to travel to
    if (same && !Number.isFinite(zoom?.[0]) && data.dates.length) zoom = [data.dates[0], data.dates[data.dates.length - 1]];
    if (Number.isFinite(from?.[0]) && Number.isFinite(zoom?.[0]) && (from[0] !== zoom[0] || from[1] !== zoom[1])) {
      // Hours: the axis top the final chart will have, to travel to alongside the range
      const travelMax = (el) => {
        const now = instances.get(el)?.getModel().getComponent("yAxis", 0)?.axis.scale.getExtent()[1];
        return Number.isFinite(now) ? { from: now, to: hoursTop(data, names, window, hasOther, prev.selected, zoom) } : null;
      };
      const strip = stripOf.get(el);
      panTo(el, from, zoom, morph, () => renderRolling(el, data, names, window, zoom, mode, hasOther, true, pins, slots, smooth),
        mode === "hours" ? travelMax(el) : null, strip && rollingState.get(strip) && !owes(strip.closest(".card")) && { el: strip, yMax: travelMax(strip) });
      return;
    }
    else morph?.onFrame?.(1); // no trip to make: whatever follows the pan lands at once
    morph = same;
  }
  const { ms, easing = EASE_IN_OUT.echarts } = morph && typeof morph === "object" ? morph : { ms: morph === true ? MORPH_MS : morph || 0 };
  if (ms && withOtherMorph(el, data, names, window, zoom, mode, hasOther, ms, pins, slots, smooth)) return;
  if (ms && withSplitMorph(el, data, names, window, zoom, mode, hasOther, ms, pins, slots, smooth)) return;
  const t = tokens();
  // (scaled by the tunables, see tune.js; all ×1 by default)
  t.shade = { band: t.shade.band * tune.bandTint, hover: t.shade.hover * tune.hoverTint, dim: t.shade.dim * tune.dimTint, line: t.shade.line * tune.lineFill };
  const c = chart(el);
  const share = mode === "share";
  const otherIdx = hasOther ? names.length - 1 : -1;
  // "Everyone else" is always gray, never borrowing the next artist's slot
  const colors = names.map((_, i) => (i === otherIdx ? t.other : t.series[slots?.[i] ?? i]));
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const isStrip = mainOf.has(el);
  // Each artist's series number (see seriesNum), and back from a series id to the artist's place in names
  const num = names.map((n) => seriesNum(el, n));
  const sid = (k, kind = "s") => `${kind}${num[k]}`;
  const placeOf = new Map(num.flatMap((n, k) => ["s", "t", "b"].map((kind) => [`${kind}${n}`, k])));
  const unfiltered = data.free && Number.isFinite(zoom?.[0]);
  const perWeek = (h) => (h / window) * 7;

  let st = rollingState.get(el);
  if (!st || st.names.join("\u0000") !== names.join("\u0000")) {
    // Keep the old pointer handlers' references, so they're removed below rather than left running
    // against the previous artists alongside the new ones
    const hidden = hiddenNames.get(el);
    // While every unpinned artist is hidden (the key's all box is off), artists who arrive (a new period, a
    // higher count) come in hidden too, so the box stays off. Pinned artists and everyone else are left alone.
    const was = st ? artistsOf(st.names, st.hasOther).filter((n) => !pins?.has(n)) : [];
    const allOff = was.length > 0 && was.every((n) => st.selected[n] === false);
    const fresh = (n, i) => allOff && i !== otherIdx && !st.names.includes(n) && !pins?.has(n);
    st = {
      names,
      selected: Object.fromEntries(names.map((n, i) => [n, !hidden?.has(n) && !fresh(n, i)])),
      zrMove: st?.zrMove,
      zrOut: st?.zrOut,
      // the hover carries on through a change of artists (see keepFocus below)
      focused: st?.focused,
      keepFocus: st?.keepFocus,
    };
    rollingState.set(el, st);
  }
  // An artist change in flight (withArtistMorph) is over once anything else draws
  if (!artistCtx) st.final = st.flight = null;
  st.real = artistCtx?.real ?? null; // (a live morph's leavers are kept at nothing, see withArtistMorph)
  st.hasOther = hasOther;
  st.window = window;
  st.args = [data, names, window, zoom, mode, hasOther, pins, slots, smooth];
  if (Number.isFinite(zoom?.[0])) st.zoom = zoom; // for currentZoom, if hiding every artist loses the range
  const visible = (s) => st.selected[names[s]] !== false;
  // Hours: a line leaving in an artist change (withArtistMorph) sinks to 0 and fades out as it goes
  // (kept for the restyles that come later, on hover, when the artist change's steps are done drawing)
  const fadeSet = artistCtx?.fade ?? null;
  const fading = (s) => !!fadeSet?.has(names[s]);
  // An artist leaving in that change (unpinned, say, and still hovered) lights nothing else's dimming as it goes
  const leavingSet = artistCtx?.leaving ?? null;
  const dims = (lit) => [...lit].some((k) => !leavingSet?.has(names[k]));

  // Cumulative share over visible series, rescaled by the visible total at each date so the bands always
  // fill the plot, as if the hidden artists had never played; a hidden series collapses onto the band below it
  const top = names.map(() => new Array(data.dates.length));
  const bottom = names.map(() => new Array(data.dates.length));
  const scale = new Array(data.dates.length).fill(1);
  for (let i = 0; i < data.dates.length; i++) {
    let sum = 0;
    for (let s = 0; s < names.length; s++) if (visible(s)) sum += data.share[s][i] ?? 0;
    scale[i] = sum > 0 ? 1 / sum : 0;
    let run = 0;
    for (let s = 0; s < names.length; s++) {
      const v = data.share[s][i];
      if (v == null) { top[s][i] = bottom[s][i] = null; continue; }
      bottom[s][i] = run;
      if (visible(s)) run += v * scale[i];
      top[s][i] = run;
    }
  }

  // Hours per week for artist s at date i. Where nothing at all was played in the window, share mode has
  // a gap (null); hours leaves the same gap rather than drawing 0, so a morph never tweens between a
  // gap and a value, which draws a vertical stroke at each such date mid-morph.
  // A hidden artist's line lies on 0 (and fades out, lineLook), so hiding it sinks it rather than snapping it away
  const hoursAt = (s, i) => (data.share[s][i] == null ? null : s === otherIdx || !visible(s) ? 0 : perWeek(data.hours[s][i]));

  // Each artist's parts (data.parts: its albums or songs, see agg.rolling), in MAX_PARTS slots per band. In
  // share mode they stack up from the band's floor, biggest first, and the band's own fill above them is the
  // rest; a slot with no part (or a hidden artist's) has no thickness. In hours mode each is a thin line.
  const parts = data.parts;
  const partRows = (k) => parts?.share[k] ?? [];
  const partKeys = parts ? names.flatMap((_, k) => (k === otherIdx ? [] : Array.from({ length: MAX_PARTS }, (_, j) => [k, j]))) : [];
  const partTop = names.map((_, k) => {
    if (!parts || k === otherIdx) return [];
    const rows = partRows(k);
    const out = [];
    let run = bottom[k];
    for (let j = 0; j < MAX_PARTS; j++) {
      const row = rows[j];
      run = run.map((b, i) => (b == null ? null : Math.min(top[k][i], b + (row && visible(k) ? (row[i] ?? 0) * scale[i] : 0))));
      out.push(run);
    }
    return out;
  });
  const partHoursAt = (k, j, i) => (data.share[k][i] == null ? null : j < partRows(k).length ? perWeek(parts.hours[k][j][i]) : 0);
  // A series' points as one flat typed array (date, value, date, value…; a gap is NaN). setOption deep-copies
  // its option but passes typed arrays through, so a sweep's every step doesn't copy and collect tens of
  // thousands of [date, value] pairs.
  const points = (y) => {
    const out = new Float64Array(data.dates.length * 2);
    for (let i = 0; i < data.dates.length; i++) {
      out[2 * i] = data.dates[i];
      out[2 * i + 1] = y(i) ?? NaN;
    }
    return out;
  };

  // Share mode outlines every band on both edges in its own color, so at each boundary the two neighbors
  // each show their own border rather than one artist's line standing for both. Each edge line is drawn
  // at twice its visible width, centered on the boundary, then clipped to its own band (clipEdges below):
  // only its inner half shows, so borders keep one width everywhere, even on steep slopes, and meet
  // neighbors' exactly on the boundary. A band too thin to see clips its edges away with it, so absent
  // artists leave no line. Edges break only where the band does (nothing played in the window), in both
  // modes: matching the band's gaps exactly keeps an edge locked to its band through a morph, which
  // ECharts tweens point by point, and a break never tweens into a value (a vertical stroke).
  const edgeData = (s, side) =>
    points((i) => (bottom[s][i] == null ? null : !share ? hoursAt(s, i) : side === "t" ? top[s][i] : bottom[s][i]));
  // Visible widths 1.5px, or 2.5px for lit bands (tune.edgeWidth, and 1 more), doubled since half is clipped away;
  // hours mode hides them
  const overlayStyle = (s, on) => ({ width: 2 * (on ? tune.edgeWidth + 1 : tune.edgeWidth), color: colors[s], opacity: share && visible(s) ? 1 : 0, cap: "butt", join: "round" });

  // The artists drawn highlighted: the pinned ones, plus the one under the pointer (or hovered in the
  // legend or a list) while there is one. Built into the options below as well as applied on hover, so
  // a re-render or a mode morph keeps the pinned artists lit.
  const base = new Set(names.flatMap((n, k) => (pins?.has(n) && visible(k) && k !== otherIdx ? [k] : [])));
  // The artist under the pointer when a click to pin or unpin re-rendered the chart stays lit from the first
  // frame (see zrClick), rather than snapping to rest and fading back in, as does one unpinned anywhere on the
  // page (holdFocus)
  const kept = st.keepFocus == null ? -1 : names.indexOf(st.keepFocus);
  const shown = kept < 0 ? base : new Set([...base, kept]);
  // Fills are opaque tints, not transparency, because bands overlap down to the axis.
  // Share: lit bands (pinned, or under the pointer) are filled in more strongly (t.shade.hover), and while
  // any band is lit the rest dim slightly (t.shade.dim); with none lit, every band has its resting tint
  const bandFill = (k, lit) =>
    mix(t.surface, colors[k], lit.has(k) ? t.shade.hover : dims(lit) ? t.shade.dim : t.shade.band);
  // Hours: pinned lines are thicker; lit lines (pinned or hovered) stay while the rest fade, and only a lit line gets a faint fill. The fill is the same
  // tint as a lit share band, at the opacity that gives t.shade.line of the artist's color (t.shade.linePin, deeper,
  // under a pinned line: hover shades, a pin deepens it). Sharing the color means a morph only changes opacity:
  // tweening a band's opaque tint to the artist's full color at low opacity would pass through a stronger fill than either end.
  const hoursFill = colors.map((c) => mix(t.surface, c, t.shade.hover));
  const hoursFillOpacity = t.shade.line / t.shade.hover;
  const hoursPinOpacity = t.shade.linePin / t.shade.hover;
  // (a line leaving in an artist change, fading, has none)
  const hoursArea = (k, lit) =>
    k === otherIdx || fading(k) || !lit.has(k) ? 0 : base.has(k) ? hoursPinOpacity : hoursFillOpacity;
  // Morphing from share to hours, a pinned artist's fill waits until the lines have settled. Its share
  // band fills all the way down to the axis, hidden under the bands below; fading only partway while
  // theirs fade out would bare it across the whole chart mid-morph. It fades out with them and back in
  // once the morph is done (below).
  const holdFill = morph && !share && st.mode === "share";
  const renderToken = (st.renderToken = (st.renderToken ?? 0) + 1);
  const restWidth = isStrip ? tune.hoursLine : 2; // the strip's lines are finer
  // Hover only shades a line (the others fade and it gets its faint fill); only a pin thickens it
  // The rest fade less for a hover (HOVER_DIM) than while an artist is pinned (PIN_DIM): a hover only glances at a line
  const PIN_DIM = 0.2, HOVER_DIM = 0.5;
  const lineLook = (k, lit) => ({
    width: base.has(k) ? restWidth + 1 : restWidth,
    opacity: (!share && k === otherIdx) || !visible(k) || fading(k) ? 0 : lit.has(k) || !dims(lit) ? 1 : base.size ? PIN_DIM : HOVER_DIM,
  });
  // Every artist always shows all its parts; lighting some artists (pinned or hovered) only dims the others'
  const partShown = (k, j) => !!parts && visible(k) && j < partRows(k).length;
  // The part under the pointer ({k, j}, or null): filled deeper than its siblings and outlined on both sides
  let hotPart = null;
  const isHot = (k, j) => hotPart?.k === k && hotPart.j === j;
  // A part's shade: the band's own tint w, deepened by part of the step from a resting band to a lit one, most
  // for the biggest part (and less in a dimmed band)
  const PART_DEPTH = [0.8, 0.55, 0.35, 0.18];
  const HOT_DEPTH = 1.6;
  const partShade = (k, j, w, depth = PART_DEPTH[j]) =>
    mix(t.surface, colors[k], Math.min(1, w + (t.shade.hover - t.shade.band) * depth * tune.partDepth * Math.min(1, w / t.shade.band)));
  const partFill = (k, j, lit) =>
    !partShown(k, j)
      ? bandFill(k, lit)
      : partShade(k, j, lit.has(k) ? t.shade.hover : lit.size ? t.shade.dim : t.shade.band, isHot(k, j) ? HOT_DEPTH : PART_DEPTH[j]);
  // Its divider (share), or its line (hours): faint beside its artist's, and fainter while others are lit
  // (the hot part's own divider and the one below it, its outline; a line, in hours mode)
  const partLine = (k, j, lit) => {
    const hot = isHot(k, j) || (share && isHot(k, j + 1));
    return {
      width: hot ? 2 : share ? 1 : base.has(k) ? 1.5 : 1.25,
      opacity: !partShown(k, j) ? 0 : hot ? 1 : share ? (lit.size && !lit.has(k) ? 0.3 : 0.7) : lit.size ? (lit.has(k) ? 0.85 : 0.08) : 0.4,
    };
  };
  const partStyles = (lit) =>
    partKeys.map(([k, j]) => ({
      id: `p${num[k]}_${j}`,
      lineStyle: partLine(k, j, lit),
      ...(share ? { areaStyle: { color: partFill(k, j, lit) } } : {}),
    }));

  const series = names
    .map((name, s) => {
      const hide = !share && s === otherIdx;
      return {
        id: sid(s),
        name,
        type: "line",
        showSymbol: false,
        symbol: "none",
        smooth,
        color: colors[s],
        // Lower bands paint over the bottom of the ones above them. That order has to be explicit:
        // ECharts paints series in the order their views were created, so artists added later (raising
        // the artist count) would otherwise paint over everything below them
        z: (share ? 2 : 3) + (names.length - s) / 100,
        // Share: hidden; the edge overlays draw each band's borders instead (see edgeData)
        lineStyle: {
          ...(share ? { width: 2, opacity: 0 } : lineLook(s, shown)),
          color: colors[s],
          cap: "round",
          join: "round",
        },
        // Every series ignores the pointer; the plot works out what's under it from the data (see zrMove).
        silent: true,
        // Hours mode keeps an invisible fill, so the hovered line's shading and the morph back into
        // bands can fade it in rather than have it appear
        areaStyle: {
          color: share ? bandFill(s, shown) : hoursFill[s],
          opacity: share ? 1 : !hide && !holdFill ? hoursArea(s, shown) : 0,
          origin: "start",
        },
        // Share mode: ECharts' hover emphasis clears itself on stacked areas, so bands are faded by
        // hand instead (see focusBand below). Hours mode: the series are silent, so this never fires; it keeps
        // the line's width, since hover only shades a line (focusLine) and only a pin thickens it.
        emphasis: share
          ? { disabled: true, areaStyle: null, lineStyle: null }
          : { disabled: false, focus: "series", areaStyle: null, lineStyle: null },
        blur: share
          ? { areaStyle: null, lineStyle: null }
          : { areaStyle: null, lineStyle: { opacity: hide ? 0 : 0.2 } },
        data: points((i) => (share ? top[s][i] : hoursAt(s, i))),
      };
    })
    // Top band first, matching the paint order above
    .reverse()
    .concat(
      // Each part paints over the band it's in, and over the parts above it, but under the band below
      partKeys.map(([k, j]) => ({
        id: `p${num[k]}_${j}`,
        name: names[k],
        type: "line",
        silent: true,
        showSymbol: false,
        symbol: "none",
        smooth,
        color: colors[k],
        z: share ? 2 + (names.length - k) / 100 + (MAX_PARTS + 1 - j) / 1000 : 2.9,
        lineStyle: { ...partLine(k, j, shown), color: colors[k], cap: "butt", join: "round" },
        // An empty slot's fill would only repeat its band's tint, so it isn't painted (it fades out as its part goes,
        // which looks the same as crossfading to the band's tint)
        areaStyle: { color: share ? partFill(k, j, shown) : hoursFill[k], opacity: share && partShown(k, j) ? 1 : 0, origin: "start" },
        emphasis: { disabled: true },
        data: points((i) => (share ? partTop[k][j][i] : partHoursAt(k, j, i))),
      }))
    )
    .concat(
      names.flatMap((name, s) =>
        ["t", "b"].map((side) => ({
          id: sid(s, side),
          name,
          type: "line",
          silent: true,
          showSymbol: false,
          symbol: "none",
          smooth,
          color: colors[s],
          z: 4,
          lineStyle: overlayStyle(s, shown.has(s)),
          areaStyle: null,
          emphasis: { disabled: true },
          data: edgeData(s, side),
        }))
      )
    );

  // The band (share) or line (hours) under the pointer, set by the mouse handlers below. A re-render starts
  // with nothing focused, so the page is told if something was (clicking to pin re-renders under the pointer),
  // or the highlights it drew for that artist would stay after the pointer leaves.
  let focused = kept < 0 ? null : kept;
  const tellFocus = (name, relay = true) => {
    st.focused = name;
    focusHooks.get(el)?.(name);
    // The main chart and its hours strip light the same artist
    const other = stripOf.get(el) ?? mainOf.get(el);
    if (!relay || relaying || !other) return;
    relaying = true;
    try {
      rollingState.get(other)?.focusArtist?.(name);
    } finally {
      relaying = false;
    }
  };
  // (a strip clicked to pin lights the main chart too, which drew first)
  if (st.focused != (kept < 0 ? null : names[kept])) tellFocus(kept < 0 ? null : names[kept], isStrip && kept >= 0);
  const sIdx = (p) => placeOf.get(p.seriesId);
  const bands = (params) => params.filter((p) => p.seriesId[0] === "s");
  // An artist's parts in the readout, under its row: every one drawn now that's at least PART_TIP_MIN of the
  // listening at that date (as the bands are scaled, in either mode). valueOf(j, ofArtist) gives the number
  // shown; ofArtist is true while the artist is pinned or hovered
  const PART_TIP_MIN = 0.01;
  const partTips = (k, i, valueOf, fmt, extra) => {
    if (!parts || k === otherIdx) return [];
    const on = lit();
    const ofArtist = on.has(k);
    return partRows(k)
      .map((_, j) => j)
      .filter((j) => partShown(k, j) && parts.share[k][j][i] * scale[i] >= PART_TIP_MIN)
      // In the order they're drawn: share mode stacks them up from the band's floor, so the top one comes first;
      // in hours mode the highest line does
      .sort((a, b) => (share ? b - a : valueOf(b) - valueOf(a)))
      .map((j) => subRow(partShade(k, j, t.shade.hover), fmt(valueOf(j, ofArtist)), parts.names[k][j] + extra(j), isHot(k, j)));
  };
  const shareTooltip = (params) => {
    params = bands(params);
    if (!params.length || !Number.isFinite(params[0].value[1])) return "";
    const i = params[0].dataIndex;
    const rows = params
      .filter((p) => visible(sIdx(p)))
      .map((p) => ({ p, share: data.share[sIdx(p)][i] * scale[i], hours: data.hours[sIdx(p)][i] }))
      // Drop anyone who would read as 0%
      .filter((r) => r.share >= 0.005)
      // Top band first, so the rows read in the same order as the bands under the pointer
      .sort((a, b) => sIdx(b.p) - sIdx(a.p))
      .flatMap((r) => [
        row(r.p.color, (r.share * 100).toFixed(0) + "%", `${shownName(r.p.seriesName)} · ${fmtHours(r.hours)}`, sIdx(r.p) === focused || base.has(sIdx(r.p))),
        // A part's percent is of everyone's listening, or of its artist's while the artist is pinned or hovered
        ...partTips(sIdx(r.p), i, (j, ofArtist) => parts.share[sIdx(r.p)][j][i] * (ofArtist ? 1 / data.share[sIdx(r.p)][i] : scale[i]),
          (v) => (v * 100).toFixed(0) + "%",
          (j) => ` · ${fmtHours(parts.hours[sIdx(r.p)][j][i])}`),
      ]);
    return `<div style="color:${t.muted};margin-bottom:4px">${window} days around ${fmtDate(params[0].value[0])}</div>${rows.join("")}`;
  };
  const hoursTooltip = (params) => {
    params = bands(params);
    if (!params.length) return "";
    const rows = params
      .filter((p) => sIdx(p) !== otherIdx && p.value[1] >= 0.05)
      .sort((a, b) => b.value[1] - a.value[1])
      .flatMap((p) => [
        row(p.color, `${p.value[1].toFixed(1)} h`, p.seriesName, sIdx(p) === focused || base.has(sIdx(p))),
        ...partTips(sIdx(p), params[0].dataIndex, (j) => perWeek(parts.hours[sIdx(p)][j][params[0].dataIndex]), (v) => `${v.toFixed(1)} h`, () => ""),
      ]);
    return `<div style="color:${t.muted};margin-bottom:4px">Hours per week, ${window} days around ${fmtDate(params[0].value[0])}</div>${rows.join("")}`;
  };

  st.mode = mode;

  // Clip each band's edge lines to the band itself, so only their inner halves show (see edgeData). The
  // clip is ECharts' own area polygon for the band, built from its top edge and the top edge of the
  // visible band below (or the axis). Its shape reads those edges live from the drawn shapes, and zrender
  // rebuilds a clip from its shape every time it draws the clipped line, so the clip follows the bands
  // through morphs, re-stacks and zoom-slider drags without lagging or dropping. The clips are re-linked
  // right after each update, before it's painted, in case ECharts replaced a shape or the stacking
  // changed; a line already linked to the same shapes is left alone. This reaches into ECharts internals
  // like setOptionFaded; without them the borders are just unclipped, twice as wide.
  //
  // Each edge's clip also reaches only partway into the band: half its thickness, less EDGE_GAP px. A
  // band too thin to hold two borders shows just its tint, rather than stacking its own borders against
  // its neighbors' into a rainbow, and its borders grow in as it thickens (a ramp along the band, which
  // morphs carry, since the clip reads the live shapes). Bands wider than about 8px look as before.
  const EDGE_GAP = 1.5;
  // `from` moved `dir` (+1 down, -1 up, in pixels) by how far its edge may reach into the band between roof and floor
  const inset = (from, roof, floor, dir) => {
    const out = new Float32Array(from.length);
    for (let i = 0; i < from.length; i += 2) {
      out[i] = from[i];
      const reach = Math.max(0, ((floor[i + 1] ?? NaN) - roof[i + 1]) / 2 - EDGE_GAP);
      out[i + 1] = from[i + 1] + dir * (Number.isFinite(reach) ? reach : 0);
    }
    return out;
  };
  const clipEdges = () => {
    if (!share) return;
    const shapes = drawnShapes(c);
    let below = null;
    for (let k = 0; k < names.length; k++) {
      if (!visible(k)) continue;
      const band = shapes.get(`${sid(k)}:area`);
      if (!band) continue;
      const floorBand = below == null ? null : shapes.get(`${sid(below)}:area`) ?? null;
      below = k;
      for (const side of ["t", "b"]) {
        const line = shapes.get(`${sid(k, side)}:line`);
        if (!line || (line.__clipOf?.[0] === band && line.__clipOf[1] === floorBand)) continue;
        const clip = new band.constructor({});
        const roof = () => band.shape.points;
        // (while the stack re-orders, the band's own bottom, which travels: see strips)
        const floor = () => (band.__strip || !floorBand ? band.shape.stackedOnPoints : floorBand.shape.points);
        clip.shape = {
          get points() { return side === "t" ? roof() : inset(floor(), roof(), floor(), -1); },
          get stackedOnPoints() { return side === "t" ? inset(roof(), roof(), floor(), 1) : floor(); },
          // Both sides round like the edge lines they cut, or with points far apart (a short period) the
          // curves bow past the straight chords and the borders show in slivers
          get smooth() { return band.shape.smooth; },
          get stackedOnSmooth() { return band.shape.smooth; },
          get smoothMonotone() { return band.shape.smoothMonotone; },
        };
        // zrender skips drawing a line whose clip has zero area, judged from a cached bounding box that a
        // live shape never refreshes; a band that's flat for a moment mustn't hide its border for good
        clip.isZeroArea = () => false;
        line.setClipPath(clip);
        line.__clipOf = [band, floorBand];
      }
    }
  };
  for (const ev of ["finished", "datazoom"]) {
    c.off(ev);
    c.on(ev, clipEdges);
  }
  c.on("datazoom", () => zoomHooks.get(el)?.());

  // What each series shows, by data index, for the next live morph to start from
  // (NaN where there's a gap, as in the series' points)
  st.values = new Map(series.map((s) => {
    const ys = new Float64Array(data.dates.length);
    for (let i = 0; i < ys.length; i++) ys[i] = s.data[2 * i + 1];
    return [s.id, ys];
  }));
  st.values.dates = data.dates.length;
  // Share: each band's (and part's) floor, the top of whatever is stacked under it, for strips
  st.bottoms = share ? new Map(names.flatMap((_, k) => {
    const row = (vals) => Float64Array.from(vals, (v) => v ?? NaN);
    return [[sid(k), row(bottom[k])], ...(partKeys.length && k !== otherIdx ? partTop[k].map((_, j) => [`p${num[k]}_${j}`, row(j ? partTop[k][j - 1] : bottom[k])]) : [])];
  })) : null;
  st.order = num.filter((_, k) => k !== otherIdx);
  // A live morph's newcomers grow from nothing: a band (its outlines and parts too) from the top of the band it sits
  // on as drawn now, so the stack stays whole; an hours line drawn in where it is (paintReveals)
  if (liveFrom) {
    const kOf = new Map(num.map((n, k) => [String(n), k]));
    for (const [id, ys] of st.values) {
      if (liveFrom.has(id)) continue;
      if (!share) {
        liveFrom.set(id, ys);
        continue;
      }
      let k = kOf.get(id[0] === "p" ? id.slice(1, id.indexOf("_")) : id.slice(1));
      let under = null;
      while (!under && --k >= 0) under = liveFrom.get(sid(k));
      liveFrom.set(id, under ?? ys.map((v) => (Number.isNaN(v) ? v : 0)));
    }
  }
  st.tweens = !liveFrom && ms > 0;
  st.still = !st.tweens; // (see stillChart)

  // An open tooltip still points at the series it was drawn from, and throws once one of them is removed
  if (morph) {
    const ids = new Set(series.map((x) => x.id));
    if (c.getModel()?.getSeries().some((m) => !ids.has(m.id))) c.dispatchAction({ type: "hideTip" });
  }
  setOptionFaded(
    c,
    {
      // No animation on first draw or data changes; only morphs between modes tween. Off altogether when nothing
      // tweens, or ECharts would still diff every series' points for a tween of no length (see stillChart)
      animation: st.tweens,
      animationDuration: 0,
      // A live morph moves the points itself (paintLive); its colors still fade
      animationDurationUpdate: liveFrom ? 0 : ms,
      animationEasingUpdate: easing,
      animationThreshold: 100000, // the default (2000 points) would silently disable the morph
      grid: { left: 48, right: 16, top: isStrip ? 14 : 12, bottom: 28 },
      // The key is HTML in the period bar (key.js paintArtistKey), and which artists are shown is st.selected. ECharts'
      // legend is hidden and shows every series: a hidden artist's is drawn with no thickness (share) or on 0 and faded
      // out (hours), so showing or hiding one morphs, where a legend-hidden series would vanish or appear in one frame
      legend: { show: false, data: names, selected: Object.fromEntries(names.map((n) => [n, true])) },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        // The readout covers every artist at the date; highlighting is only for the one under the pointer
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 }, triggerEmphasis: false },
        formatter: share ? shareTooltip : hoursTooltip,
      },
      // triggerEmphasis has to be off on the axis's own pointer too (the tooltip's alone isn't enough),
      // or every hover puts all the shapes in ECharts' highlight state, which breaks the hand-drawn focus
      axisPointer: { triggerEmphasis: false },
      // hideOverlap: a month's name (bold) can land beside a day's number; the day gives way
      xAxis: { type: "time", ...baseAxis(t), axisLabel: { color: t.muted, hideOverlap: true }, splitLine: { show: false }, axisPointer: { triggerEmphasis: false } },
      yAxis: {
        type: "value",
        min: 0,
        // Function form in both modes so a merge always replaces the previous mode's bound
        // (data.free: the top of what's in the range, as the filtering would have given it; held where it is while an
        // artist change redraws what's on screen, see withArtistMorph)
        max: share ? () => 1 : artistCtx?.yMax != null ? () => artistCtx.yMax : unfiltered ? () => hoursTop(data, names, window, hasOther, st.selected, zoom) : (v) => Math.max(1, Math.ceil(v.max)),
        // null (not undefined) so a merge clears share mode's fixed 25% step
        interval: share ? 0.25 : null,
        splitNumber: isStrip ? 2 : 4,
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: share ? (v) => `${Math.round(v * 100)}%` : (v) => `${v} h` },
      },
      // The range is chosen in the page's period brush (period.js), which moves it with setZoom. A hidden
      // slider is still a dataZoom, so the plot shows exactly that range. Never an "inside" one: it
      // swallows wheel events even with wheel zoom off, which stops the page scrolling over the chart
      // data.free: the caller has cut the points to a stretch around the range and keeps that same set while
      // the range moves (a window sweep), so nothing is filtered in or out and each point tweens, line ends too
      dataZoom: [{ type: "slider", show: false, startValue: zoom?.[0], endValue: zoom?.[1], filterMode: unfiltered ? "none" : "filter" }],
      series,
    },
    // Morphs merge by series id, so points tween instead of redrawing, while fills and lines fade. The series
    // list is replaced, not merged, so series the new render doesn't have (the parts, leaving for a view that
    // doesn't split) go rather than stay drawn as they were
    morph ? { replaceMerge: ["series"] } : { notMerge: true },
    ms,
    easing
  );
  // Share: the stack re-ordering (the artists who stay, ranked anew), each band travels as a strip to its new place
  {
    const t0 = performance.now(), ease = easeFn(easing);
    const at = !ms ? () => 1 : liveFrom ? () => liveAt(st.live ?? { t0, ms }) : () => ease(Math.min(1, (performance.now() - t0) / ms));
    st.floors = { from: share && ms ? bottomsFrom : null, at };
    if (share && ms && bottomsFrom && prev?.order && reordered(prev.order, st.order))
      installStrips(c, st, bottomsFrom, at, new Map(names.slice(1).map((_, k) => [sid(k + 1), sid(k)])),
        sid(names.length - 1), bandFill(names.length - 1, shown));
  }
  clipEdges();
  paintReveals(el, c);
  if (liveFrom) {
    const L = (st.live = { from: liveFrom, to: st.values, t0: performance.now(), ms });
    paintLive(c, st); // before the new values are ever painted
    const tick = () => {
      if (st.live !== L) return;
      paintLive(c, st);
      if (liveAt(L) < 1) L.raf = requestAnimationFrame(tick);
      else st.live = null;
    };
    L.raf = requestAnimationFrame(tick);
  }
  // The held-back pinned fills fade in once the morph has finished, unless the chart re-rendered since
  if (holdFill && base.size) {
    setTimeout(() => {
      if (st.renderToken !== renderToken) return;
      setOptionFaded(c, {
        animationDurationUpdate: 0,
        series: [...base].map((k) => ({ id: sid(k), areaStyle: { opacity: hoursPinOpacity } })),
      }, undefined, dur(FADE_MS));
    }, ms);
  }

  // Share mode: highlight the band under the pointer by filling it in more strongly (t.shade.hover),
  // dimming every other band a little (t.shade.dim). The hovered band's edge overlays draw its whole
  // border, bottom included.
  const lit = () => (focused == null ? base : new Set([...base, focused]));
  const focusBand = (sIndex) => {
    if (sIndex === focused) return;
    focused = sIndex;
    tellFocus(focused == null ? null : names[focused]);
    const on = lit();
    setOptionFaded(c, {
      animationDurationUpdate: 0,
      series: names.flatMap((_, k) => [
        { id: sid(k), areaStyle: { color: bandFill(k, on) } },
        { id: sid(k, "t"), lineStyle: overlayStyle(k, on.has(k)) },
        { id: sid(k, "b"), lineStyle: overlayStyle(k, on.has(k)) },
      ]).concat(partStyles(on)),
    }, undefined, FADE_MS);
    clipEdges();
  };
  // Hours mode: shade one line (its faint fill) and fade the rest, by restyling directly (ECharts' own blur state is
  // cleared on every pointer move over empty plot space, which is all of it once lines are silent).
  // Only a lit line gets a faint fill (hoursFillOpacity); nothing is filled at rest.
  const focusLine = (k) => {
    if (k === focused) return;
    focused = k;
    tellFocus(focused == null ? null : names[focused]);
    const on = lit();
    setOptionFaded(c, {
      animationDurationUpdate: 0,
      series: names.map((_, j) => ({
        id: sid(j),
        lineStyle: lineLook(j, on),
        areaStyle: { opacity: hoursArea(j, on) },
      })).concat(partStyles(on)),
    }, undefined, FADE_MS);
  };

  // Only the parts change (the pointer moved between parts of one band)
  const restyleParts = () => setOptionFaded(c, { animationDurationUpdate: 0, series: partStyles(lit()) }, undefined, FADE_MS);

  // Highlight an artist from outside the plot (legend, top lists): their band in share mode, their
  // line in hours mode. null, or an artist not in the chart, clears it.
  st.focusArtist = (name) => {
    if (hotPart) {
      hotPart = null;
      restyleParts();
    }
    let k = name == null ? -1 : names.indexOf(name);
    if (!share && k === otherIdx) k = -1; // "Everyone else" isn't drawn in hours mode
    // A hidden artist (its chip hovered in the key) has no band to light, so nothing around it dims either
    if (k >= 0 && !visible(k)) k = -1;
    (share ? focusBand : focusLine)(k < 0 ? null : k);
  };

  // The tooltip formats before the pointer handler runs, so redraw it once the focused series is known
  const retip = (x, y) => c.dispatchAction({ type: "showTip", x, y });

  // Plot hover, worked out from the data rather than from which shape is under the pointer (every
  // series is silent, so ECharts never applies its own highlight states, which break overlapping bands):
  // share mode focuses the band the pointer is inside; hours mode focuses the topmost line at that date.
  const zr = c.getZr();
  if (st.zrMove) {
    zr.off("mousemove", st.zrMove);
    zr.off("globalout", st.zrOut);
    zr.off("click", st.zrClick);
  }
  let fromPlot = kept >= 0; // only clear focus the plot set, not a legend or list hover's
  const focus = share ? focusBand : focusLine;
  // The band or line under a pixel, and the part of it: {k, j} (j null off the parts), null for none, or
  // undefined when the pixel is off the plot. In hours mode a part's line within PART_REACH px wins over
  // the topmost line, so the thin lines can be reached.
  const PART_REACH = 6;
  const pick = (px) => {
    if (!c.containPixel({ gridIndex: 0 }, px)) return undefined;
    const [t0, y] = c.convertFromPixel({ gridIndex: 0 }, px);
    // Nearest date (dates are sorted)
    let lo = 0, hi = data.dates.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (data.dates[mid] < t0) lo = mid; else hi = mid;
    }
    const i = Math.abs(data.dates[hi] - t0) < Math.abs(data.dates[lo] - t0) ? hi : lo;
    let best = null;
    if (share) {
      for (let k = 0; k < names.length; k++) {
        if (visible(k) && bottom[k][i] != null && y >= bottom[k][i] && y <= top[k][i] && top[k][i] > bottom[k][i]) best = k;
      }
      if (best == null) return null;
      for (let j = 0; parts && best !== otherIdx && j < partRows(best).length; j++) {
        const lo = j ? partTop[best][j - 1][i] : bottom[best][i], hi = partTop[best][j][i];
        if (partShown(best, j) && hi > lo && y >= lo && y <= hi) return { k: best, j };
      }
      return { k: best, j: null };
    }
    let reach = PART_REACH;
    let hit = null;
    for (const [k, j] of partKeys) {
      const v = visible(k) && partShown(k, j) ? partHoursAt(k, j, i) : null;
      const d = v == null ? Infinity : Math.abs(c.convertToPixel({ yAxisIndex: 0 }, v) - px[1]);
      if (d < reach) [reach, hit] = [d, { k, j }];
    }
    if (hit) return hit;
    let bestV = 0.05; // ignore near-silence, which would just pick an arbitrary flat line
    names.forEach((_, k) => {
      if (k === otherIdx || !visible(k)) return;
      const v = perWeek(data.hours[k][i]);
      if (v > bestV) { bestV = v; best = k; }
    });
    return best == null ? null : { k: best, j: null };
  };
  // "Everyone else" can't be pinned, so it isn't offered as clickable
  const pinnable = (k) => k != null && k !== otherIdx;
  // Lights the part (or none) along with its artist: the artist's restyle carries the part's, or alone it's just
  // the parts. Returns whether the part changed.
  const focusPart = (k, j) => {
    const next = j == null ? null : { k, j };
    const moved = hotPart?.k !== next?.k || hotPart?.j !== next?.j;
    hotPart = next;
    if (k !== focused) focus(k);
    else if (moved) restyleParts();
    return moved;
  };
  const clear = () => {
    if (fromPlot) focusPart(null, null);
    fromPlot = false;
    zr.setCursorStyle("default");
  };
  st.zrMove = (e) => {
    const px = [e.offsetX, e.offsetY];
    const hit = pick(px);
    if (hit === undefined) return clear();
    fromPlot = true;
    const best = hit?.k ?? null;
    zr.setCursorStyle((hit?.j != null && pins?.openPart) || (pins && pinnable(best)) ? "pointer" : "default");
    const was = focused;
    if (focusPart(best, hit?.j ?? null) || best !== was) retip(...px);
  };
  st.zrOut = clear;
  // Clicking a part opens its album or song in that view, pinned; clicking elsewhere on the band or line pins the
  // artist, or unpins it if it's already pinned
  st.zrClick = (e) => {
    const hit = pick([e.offsetX, e.offsetY]);
    if (hit?.j != null && pins?.openPart) return pins.openPart(names[hit.k], parts.kind, parts.names[hit.k][hit.j]);
    if (!pins?.toggle || !pinnable(hit?.k)) return;
    // The toggle re-renders the chart; it keeps the artist under the pointer lit, and the readout open
    st.keepFocus = names[hit.k];
    pins.toggle(names[hit.k]);
    st.keepFocus = null;
    // (a change of artists gave the chart a new state, which carried the artist over)
    const now = rollingState.get(el);
    if (now) now.keepFocus = null;
    retip(e.offsetX, e.offsetY);
  };
  zr.on("mousemove", st.zrMove);
  zr.on("globalout", st.zrOut);
  zr.on("click", st.zrClick);

  // Showing or hiding artists re-stacks the bands around them, as a morph
  // (mid artist change, re-stacks the artists it's going to, rather than keeping the leavers for good)
  const restack = () => {
    const [d, n, w, , m, o, p, sl, sm] = st.args;
    const [fd, fn, fsl] = st.final ?? [d, n, sl];
    renderRolling(el, fd, fn, w, currentZoom(el), m, o, true, p, fsl, sm);
  };
  // Show or hide an artist as the legend's box does. Not through ECharts' legendToggleSelect: that redraws the
  // chart at once with the artist toggled in its stored styles, so the colors flicker before the morph takes over
  st.toggleArtist = (name) => {
    st.selected = { ...st.selected, [name]: st.selected[name] === false };
    restack();
  };
  // Several at once in a single re-stack, rather than one morph per artist
  // Showing them all starts over: artists hidden while in another period don't come back hidden
  st.showAll = (list, show) => {
    for (const name of list) if (name in st.selected) st.selected[name] = show;
    if (show) for (const n of hiddenNames.get(el) ?? []) if (!st.names.includes(n)) hiddenNames.get(el).delete(n);
    restack();
  };

  const hidden = hiddenNames.get(el) ?? new Set();
  for (const n of names) st.selected[n] === false ? hidden.add(n) : hidden.delete(n);
  hiddenNames.set(el, hidden);
  // (mid artist change, the artists it's changing to)
  selectionHooks.get(el)?.((artistCtx?.report ?? artistsOf(names, hasOther)).filter((n) => st.selected[n] === false));

  // The hours strip draws the same render, with the same artists shown. Well off screen, it catches up (at once)
  // as it comes near, rather than on every render (see putOff). Mid artist change (withArtistMorph) it draws the
  // artists the change is going to, once, rather than each step's
  const strip = stripOf.get(el);
  const sa = artistCtx ? artistCtx.strip : { data, names, slots };
  const drawStrip = (zoom, morph) => {
    hiddenNames.set(strip, new Set(hidden));
    const sst = rollingState.get(strip);
    if (sst && sst.names.join("\u0000") === sa.names.join("\u0000")) sst.selected = { ...st.selected };
    // An artist kept lit through a click on the main chart stays lit in the strip too
    const keep = sst && sst.keepFocus == null && st.keepFocus != null;
    if (keep) sst.keepFocus = st.keepFocus;
    // without the albums or songs: in thin lines they'd only tangle. (The strip makes its own artist change, if any.)
    const outer = artistCtx;
    artistCtx = null;
    try {
      renderRolling(strip, { ...sa.data, parts: undefined }, sa.names, window, zoom, "hours", hasOther, morph, pins, sa.slots, smooth);
    } finally {
      artistCtx = outer;
    }
    if (keep) {
      sst.keepFocus = null;
      // (a change of artists gave the strip a new state, which carried the artist over)
      const now = rollingState.get(strip);
      if (now) now.keepFocus = null;
    }
  };
  if (strip && sa && !putOff(strip.closest(".card"), () => drawStrip(currentZoom(el) ?? zoom, false))) drawStrip(zoom, morph);
}

// The names a rolling chart keeps hidden, including ones not in it now (they stay hidden when they come back),
// and setting them afresh, as when the page switches to another view's artists
export const hiddenIn = (el) => [...(hiddenNames.get(el) ?? [])];
export function setHidden(el, names) {
  hiddenNames.set(el, new Set(names));
}

// Show or hide an artist in a rolling chart from elsewhere on the page (what unticking their legend box does)
export function toggleArtist(el, name) {
  rollingState.get(el)?.toggleArtist?.(name);
}

// Show or hide several artists in a rolling chart at once (what its "all" box does)
export function showArtists(el, list, show) {
  rollingState.get(el)?.showAll?.(list, show);
}

// Highlight an artist in a rolling chart from elsewhere on the page; null clears.
export function focusArtist(el, name) {
  rollingState.get(el)?.focusArtist?.(name);
}

// Keeps an artist lit through the re-renders until it's called again with null, rather than clearing the
// highlight and lighting them again (a click that unpins them is always on something of theirs)
export function holdFocus(el, name) {
  const st = rollingState.get(el);
  if (st) st.keepFocus = name;
}

// Total hours per month (or per `span` months), stacked: the month's top artist on top of each bar, filled in strongly and captioned
// above it where there's room; below them the chart's other artists in a lighter tint; and at the base everyone
// else in gray. Artists with less than FOLD of a month are folded into the gray, so small slices don't clutter
// it, unless they're lit (pinned, or hovered anywhere on the page, through focusMonthly): then they show, filled
// in and outlined, while the rest dim. Hovering a month lists its top five. names/slots are the chart's artists
// and their palette slots; pins is {has, toggle}; hover(name|null) reports the pointer; off holds deselected
// artists (never lit). other: false leaves everyone else out, so each bar is only the chart's artists and its
// top artist is the biggest of them.
const FOLD = 0.03;
const monthlyState = new WeakMap();
export function renderMonthly(el, rows, names = [], slots = [], pins = null, hover = () => {}, off = new Set(), span = 1, other = true) {
  const t = tokens();
  const short = (d) => d.toLocaleDateString(undefined, { month: "short" });
  // A bar's period: "Mar 2024", "Jan–Jun 2024", "2024" or "2024–2025"
  const label = (d) =>
    span === 24
      ? `${d.getFullYear()}–${d.getFullYear() + 1}`
      : span === 12
        ? String(d.getFullYear())
        : span > 1
          ? `${short(d)}–${short(new Date(d.getFullYear(), d.getMonth() + span - 1, 1))} ${d.getFullYear()}`
          : d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  // Months: every month's name. Years: every bar. Quarters and halves: each January with its year.
  const tick = (r) =>
    span === 1 ? short(r.month) : span >= 12 || r.month.getMonth() === 0 ? String(r.month.getFullYear()) : "";
  const grid = { left: 48, right: 16, top: 28, bottom: 32 };
  // Room for a caption above each bar; too narrow and they're left off (the tooltip still names the top artist)
  const slotW = rows.length ? (el.clientWidth - grid.left - grid.right) / rows.length : 0;
  const caption = slotW >= 56;
  const slotOf = new Map(names.map((n, k) => [n, slots[k]]));
  const colorOf = (n) => (slotOf.has(n) ? t.series[slotOf.get(n)] : t.other);
  const c = chart(el);
  const prev = monthlyState.get(el);
  // A new bar size changes every bar, so the chart draws afresh rather than morphing bars into unrelated ones
  const fresh = !prev || prev.span !== span || prev.names.join("\u0000") !== names.join("\u0000");
  // last: each series' values on screen (see settleMonthly)
  // Captions: the top artist's name, in one row along the top of the plot above every column, with room for every
  // line a caption can take
  if (caption) grid.top += (CAP_LINES - 1) * CAP_LINE_H;
  const st = { names, rows, span, other, t, off, pins, colorOf, underline: caption, grid, hovered: prev?.hovered ?? null, picked: prev?.picked ?? null, full: prev?.full ?? null, fullNext: prev?.full ?? null, last: fresh ? null : prev.last };
  monthlyState.set(el, st);
  const captionOf = (r) => barView(st, r).top[0]?.name ?? "";
  const bar = { type: "bar", stack: "month", barCategoryGap: `${tune.barGap}%` };
  const looks = monthlySeries(st);
  // New artists over the same bars (a pin, the artist count): the bars stand still and only who fills them
  // changes, so the old chart fades out over the new one instead of the bars growing in again
  const crossfade =
    fresh && prev && prev.span === span && prev.rows.length === rows.length && +prev.rows[0]?.month === +rows[0]?.month && dur(MORPH_MS) > 0;
  // Rebuilding under an open tooltip (a click pinning a new artist in) leaves it filling a removed element
  if (fresh && prev) c.dispatchAction({ type: "hideTip" });
  if (crossfade) fadeOutFrame(el, t.surface);
  setOptionFaded(
    c,
    {
      animation: !crossfade,
      animationDuration: ENTER_MS,
      animationDurationUpdate: MORPH_MS,
      animationEasingUpdate: EASE_IN_OUT.echarts,
      grid,
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        // The tooltip follows the column, without shading it
        axisPointer: { type: "none" },
        formatter: (ps) => {
          const r = rows[ps[0].dataIndex];
          const { hours, top } = barView(st, r);
          const head = `<div style="margin-bottom:4px"><b>${label(r.month)}</b> <span style="opacity:.75">${fmtHours(hours)}</span></div>`;
          if (!hours) return head;
          const lit = litSet(st);
          const pct = (h) => `${Math.round((h / hours) * 100)}%`;
          // Lit artists outside the month's top five follow it
          const extra = names
            .map((n, k) => ({ name: n, hours: r.by[k] }))
            .filter((a) => lit.has(a.name) && a.hours > 0 && !top.some((x) => x.name === a.name));
          return head + [...top, ...extra].map((a) => row(colorOf(a.name), pct(a.hours), a.name, lit.has(a.name))).join("");
        },
      },
      xAxis: [
        {
          type: "category",
          data: rows.map(tick),
          ...baseAxis(t),
          axisLabel: { color: t.muted, interval: 0 },
          axisPointer: { triggerEmphasis: false },
          splitLine: { show: false },
        },
        {
          type: "category",
          position: "top",
          data: rows.map(captionOf),
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisPointer: { show: false },
          // Drawn as elements instead (paintCaptionMarks), so a lit artist's name can fade to the main ink
          axisLabel: { show: false },
        },
      ],
      yAxis: {
        type: "value",
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => `${v} h` },
      },
      series: [
        { ...looks[0], name: "Everyone else", ...bar, silent: true },
        ...[...names, ...names].map((n, j) => ({ ...looks[j + 1], name: n, ...bar, cursor: pins ? "pointer" : "default" })),
        { ...looks[2 * names.length + 1], name: "Top artist", ...bar },
      ],
    },
    // Colors and outlines fade with the bars' morph rather than snapping before it
    { notMerge: fresh },
    fresh ? 0 : dur(MORPH_MS)
  );
  // The gray top series' artist is each bar's top one (looked up, not named in its data: ECharts matches data by
  // name, so a bar whose name changed would fade out where it stood instead of morphing with the others)
  const artistOf = (p) => (p.seriesId === "top" ? barView(st, rows[p.dataIndex]).top[0]?.name : p.seriesName);
  settleMonthly(el, st, looks);
  paintUnderlines(el, st);
  // The pointer picks the artist whose slice it's over; anywhere else in a column, it picks the column's top
  // artist, so hovering or clicking the column is hovering or clicking them. A top artist outside the chart can
  // be picked too: clicking pins them into it, but only the chart's artists light up on hover (shared with the
  // rest of the page). ECharts reports the slice (mouseover/out) before zrender's mousemove, which then works
  // out the pick. A pin re-renders the chart without moving the pointer, so the slice under it carries over, and
  // a click works out its own pick.
  // `lit` is the artist last reported to hover(): only the chart's artists, carried over a re-render so it's
  // cleared when the pointer leaves
  const pickable = (n) => n != null && !off.has(n);
  let slice = pickable(prev?.slice?.()) ? prev.slice() : null;
  let lit = prev?.lit?.() ?? null;
  st.slice = () => slice;
  st.lit = () => lit;
  // A column runs from the top of the card down to the axis, so the space above the bars (where the captions sit,
  // outside the plot) and the card's header beside the title answer too, tooltip and all: ECharts only shows it
  // inside the plot, so it's asked for there
  let tipAbove = null;
  const pick = (x, y) => {
    let n = slice;
    const inColumn = x >= grid.left && x <= el.clientWidth - grid.right && y <= el.clientHeight - grid.bottom;
    const i = inColumn ? Math.round(c.convertFromPixel({ gridIndex: 0 }, [x, Math.max(y, grid.top)])[0]) : null;
    if (n == null && rows[i]) {
      const top = barView(st, rows[i]).top[0]?.name;
      if (pickable(top)) n = top;
    }
    // Asked for on every move, since ECharts hides it again whenever the pointer moves outside the plot
    const above = rows[i] && y < grid.top ? i : null;
    if (above != null) c.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: above });
    else if (tipAbove != null && !c.containPixel("grid", [x, y])) c.dispatchAction({ type: "hideTip" });
    tipAbove = above;
    c.getZr().setCursorStyle(n != null && pins ? "pointer" : "default");
    const l = names.includes(n) ? n : null;
    if (l !== lit) hover((lit = l));
    if (n !== st.picked) {
      st.picked = n;
      paintCaptionMarks(el, st);
    }
    return n;
  };
  const leave = () => {
    slice = null;
    if (st.picked != null) {
      st.picked = null;
      paintCaptionMarks(el, st);
    }
    if (lit != null) hover((lit = null));
    if (tipAbove != null) c.dispatchAction({ type: "hideTip" });
    tipAbove = null;
  };
  const zr = c.getZr();
  if (prev?.zr) for (const [ev, fn] of Object.entries(prev.zr)) zr.off(ev, fn);
  st.zr = {
    mousemove: (e) => pick(e.offsetX, e.offsetY),
    globalout: leave,
    click: (e) => {
      const n = pick(e.offsetX, e.offsetY);
      if (n != null) pins?.toggle(n);
    },
  };
  for (const [ev, fn] of Object.entries(st.zr)) zr.on(ev, fn);
  // The card around the chart, outside it: its controls and text keep to themselves, the rest is the column below
  const card = el.closest(".card");
  if (prev?.card) for (const [ev, fn] of Object.entries(prev.card)) card?.removeEventListener(ev, fn);
  const fromCard = (e) => {
    if (el.contains(e.target)) return undefined; // the chart's own handlers have it
    const r = el.getBoundingClientRect();
    const own = e.target.closest("h2, p, label, button, input, a");
    const n = own ? (leave(), null) : pick(e.clientX - r.left, e.clientY - r.top);
    card.style.cursor = n != null && pins ? "pointer" : "";
    return n;
  };
  st.card = card && {
    pointermove: fromCard,
    pointerleave: () => {
      card.style.cursor = "";
      leave();
    },
    click: (e) => {
      const n = fromCard(e);
      if (n != null) pins?.toggle(n);
    },
  };
  if (card) for (const [ev, fn] of Object.entries(st.card)) card.addEventListener(ev, fn);
  c.off("mouseover");
  c.off("mouseout");
  c.off("click");
  c.on("mouseover", (p) => (slice = pickable(artistOf(p)) ? artistOf(p) : null));
  c.on("mouseout", () => (slice = null));
}

// Lay a copy of the chart's current frame over it and fade it out (MORPH_MS), so whatever is drawn next crossfades
// in. A copy still fading from an earlier call is folded into the new one, at the opacity it has reached.
function fadeOutFrame(el, background) {
  const src = el.querySelector("canvas");
  if (!src) return;
  const copy = document.createElement("canvas");
  copy.width = src.width;
  copy.height = src.height;
  const ctx = copy.getContext("2d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, copy.width, copy.height);
  ctx.drawImage(src, 0, 0);
  for (const old of el.querySelectorAll(".chart-fade")) {
    ctx.globalAlpha = +getComputedStyle(old).opacity;
    ctx.drawImage(old, 0, 0);
    old.remove();
  }
  copy.className = "chart-fade";
  Object.assign(copy.style, { position: "absolute", left: 0, top: 0, width: src.style.width, height: src.style.height, pointerEvents: "none", zIndex: 1 });
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  el.append(copy);
  copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MORPH_MS, easing: EASE_IN_OUT.css, fill: "forwards" }).finished.then(
    () => copy.remove(),
    () => {}
  );
}

// The artists in the spotlight: the pinned ones, and the one hovered
function litSet(st) {
  const lit = new Set(st.names.filter((n) => st.pins?.has(n) && !st.off.has(n)));
  if (st.hovered != null) lit.add(st.hovered);
  return lit;
}

// A bar's total and its top five, [{ name, hours }]: of everyone, or only of the chart's artists when everyone
// else is left out
function barView(st, r) {
  if (st.other) return { hours: r.hours, top: r.top };
  const own = st.names.map((name, k) => ({ name, hours: r.by[k] })).filter((a) => a.hours > 0);
  return { hours: own.reduce((s, a) => s + a.hours, 0), top: own.sort((a, b) => b.hours - a.hours).slice(0, 5) };
}

// The series' ids, data and styles, bottom to top: the gray remainder (rest), each chart artist's slices (m{k}),
// each chart artist's top-of-the-month block (t{k}), then the top block of a month whose top artist isn't in the
// chart (top, gray). Giving every artist their own top series keeps a region theirs when they stop being on
// top (deselected, say), so it shrinks away instead of turning into someone else's. A small artist's slice is
// folded into the gray unless they're lit, so lighting one grows their slices out of it. Without everyone else
// there's no gray to fold into, so every slice shows and the gray shrinks away.
function monthlySeries(st) {
  const { t, names, rows, colorOf } = st;
  const lit = litSet(st);
  const fill = (col, on, dim, base) => mix(t.surface, col, on ? 0.5 : dim ? 0.1 : base);
  // A hairline in the surface color between slices, or the artist's color around a lit one
  const edge = (col, on) => (on ? { borderColor: col, borderWidth: 1.5 } : { borderColor: t.surface, borderWidth: 1 });
  const radius = { borderRadius: [1.5, 1.5, 0, 0] };
  // A zero-height bar still strokes its outline, so an emptied bar keeps it only while it shrinks (settleMonthly
  // takes it off after)
  const items = (id, values) =>
    values.map((v, i) => ({ value: v, ...(v > 0 || st.last?.get(id)?.[i] > 0 ? {} : { itemStyle: { borderWidth: 0 } }) }));
  const tops = rows.map((r) => barView(st, r).top[0]);
  const shown = names.map((n, k) =>
    rows.map((r, i) => n !== tops[i]?.name && r.by[k] > 0 && (!st.other || lit.has(n) || r.by[k] >= FOLD * r.hours))
  );
  const rest = rows.map((r, i) => {
    if (!st.other) return 0;
    const slices = names.reduce((s, _n, k) => s + (shown[k][i] ? r.by[k] : 0), 0);
    return Math.max(0, r.hours - slices - (tops[i]?.hours ?? 0));
  });
  const slices = names.map((n, k) => {
    const on = lit.has(n);
    const col = colorOf(n);
    return {
      id: `m${k}`,
      itemStyle: { color: fill(col, on, lit.size && !on, 0.25), ...edge(col, on && "lit") },
      data: items(`m${k}`, rows.map((r, i) => (shown[k][i] ? r.by[k] : 0))),
    };
  });
  // Always drawn like a pinned artist, so lighting another doesn't dim them
  const topBlocks = names.map((n, k) => ({
    id: `t${k}`,
    itemStyle: { color: fill(colorOf(n), true), ...edge(colorOf(n), true), ...radius },
    data: items(`t${k}`, rows.map((r, i) => (tops[i]?.name === n ? r.by[k] : 0))),
  }));
  // A top artist outside the chart has no color of their own: a lighter gray than the rest, without an outline
  const uncharted = rows.map((r, i) => (tops[i] && !names.includes(tops[i].name) ? tops[i].hours : 0));
  const top = { id: "top", itemStyle: { color: mix(t.surface, t.other, 0.6), ...edge(t.other, false), ...radius }, data: items("top", uncharted) };
  // The gray never dims either: it's the rest of the month, whoever is lit
  const gray = { id: "rest", itemStyle: { color: mix(t.surface, t.other, 0.35), ...edge(t.other, false) }, data: rest };
  return [gray, ...slices, ...topBlocks, top];
}

// Under a caption whose artist is in the chart, a line in their color across their bar's column, all one length and
// thickness, never dimmed (a top artist stays as strong whoever is lit). Neighbouring lines join into one strip,
// rounded only at its two ends. They're elements over the chart rather than shapes in it, so CSS tweens them: a
// strip that comes or goes (an artist selected, deselected or pinned in) grows from or shrinks to a point in its
// middle; lines joining or leaving a strip that stays grow from or shrink to their seam with it; the strips'
// lengths morph with the bars. still: place them without tweening (a resize).
const LINE_H = 2;
function paintUnderlines(el, st, still = false) {
  const c = instances.get(el);
  let layer = el.querySelector(".month-lines");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "month-lines";
    // (placed here as well as in the stylesheet, so a cached stylesheet can't drop them in a heap)
    Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: 2 });
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.appendChild(layer);
    new ResizeObserver(() => monthlyState.has(el) && paintUnderlines(el, monthlyState.get(el), true)).observe(el);
  }
  const { rows, grid, names, off } = st;
  const who = rows.map((r) => {
    const n = barView(st, r).top[0]?.name;
    return st.underline && names.includes(n) && !off.has(n) ? n : null;
  });
  // What was drawn last ({ who, rects }), if it was over the same bars
  const before = layer._drawn?.who.length === rows.length ? layer._drawn : null;
  const was = before?.who ?? who.map(() => null);
  const slot = (el.clientWidth - grid.left - grid.right) / Math.max(1, rows.length);
  const bottom = `${el.clientHeight - grid.top + 4}px`;
  layer.classList.toggle("still", still);
  while (layer.children.length > rows.length) layer.lastChild.remove();
  while (layer.children.length < rows.length) {
    const d = layer.appendChild(document.createElement("div"));
    Object.assign(d.style, { position: "absolute", width: "0px", height: `${LINE_H}px`, bottom });
  }
  // Each line's [left, right]: its bar's whole column, halfway into the gaps either side, so lines keep one length
  // whatever their neighbours do (a joined one reaches half a pixel further left, so the seam doesn't show)
  const rects = who.map((n, i) => {
    if (n == null) return null;
    const mid = c ? c.convertToPixel({ xAxisIndex: 0 }, i) : grid.left + slot * (i + 0.5);
    return [mid - slot / 2 - (who[i - 1] != null ? 0.5 : 0), mid + slot / 2];
  });
  // Where a run of lines that come (or go) grows from (or shrinks to): its seam with the part of its strip that
  // stays, else the run's middle. inRun picks the run; at holds where each of its lines is (or was)
  const stays = (j) => who[j] != null && was[j] != null;
  const anchor = (i, inRun, at) => {
    let p = i, q = i;
    while (inRun(p - 1)) p--;
    while (inRun(q + 1)) q++;
    if (stays(p - 1)) return at[p][0];
    if (stays(q + 1)) return at[q][1];
    return (at[p][0] + at[q][1]) / 2;
  };
  const place = (d, l, r) => Object.assign(d.style, { left: `${l}px`, width: `${Math.max(0, r - l)}px` });
  // Lines that come jump to their anchor first, untweened
  const coming = [];
  who.forEach((n, i) => {
    if (n == null || was[i] != null || still) return;
    const x = anchor(i, (j) => who[j] != null && was[j] == null, rects);
    const d = layer.children[i];
    d.style.transition = "none";
    place(d, x, x);
    coming.push(d);
  });
  if (coming.length) void layer.offsetWidth;
  for (const d of coming) d.style.transition = "";
  who.forEach((n, i) => {
    const d = layer.children[i];
    if (n == null) {
      // Gone: shrinks to its anchor, keeping its color and ends
      if (was[i] != null && !still) {
        const x = anchor(i, (j) => was[j] != null && who[j] == null, before.rects);
        place(d, x, x);
      } else d.style.width = "0px";
      return;
    }
    const rl = who[i - 1] != null ? 0 : LINE_H / 2, rr = who[i + 1] != null ? 0 : LINE_H / 2;
    place(d, ...rects[i]);
    Object.assign(d.style, {
      bottom,
      height: `${LINE_H}px`,
      borderRadius: `${rl}px ${rr}px ${rr}px ${rl}px`,
      background: st.colorOf(n),
    });
  });
  layer._drawn = { who, rects };
  paintCaptionMarks(el, st);
}

// The captions (each column's top artist), and behind them a wash over the columns of the pinned artists and of the
// one a click would pin or unpin (the one the pointer picks, or one hovered elsewhere on the page), the same for
// both, so pinning keeps what hovering showed. It runs from above the caption down to the axis and rises from it
// (sinks back into it); neighbouring washes join into one, rounded only at its outer corners. A lit artist's name
// brightens. They're elements over the chart, so CSS tweens them.
// A caption takes up to CAP_LINES lines of the name shortened by cleanName; where that still leaves some of it out,
// hovering shows it whole (paintFullNames).
const CAP_LINES = 3, CAP_LINE_H = 13;
// A track or album name without what's usually tacked on: "(feat. …)", "[with …]", "(Radio Edit)", "- Remastered 2011"
const ADDED = [
  /\s*[([](?:feat\.?|ft\.?|with|prod\.?|from)\s[^)\]]*[)\]]/gi,
  /\s*[([][^)\]]*\b(?:remaster(?:ed)?|version|edit|mix|live|mono|stereo|deluxe|bonus)\b[^)\]]*[)\]]/gi,
  /\s+[-–—]\s+.*\b(?:remaster(?:ed)?|version|edit|mix|live|mono|stereo|deluxe|bonus|from)\b.*$/gi,
];
const cleanName = (s) => ADDED.reduce((a, re) => a.replace(re, ""), s).trim() || s;
// A name too wide for its column, in up to n lines, broken at a space (or between any two characters in a name
// without one: Chinese, Japanese), never inside a word. When it fits, it takes as few lines as it can, split as
// evenly as can be ("HOE (Heaven / on Earth)", not "HOE (Heaven on / Earth)"); when it can't, each line takes all
// the words it can and the last is cut off (the stylesheet's ellipsis, as is a word too long for a line).
// { lines, cut }: cut when some of it doesn't show.
let measure = null;
function fitLines(text, w, font, n) {
  measure ??= document.createElement("canvas").getContext("2d");
  measure.font = font;
  const widths = new Map();
  const width = (s) => widths.get(s) ?? widths.set(s, measure.measureText(s).width).get(s);
  if (width(text) <= w) return { lines: [text], cut: false };
  const parts = text.includes(" ") ? text.split(" ") : Array.from(text);
  const sep = text.includes(" ") ? " " : "";
  const join = (i, j) => parts.slice(i, j).join(sep);
  // The evenest split of parts from i on into m lines that each fit: [lines, the widest], or [null, Infinity]
  const even = (i, m) => {
    if (m === 1) return width(join(i, parts.length)) <= w ? [[join(i, parts.length)], width(join(i, parts.length))] : [null, Infinity];
    let best = [null, Infinity];
    for (let k = i + 1; k <= parts.length - m + 1 && width(join(i, k)) <= w; k++) {
      const [rest, wr] = even(k, m - 1);
      if (rest && Math.max(width(join(i, k)), wr) < best[1]) best = [[join(i, k), ...rest], Math.max(width(join(i, k)), wr)];
    }
    return best;
  };
  for (let m = 2; m <= n; m++) {
    const [lines] = even(0, m);
    if (lines) return { lines, cut: false };
  }
  const lines = [];
  let i = 0;
  while (lines.length < n - 1 && i < parts.length) {
    let k = i + 1;
    while (k < parts.length && width(join(i, k + 1)) <= w) k++;
    lines.push(join(i, k));
    i = k;
  }
  if (i < parts.length) lines.push(join(i, parts.length));
  return { lines, cut: true };
}

function paintCaptionMarks(el, st) {
  const c = instances.get(el);
  let layer = el.querySelector(".month-caps");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "month-caps";
    // (placed here as well as in the stylesheet, so a cached stylesheet can't drop them in a heap)
    Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: 2 });
    layer.append(document.createElement("div"), document.createElement("div"), document.createElement("div"));
    el.appendChild(layer);
  }
  const [marks, caps, fulls] = layer.children;
  const { rows, grid, off } = st;
  const slot = (el.clientWidth - grid.left - grid.right) / Math.max(1, rows.length);
  // The top of the plot (the line sits 4-6px above it), and the axis
  layer.style.setProperty("--gt", `${grid.top}px`);
  layer.style.setProperty("--axis", `${el.clientHeight - grid.bottom}px`);
  const focus = st.picked ?? st.hovered;
  const pinned = (n) => n != null && !!st.pins?.has(n) && !off.has(n);
  const tops = rows.map((r) => barView(st, r).top[0]?.name ?? null);
  const mark = tops.map((n) => (st.underline && n != null && (pinned(n) || n === focus) ? n : null));
  for (const [box, name] of [[marks, "mark"], [caps, "cap"], [fulls, "cap-full"]]) {
    while (box.children.length > rows.length) box.lastChild.remove();
    while (box.children.length < rows.length) box.appendChild(document.createElement("div")).className = name;
  }
  caps.hidden = fulls.hidden = !st.underline;
  const font = rows.length ? getComputedStyle(caps.children[0]).font : "";
  const mids = rows.map((_r, i) => (c ? c.convertToPixel({ xAxisIndex: 0 }, i) : grid.left + slot * (i + 0.5)));
  // Which columns' captions leave some of the name out (cut off, or shortened by cleanName)
  const cut = rows.map(() => false);
  rows.forEach((_r, i) => {
    const mid = mids[i];
    const cap = caps.children[i];
    const text = tops[i] ? cleanName(tops[i]) : "";
    const fit = fitLines(text, slot - 6, font, CAP_LINES);
    cut[i] = fit.cut || text !== (tops[i] ?? "");
    cap.replaceChildren(...fit.lines.map((line) => Object.assign(document.createElement("span"), { textContent: line })));
    cap.classList.toggle("lit", mark[i] != null);
    Object.assign(cap.style, { left: `${mid - slot / 2 + 3}px`, width: `${Math.max(0, slot - 6)}px` });
    const d = marks.children[i];
    const n = mark[i];
    d.classList.toggle("on", n != null);
    if (n == null) return; // sinks away as it was, in its color
    d.classList.toggle("pin", pinned(n)); // a pin deepens the hover's lighter wash
    d.classList.toggle("jl", mark[i - 1] != null);
    d.classList.toggle("jr", mark[i + 1] != null);
    Object.assign(d.style, { left: `${mid - slot / 2}px`, width: `${slot}px` });
    d.style.setProperty("--c", st.colorOf(n));
  });
  // The whole name waits for the pointer to rest (a fade's length) on its artist, so sweeping across the chart doesn't
  // flash every long name on the way; it goes as soon as the pointer moves on
  // (full: the name shown; fullNext: the one waited for)
  if (focus !== st.full && focus !== st.fullNext) {
    st.full = null;
    clearTimeout(st.fullWait);
    st.fullNext = focus;
    if (focus != null)
      st.fullWait = setTimeout(() => {
        if (monthlyState.get(el) !== st) return;
        st.full = focus;
        paintCaptionMarks(el, st);
      }, dur(FADE_MS));
  }
  paintFullNames(el, caps, fulls, st.full, tops, cut, mids, slot, font);
}

// Where the hovered (or pointed-at) artist's caption leaves some of their name out, the whole name in its place, in
// the lit ink and as few lines as the others: at the narrowest width that holds it (from the column's own, kept
// inside the chart), centred on each run of their columns. It opens out sideways from their columns as it fades in
// (and closes back into them), while the captions it reaches over fade out of its way, so the only text that changes
// in place is the caption's own. Each run's name is the element of its first column, so moving between columns
// crossfades rather than sliding text.
function paintFullNames(el, caps, fulls, focus, tops, cut, mids, slot, font) {
  const runs = [];
  if (focus != null)
    tops.forEach((n, i) => {
      if (n !== focus || !cut[i]) return;
      if (runs.at(-1)?.[1] === i - 1) runs.at(-1)[1] = i;
      else runs.push([i, i]);
    });
  const maxW = el.clientWidth - 8;
  const spans = runs.map(([a, b]) => {
    let w = slot - 6, fit = fitLines(focus, w, font, CAP_LINES);
    while (fit.cut && w < maxW) fit = fitLines(focus, (w = Math.min(w + 8, maxW)), font, CAP_LINES);
    const left = Math.min(Math.max((mids[a] + mids[b]) / 2 - w / 2, 4), el.clientWidth - 4 - w);
    const f = fulls.children[a];
    if (f.classList.contains("on")) return [left, left + w];
    // Arriving: laid out and clipped to its columns at once, then it opens out (.on)
    f.replaceChildren(...fit.lines.map((line) => Object.assign(document.createElement("span"), { textContent: line })));
    f.style.transition = "none";
    Object.assign(f.style, { left: `${left}px`, width: `${w}px` });
    f.style.setProperty("--cl", `${Math.max(0, mids[a] - slot / 2 + 3 - left)}px`);
    f.style.setProperty("--cr", `${Math.max(0, left + w - (mids[b] + slot / 2 - 3))}px`);
    void f.offsetWidth;
    f.style.transition = "";
    return [left, left + w];
  });
  const starts = new Set(runs.map(([a]) => a));
  [...fulls.children].forEach((f, i) => f.classList.toggle("on", starts.has(i)));
  [...caps.children].forEach((cap, i) => {
    const l = mids[i] - slot / 2 + 3, r = mids[i] + slot / 2 - 3;
    cap.classList.toggle("under", spans.some(([a, b]) => l < b && r > a));
  });
}

// Note what's on screen once `series` is set, and once any emptied bars have shrunk away, take their outlines off.
// It waits for the chart's animations to finish rather than a fixed MORPH_MS: the morph's first frame can come late
// (after the work of a render), and a setOption while bars still move restarts their easing, a visible stutter.
function settleMonthly(el, st, series) {
  const was = st.last;
  st.last = new Map(series.filter((s) => s.id !== "rest").map((s) => [s.id, s.data.map((d) => d.value)]));
  const c = instances.get(el);
  if (st.settle) c?.off("finished", st.settle);
  st.settle = null;
  const emptied = [...st.last].some(([id, vs]) => vs.some((v, i) => v === 0 && was?.get(id)?.[i] > 0));
  if (!emptied || !c) return;
  const settle = () => {
    c.off("finished", settle);
    if (monthlyState.get(el) !== st || st.settle !== settle) return;
    st.settle = null;
    const next = monthlySeries(st);
    c.setOption({ series: next }, undefined, true);
    settleMonthly(el, st, next);
  };
  st.settle = settle;
  c.on("finished", settle);
}

// Light one artist (and dim the rest) from a hover elsewhere on the page; null clears
export function focusMonthly(el, name) {
  const st = monthlyState.get(el);
  const c = instances.get(el);
  if (!st || !c) return;
  const next = name != null && st.names.includes(name) && !st.off.has(name) ? name : null;
  if (next === st.hovered) return;
  st.hovered = next;
  const series = monthlySeries(st);
  setOptionFaded(c, { series }, undefined, dur(FADE_MS)); // faded, as hover in the other charts is
  paintUnderlines(el, st);
  settleMonthly(el, st, series);
}

// When you listened: one share stack graph across the hours of the day (every weekday together), drawn like the
// rolling chart's Share mode (bands bottom up in rank order, a pale tint of each artist's color under an outline). With
// includeOther, the rest of the time is a gray "Everyone else" band on top; without, the shares are among the artists
// shown. grid is clockBy's, by weekday and hour; the hours are summed over the week and smoothed around the day's clock
// (late night runs into the early morning) so a band doesn't jump between neighbouring hours. Pins and hover work as
// in renderMonthly (focusClock lights an artist from elsewhere): names/slots are the artists and their palette slots,
// off the deselected ones (already left out of grid's plays, so shares are of what's shown). sigma is the smoothing,
// in hours, and curve the line's rounding (ECharts' smooth).
const clockState = new WeakMap();
const hourLabel = (h) => (h % 24 === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

// Gaussian blur of a ring (the day's 24 hours)
function blurRing(v, sigma) {
  if (!(sigma > 0)) return v;
  const n = v.length, r = Math.ceil(sigma * 3);
  const w = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  return v.map((_, i) => w.reduce((s, wj, j) => s + wj * v[(i + j - r + n) % n], 0));
}

export function renderClock(el, grid, names = [], slots = [], pins = null, hover = () => {}, off = new Set(), includeOther = true, sigma = 0.5, curve = 0.3) {
  const t = tokens();
  const all = [...names, "Everyone else"];
  const colors = [...names.map((n, k) => t.series[slots[k]]), t.other];
  const otherIdx = names.length;
  const c = chart(el);
  const prev = clockState.get(el);
  const fresh = !prev || prev.names.join("\u0000") !== names.join("\u0000");

  // Hours on the day's ring (24 hours from midnight, every weekday summed) for each series, then smoothed
  const cell = (e, k) => (k < otherIdx ? e.by[k] : includeOther ? Math.max(0, e.hours - e.by.reduce((x, y) => x + y, 0)) : 0);
  const ring = all.map((_, k) => Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + cell(row[h], k), 0)));
  const smooth = ring.map((v) => blurRing(v, sigma));
  // Each hour's value sits at the middle of the hour; points go on the hour (0..24), halfway between two
  const hours = smooth.map((v) => Array.from({ length: 25 }, (_, h) => (v[(h + 23) % 24] + v[h % 24]) / 2));
  const total = Array.from({ length: 25 }, (_, h) => all.reduce((s, _n, k) => s + hours[k][h], 0));
  // Each band's share, and its bottom and top in the stack (for hover)
  const share = all.map((_, k) => total.map((tot, h) => (tot > 1e-9 ? hours[k][h] / tot : 0)));
  const bottom = all.map(() => new Array(25).fill(0));
  for (let h = 0; h < 25; h++) {
    let acc = 0;
    all.forEach((_, k) => {
      bottom[k][h] = acc;
      acc += share[k][h];
    });
  }

  const st = { names, all, colors, t, off, pinned: new Set(names.filter((n) => pins?.has(n) && !off.has(n))), hovered: prev?.hovered ?? null };
  st.zrMove = prev?.zrMove;
  st.zrOut = prev?.zrOut;
  st.zrClick = prev?.zrClick;
  clockState.set(el, st);

  const tip = (params) => {
    if (!params.length) return "";
    const h = Math.round(params[0].axisValue);
    const rows = all
      .map((n, k) => ({ k, s: share[k][h] }))
      .filter((r) => r.s >= 0.005 && !off.has(all[r.k]))
      .sort((a, b) => b.k - a.k)
      .map((r) => row(colors[r.k], (r.s * 100).toFixed(0) + "%", shownName(all[r.k]), all[r.k] === st.hovered));
    return `<div style="color:${t.muted};margin-bottom:4px">Around ${hourLabel(h)}</div>${rows.join("")}`;
  };

  setOptionFaded(
    c,
    {
      animation: true,
      animationDuration: ENTER_MS,
      animationDurationUpdate: MORPH_MS,
      animationEasingUpdate: EASE_IN_OUT.echarts,
      grid: { left: 16, right: 16, top: 8, bottom: 28 },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 }, triggerEmphasis: false },
        formatter: tip,
      },
      axisPointer: { triggerEmphasis: false },
      xAxis: {
        type: "value",
        min: 0,
        max: 24,
        interval: 3,
        ...baseAxis(t),
        axisLine: { show: false },
        splitLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => hourLabel(v) },
        axisPointer: { triggerEmphasis: false },
      },
      yAxis: { type: "value", min: 0, max: 1, ...baseAxis(t), axisLine: { show: false }, splitLine: { show: false }, axisLabel: { show: false } },
      series: all.map((n, k) => ({
        id: `c${k}`,
        name: n,
        type: "line",
        silent: true,
        symbol: "none",
        smooth: curve,
        // Stacked by hand, as in the rolling chart: each band is its top edge filled down to the axis, and the
        // bands below paint over it
        z: 2 + all.length - k,
        ...clockLook(st, k),
        data: share[k].map((s, h) => [h, bottom[k][h] + s]),
      })),
    },
    // Outlines and fills fade with the morph (deselecting an artist), rather than snapping before it
    { notMerge: fresh },
    fresh ? 0 : dur(MORPH_MS)
  );

  // Hover from the data, as in the rolling chart: the band under the pointer
  const zr = c.getZr();
  if (st.zrMove) {
    zr.off("mousemove", st.zrMove);
    zr.off("globalout", st.zrOut);
    zr.off("click", st.zrClick);
  }
  const pick = (px) => {
    if (!c.containPixel({ gridIndex: 0 }, px)) return undefined;
    const [x, y] = c.convertFromPixel({ gridIndex: 0 }, px);
    const h = Math.max(0, Math.min(24, Math.round(x)));
    for (let k = 0; k < all.length; k++) {
      if (off.has(all[k])) continue;
      if (y >= bottom[k][h] && y <= bottom[k][h] + share[k][h] && share[k][h] > 0) return all[k];
    }
    return null;
  };
  let fromPlot = false;
  st.zrMove = (e) => {
    const name = pick([e.offsetX, e.offsetY]);
    if (name === undefined) {
      if (fromPlot) hover(null);
      fromPlot = false;
      zr.setCursorStyle("default");
      return;
    }
    fromPlot = true;
    const artist = names.includes(name) ? name : null; // "Everyone else" isn't an artist to light or pin
    zr.setCursorStyle(pins && artist ? "pointer" : "default");
    if (artist !== st.hovered) {
      hover(artist);
      c.dispatchAction({ type: "showTip", x: e.offsetX, y: e.offsetY });
    }
  };
  st.zrOut = () => {
    if (fromPlot) hover(null);
    fromPlot = false;
    zr.setCursorStyle("default");
  };
  st.zrClick = (e) => {
    const name = pick([e.offsetX, e.offsetY]);
    if (name && names.includes(name)) pins?.toggle(name);
  };
  zr.on("mousemove", st.zrMove);
  zr.on("globalout", st.zrOut);
  zr.on("click", st.zrClick);
}

// The style of artist k's bands: lit (pinned or hovered), dim (something else is lit) or at rest, as in the
// rolling chart's Share mode
function clockLook(st, k) {
  const { t, names, colors } = st;
  const col = colors[k];
  // A deselected artist has no share, so no outline either (a flat line would still draw)
  if (k < names.length && st.off.has(names[k])) return { lineStyle: { width: 0, opacity: 0 }, areaStyle: { color: mix(t.surface, col, t.shade.band), opacity: 1 } };
  const lit = new Set([...st.pinned, ...(st.hovered != null ? [st.hovered] : [])]);
  const rest = k === names.length; // the gray series is never lit
  const on = !rest && lit.has(names[k]);
  const dim = lit.size && !on;
  return {
    lineStyle: { color: dim ? mix(t.surface, col, 0.4) : col, width: on ? 2 : 1, opacity: 1 },
    areaStyle: { color: mix(t.surface, col, on ? t.shade.hover : dim ? t.shade.dim : t.shade.band), opacity: 1 },
  };
}

// Light one artist (and dim the rest) from a hover elsewhere on the page; null clears
export function focusClock(el, name) {
  const st = clockState.get(el);
  const c = instances.get(el);
  if (!st || !c) return;
  const next = name != null && st.names.includes(name) && !st.off.has(name) ? name : null;
  if (next === st.hovered) return;
  st.hovered = next;
  // Faded, as hover in the rolling chart is
  setOptionFaded(c, { series: st.all.map((n, k) => ({ id: `c${k}`, ...clockLook(st, k) })) }, undefined, dur(FADE_MS));
}

// Contributors by total hours, with the viewer's bin picked out in the accent.
export function renderHistogram(el, hours, yours) {
  const t = tokens();
  const max = Math.max(...hours, yours ?? 0);
  const step = [50, 100, 250, 500, 1000, 2500].find((s) => max / s <= 24) ?? 5000;
  const bins = new Array(Math.floor(max / step) + 1).fill(0);
  for (const h of hours) bins[Math.floor(h / step)]++;
  const you = yours == null ? -1 : Math.floor(yours / step);
  const range = (i) => `${(i * step).toLocaleString()}–${((i + 1) * step).toLocaleString()} h`;

  chart(el).setOption(
    {
      animationDuration: ENTER_MS,
      grid: { left: 40, right: 16, top: 24, bottom: 32 },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p) =>
          `<b>${p.value} ${p.value === 1 ? "person" : "people"}</b> <span style="opacity:.75">${range(p.dataIndex)}</span>` +
          (p.dataIndex === you ? `<div style="opacity:.75">You're here</div>` : ""),
      },
      xAxis: {
        type: "category",
        data: bins.map((_, i) => (i * step).toLocaleString()),
        ...baseAxis(t),
        splitLine: { show: false },
      },
      yAxis: { type: "value", minInterval: 1, ...baseAxis(t), axisLine: { show: false } },
      series: [
        {
          type: "bar",
          barMaxWidth: 24,
          data: bins.map((v, i) => ({
            value: v,
            itemStyle: { color: i === you ? t.accent : t.other, borderRadius: [4, 4, 0, 0] },
          })),
          // A marker rather than a bar label, so it shows even when no one else is in your bin
          markLine: you < 0 ? undefined : {
            silent: true,
            symbol: "none",
            lineStyle: { color: t.accent, width: 2, type: "solid" },
            label: { formatter: "You", color: t.primary, fontWeight: 600 },
            data: [{ xAxis: you }],
          },
        },
      ],
    },
    { notMerge: true }
  );
}

// Share of listening by hour of day: viewer vs community.
export function renderHourLines(el, community, yours) {
  const t = tokens();
  const labels = Array.from({ length: 24 }, (_, h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`));
  const series = [{ name: "Community", data: community, color: t.muted }];
  if (yours) series.push({ name: "You", data: yours, color: t.accent });

  chart(el).setOption(
    {
      animationDuration: ENTER_MS,
      grid: { left: 40, right: 16, top: 40, bottom: 32 },
      legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 14, itemHeight: 2, itemStyle: { borderWidth: 0 }, textStyle: { color: t.secondary } },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 } },
        formatter: (params) =>
          `<div style="color:${t.muted};margin-bottom:4px">${labels[params[0].dataIndex]}</div>` +
          params.map((p) => row(p.color, (p.value * 100).toFixed(1) + "%", p.seriesName)).join(""),
      },
      xAxis: { type: "category", data: labels, boundaryGap: false, ...baseAxis(t), splitLine: { show: false } },
      yAxis: {
        type: "value",
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => `${Math.round(v * 100)}%` },
      },
      series: series.map((s) => ({
        name: s.name,
        type: "line",
        color: s.color,
        data: s.data,
        showSymbol: false,
        symbolSize: 8,
        lineStyle: { width: 2, color: s.color, cap: "round", join: "round" },
        itemStyle: { color: s.color, borderColor: t.surface, borderWidth: 2 },
      })),
    },
    { notMerge: true }
  );
}


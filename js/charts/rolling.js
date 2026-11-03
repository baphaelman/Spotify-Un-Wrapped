// Top Artists View (renderRolling) and Hours per week, the strip under it: their morphs, pans and ridges, and the
// hooks the rest of the page follows them by. Read docs/rolling-chart.md before changing this file.

import { FADE_MS, MORPH_MS, EASE_IN_OUT, drawnShapes, setOptionFaded, easeInOut, travel, dur, litLook, isLitLook } from "../motion.js";
import { shownName, putOff, owes } from "../state.js";
import { tune } from "../tune.js";
import { tokens, mix } from "../colors.js";
import { fmtHoursRound } from "../format.js";
import { baseAxis, chart, fitTip, instances, row, subRow, tooltipBase } from "./core.js";

// How many part slots each band needs, by band: as many as it has parts, or data.parts.slots[k] if more
const slotsMax = (a, b) => Array.from({ length: Math.max(a.length, b.length) }, (_, k) => Math.max(a[k] ?? 0, b[k] ?? 0));
const partSlots = (parts) => (parts ? slotsMax(parts.share.map((list) => list.length), parts.slots ?? []) : []);

// Legend selections per rolling chart, kept across morphs and reset when the artist list changes.
const rollingState = new WeakMap();

// [startValue, endValue] of a chart's current zoom, so re-renders can keep the reader's place.
export function currentZoom(el) {
  const dz = instances.get(el)?.getOption()?.dataZoom?.[0];
  if (Number.isFinite(dz?.startValue)) return [dz.startValue, dz.endValue];
  // With every series hidden, ECharts reports the range as NaN; fall back to the last one the rolling
  // chart had
  return rollingState.get(el)?.zoom;
}

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

// A rolling chart's hours strip: a second chart (the Hours per week card), drawn in hours mode from the same
// artists, that follows every render, zoom and hover of the main one (and lights the main one when hovered).
// The main chart holds the legend selection and the pins; the strip copies them on each render.
const stripOf = new WeakMap();
const mainOf = new WeakMap();
export function linkStrip(el, strip) {
  stripOf.set(el, strip);
  mainOf.set(strip, el);
}

// The strip as ridgelines (the card's "Separate artists"): each artist's line on a baseline of its own, in rank order
// from the top, each tune.ridgeGap px above the one below or more for a tall one below it (ridgeLayout), on one shared
// scale that keeps every peak in range on the plot (the tallest at least RIDGE_PEAK px, the strip growing if it
// must). The y axis then counts pixels up from the bottom baseline. Same series as the lines, so switching morphs point
// by point; the plot keeps its height and the bottom baseline is the lines' floor, so the bottom line stays put.
const ridged = new WeakSet();
const STRIP_H = 400; // the strip's height as lines (.chart.strip in css/style.css)
const STRIP_TOP = 14, STRIP_BOTTOM = 28, RIDGE_PEAK = 90, RIDGE_LEFT = 150;
const NAME_H = 16, NAME_PITCH = 18; // the strip's names (.ridge-name), and their spacing as lines (or the ridges', if closer)
export function setRidges(strip, on) {
  if (on === ridged.has(strip)) return;
  if (on) ridged.add(strip);
  else ridged.delete(strip);
  const st = rollingState.get(strip);
  if (!st?.args || owes(strip.closest(".card"))) return; // (well off screen, it catches up as it comes near)
  const [d, n, w, , m, o, p, sl, sm] = st.args;
  const [fd, fn, fsl] = st.final ?? [d, n, sl];
  renderRolling(strip, fd, fn, w, currentZoom(strip), m, o, dur(MORPH_MS), p, fsl, sm);
}

// Places names in the order given (top to bottom) at least `gap` apart, each as near its target y as that allows
// (the least-squares fit, by pooling neighbours that crowd), within [lo, hi]
function nudge(want, gap, lo, hi) {
  const pools = [];
  want.forEach((w, j) => {
    pools.push({ sum: w - j * gap, n: 1 });
    while (pools.length > 1) {
      const b = pools[pools.length - 1], a = pools[pools.length - 2];
      if (a.sum / a.n <= b.sum / b.n) break;
      pools.splice(-2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  });
  const y = pools.flatMap((p) => Array(p.n).fill(p.sum / p.n)).map((v, j) => v + j * gap);
  const shift = Math.max(0, lo - (y[0] ?? lo)) - Math.max(0, (y.at(-1) ?? hi) - hi);
  return y.map((v) => v + shift);
}

// Ridges for rows (top to bottom) with peaks (name → hours per week in range): the plot's height (at least minH,
// more if the tallest peak needs it to reach RIDGE_PEAK px), each baseline (px up from the plot's floor) and the scale
// (px per hour). Each ridge stands tune.ridgeGap above the one below it or, if more, tune.ridgeFollow of that one's
// peak, so a tall ridge lifts the ones above it clear rather than covering them. The scale is the largest that keeps
// every peak on the plot; with an even gap (ridgeFollow 0), the tallest peak from the top baseline.
function ridgeLayout(rows, peaks, minH) {
  const g = tune.ridgeGap, f = tune.ridgeFollow;
  const max = Math.max(0.1, ...rows.map((n) => peaks.get(n) ?? 0));
  const place = (k) => {
    const at = new Map();
    let y = 0, top = 0, below = null;
    for (const n of [...rows].reverse()) {
      if (below != null) y += Math.max(g, f * below * k);
      at.set(n, y);
      below = peaks.get(n) ?? 0;
      top = Math.max(top, y + (f ? below : max) * k);
    }
    return { at, top };
  };
  const h = Math.max(minH, place(RIDGE_PEAK / max).top);
  // (the top only grows with the scale)
  let lo = 0, hi = h / max;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (place(mid).top > h) hi = mid;
    else lo = mid;
  }
  return { h, at: place(lo).at, k: lo };
}

// The strip's height follows its ridges. The page below moves on the morph's clock (the frame's height transitions),
// while the canvas grows at once, with nothing on it moving (the plot is placed from the top), and shrinks once the
// morph has landed.
function sizeStrip(el, c, h, ms) {
  const frame = el.parentElement;
  clearTimeout(el._settle);
  const settle = () => {
    el.style.height = `${h}px`;
    if (c.getHeight() !== h) c.resize();
    frame.style.transition = frame.style.height = "";
  };
  const was = frame.getBoundingClientRect().height; // (mid-transition, where it is now)
  if (!ms || !was || Math.abs(was - h) < 0.5) return settle();
  if (c.getHeight() < h) {
    el.style.height = `${h}px`;
    c.resize();
  }
  frame.style.transition = "none";
  frame.style.height = `${was}px`;
  frame.getBoundingClientRect();
  frame.style.transition = `height ${ms}ms ${EASE_IN_OUT.css}`;
  frame.style.height = `${h}px`;
  el._settle = setTimeout(settle, ms);
}

// The strip's names at its left, level with where each line starts, each before a dash of its color: HTML over the chart, so a long one ellipsizes. Each
// is kept from render to render, so it glides with the morph. at: [name, y of its middle in the frame] (level with its
// line's left end, nudged clear of the others), for the artists drawn; the rest fade out. Hovering one is hovering its line,
// and clicking it pins or unpins, as lines or ridges. act: { hover(name), toggle(name) }, the latest render's.
function paintRidgeNames(el, at, ms, pinned, colors, act) {
  const box = el.parentElement.querySelector(".ridge-names");
  if (!box) return;
  box._act = act;
  box.style.setProperty("--ridge-ms", `${ms}ms`);
  const have = new Map([...box.children].map((n) => [n.dataset.artist, n]));
  for (const [name, y] of at) {
    let n = have.get(name);
    const place = `translateY(${y - NAME_H / 2}px)`;
    if (!n) {
      n = document.createElement("div");
      n.className = "ridge-name";
      n.dataset.artist = name;
      n.textContent = shownName(name); // artist names come from user files
      n.addEventListener("pointerenter", () => box._act.hover(name));
      n.addEventListener("pointerleave", () => box._act.hover(null));
      n.addEventListener("click", () => box._act.toggle(name));
      n.style.transform = place;
      box.append(n);
      n.getBoundingClientRect(); // (so it fades in where it is)
    }
    n.style.transform = place;
    n.style.setProperty("--c", colors.get(name));
    n.classList.add("on");
    n.classList.toggle("pinned", pinned.has(name));
    n.title = `${pinned.has(name) ? "Unpin" : "Pin"} ${shownName(name)}`;
    have.delete(name);
  }
  for (const n of have.values()) {
    n.classList.remove("on", "focus");
    setTimeout(() => !n.classList.contains("on") && n.remove(), ms);
  }
}
// The hovered artist's name lights with its line
function litRidgeName(el, name) {
  const box = el.parentElement.querySelector(".ridge-names");
  for (const n of box?.children ?? []) n.classList.toggle("focus", n.dataset.artist === name && n.classList.contains("on"));
}
let relaying = false; // a hover passed from one to the other isn't passed back
// The hours axis top for a tallest line m: a little headroom, rounded up to a step that grows with m (0.5 h under 5,
// then whole hours, then 5s), so a small peak isn't left with a third of the chart empty
const niceTop = (m) => {
  const step = m < 5 ? 0.5 : m < 20 ? 1 : 5;
  return Math.max(1, Math.ceil((m * 1.04) / step) * step);
};
// The hours axis top for the zoom range: the tallest shown line in it. A line leaves the range between two points,
// so the value where it crosses each edge counts, not the whole point just past it
function hoursTop(data, names, window, hasOther, hide, zoom) {
  return niceTop(hoursPeak(data, names, window, hasOther, hide, zoom));
}
// The tallest shown line in the zoom range, as it is
function hoursPeak(data, names, window, hasOther, hide, zoom) {
  let m = 0;
  names.forEach((n, s) => {
    if (hasOther && s === names.length - 1) return;
    if (hide?.[n] === false) return;
    m = Math.max(m, linePeak(data, s, window, zoom));
  });
  return m;
}
// Artist s's tallest in the zoom range. A line leaves the range between two points, so the value where it crosses
// each edge counts, not the whole point just past it
function linePeak(data, s, window, zoom) {
  let m = 0;
  const n = data.dates.length;
  const at = (i) => (data.share[s][i] != null ? (data.hours[s][i] / window) * 7 : null);
  for (let i = 0; i < n; i++) {
    const d = data.dates[i];
    const v = at(i);
    if (v == null) continue;
    if (d >= zoom[0] && d <= zoom[1]) m = Math.max(m, v);
    else if (i + 1 < n && d < zoom[0] && data.dates[i + 1] > zoom[0]) {
      const w = at(i + 1);
      if (w != null) m = Math.max(m, v + ((w - v) * (zoom[0] - d)) / (data.dates[i + 1] - d));
    } else if (i > 0 && d > zoom[1] && data.dates[i - 1] < zoom[1]) {
      const w = at(i - 1);
      if (w != null) m = Math.max(m, w + ((v - w) * (zoom[1] - data.dates[i - 1])) / (d - data.dates[i - 1]));
    }
  }
  return m;
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
    const token = rollingState.get(el).renderToken;
    setTimeout(() => {
      if (rollingState.get(el)?.renderToken !== token) return; // something re-rendered since
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
    const token = rollingState.get(el).renderToken;
    setTimeout(() => rollingState.get(el)?.renderToken === token && draw(data, false), ms); // unless re-rendered since
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

// A change of artists (a pin from outside the chart, the artist count, a new period's) as things coming and going
// rather than series morphing into one another. Series can't tween in or out, and they're matched by position, so
// the change is drawn on the union of the old and new artists, in up to three steps:
//  1. The old picture again, on the union (instantly, so nothing moves): newcomers are there with no thickness
//     (share) or drawn at their final values but clipped away to the plot's left edge (hours).
//  2. The morph: share bands grow from no thickness or shrink to none; hours lines that arrive draw in from left to
//     right (paintReveals) while those that leave sink to 0 and fade out.
//  3. Once it's done, the new artists alone (instantly, the same picture).
// Share mode needs the artists who stay to keep their order (a band can't pass through another); a new period's,
// re-ranked, morphs as before. Step 1 is skipped when the union is what's on screen already (artists only leaving),
// and an interrupted change starts from where its bands had got to (flightData), so a dragged artist count keeps up.
// Returns true if it handled this render.
let artistCtx = null; // set while those steps draw: { el, report, strip, fade, yMax } (see renderRolling)
let redrawing = false; // set while a morph first redraws what's on screen (its selection isn't news, and the strip has no parts)
const SEP = "\u0000";
function withArtistMorph(el, data, names, window, zoom, mode, hasOther, morph, pins, slots, smooth) {
  const st = rollingState.get(el);
  // (the strip, drawn within the main chart's change, makes its own: it's other series, and lines come and go their own way)
  if (!morph || morph.pan || morph.live || artistCtx?.el === el || !st?.args || !data.share.length) return false;
  if (st.mode !== mode || st.hasOther !== hasOther || st.window !== window) return false;
  const A = artistsOf(st.names, hasOther), B = artistsOf(names, hasOther);
  if (A.join(SEP) === B.join(SEP)) return false;
  const { ms: rawMs, easing = EASE_IN_OUT.echarts } = typeof morph === "object" ? morph : { ms: morph === true ? MORPH_MS : morph };
  const ms = dur(rawMs);
  const oldData = flightData(st) ?? st.args[0];
  if (!ms || oldData.dates.length !== data.dates.length || !!oldData.parts !== !!data.parts) return false;
  const inA = new Set(A), inB = new Set(B);
  const share = mode === "share";
  let U;
  if (share) {
    if (A.filter((n) => inB.has(n)).join(SEP) !== B.filter((n) => inA.has(n)).join(SEP)) return false;
    // Each leaver keeps its place among the artists who stay, each newcomer takes its own
    U = [];
    for (let i = 0, j = 0; i < A.length || j < B.length;) {
      if (i < A.length && !inB.has(A[i])) U.push(A[i++]);
      else if (j < B.length && !inA.has(B[j])) U.push(B[j++]);
      else (U.push(A[i]), i++, j++);
    }
  } else U = [...A, ...B.filter((n) => !inA.has(n))]; // lines overlap, so order hardly shows: keep the old seats
  const uNames = hasOther ? [...U, "Everyone else"] : U;
  const arrivals = B.filter((n) => !inA.has(n));
  const leavers = A.filter((n) => !inB.has(n));
  const iOld = new Map(st.names.map((n, i) => [n, i]));
  const iNew = new Map(names.map((n, i) => [n, i]));
  const oldSlots = st.args[7];
  const uSlots = uNames.map((n) => (iNew.has(n) ? slots?.[iNew.get(n)] : oldSlots?.[iOld.get(n)]));
  const zero = (row) => row.map((v) => (v == null ? null : 0));
  // Each union artist's rows from the old data (before) or the new (after); someone not in it gets none
  const build = (before) => {
    const pick = (old, fresh, n, flat) => {
      const from = before ? (iOld.has(n) ? [old, iOld.get(n)] : [fresh, iNew.get(n)]) : iNew.has(n) ? [fresh, iNew.get(n)] : [old, iOld.get(n)];
      const row = from[0][from[1]];
      const gone = before ? !iOld.has(n) : !iNew.has(n);
      return gone && flat ? (Array.isArray(row?.[0]) ? row.map(zero) : row && zero(row)) : row;
    };
    const rows = (key, flat) => uNames.map((n) => pick(oldData[key], data[key], n, flat));
    const partRows = (key) => uNames.map((n) => pick(oldData.parts[key], data.parts[key], n, true));
    // Share: whoever isn't in the picture has no thickness. Hours: a newcomer is drawn at its values (clipped
    // away until it draws in), a leaver lies on 0 (fading out)
    return {
      ...data,
      share: rows("share", share || !before),
      hours: rows("hours", share || !before),
      parts: data.parts && { ...data.parts, names: uNames.map((n) => pick(oldData.parts.names, data.parts.names, n, false)), share: partRows("share"), hours: partRows("hours") },
    };
  };
  const before = build(true), after = build(false);
  const c = instances.get(el);
  const outer = artistCtx;
  try {
    if (!share && arrivals.length) {
      const R = reveals.get(el) ?? new Map();
      reveals.set(el, R);
      const t0 = performance.now();
      for (const n of arrivals) R.set(n, { t0, ms, ease: easing === EASE_IN_OUT.echarts ? easeInOut : (x) => x });
    }
    if (uNames.join(SEP) !== st.names.join(SEP)) {
      const yMax = share ? null : c?.getModel().getComponent("yAxis", 0)?.axis.scale.getExtent()[1];
      // Lines already leaving when this change interrupted the last one carry on gone
      const fade = new Set(st.flight?.fade ?? []);
      // (ridges: the rows it's coming from, see renderRolling)
      artistCtx = { el, report: B, strip: null, fade, yMax: Number.isFinite(yMax) ? yMax : null, rows: A, next: { rows: B, data: after, zoom } };
      renderRolling(el, before, uNames, window, currentZoom(el) ?? zoom, mode, hasOther, false, pins, uSlots, st.args[8]);
    }
    artistCtx = { el, report: B, strip: { data, names, slots }, fade: share ? null : new Set(leavers), rows: B };
    renderRolling(el, after, uNames, window, zoom, mode, hasOther, { ms, easing }, pins, uSlots, smooth);
  } finally {
    artistCtx = outer;
  }
  const now = rollingState.get(el);
  now.flight = { names: uNames.join(SEP), from: before, to: after, t0: performance.now(), ms, fade: share ? [] : leavers };
  now.final = [data, names, slots];
  if (uNames.join(SEP) !== names.join(SEP)) {
    const token = now.renderToken;
    setTimeout(() => {
      const st = rollingState.get(el);
      if (st?.renderToken !== token) return; // something re-rendered since
      // The same picture with the new artists alone; whatever's under the pointer stays lit
      artistCtx = { el, report: B, strip: null };
      st.keepFocus = st.focused;
      try {
        renderRolling(el, data, names, window, currentZoom(el) ?? zoom, mode, hasOther, false, pins, slots, smooth);
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

// The rows on screen now, partway through an artist change: each band's values blended along the morph's curve, so
// a change that interrupts it starts from what's drawn rather than from where it was going
function flightData(st) {
  const F = st.flight;
  if (!F || F.names !== st.names.join(SEP)) return null;
  const p = (performance.now() - F.t0) / F.ms;
  if (!(p < 1)) return null;
  const e = easeInOut(Math.max(0, p));
  // Shaped like where it's going: an artist's albums or songs can number differently at each end, and a row or
  // value missing at the start is taken as it ends
  const lerp = (a, b) => (a == null || b == null ? b : Array.isArray(b[0]) ? b.map((r, j) => lerp(a[j], r)) : b.map((v, i) => (v == null || a[i] == null ? v : a[i] + (v - a[i]) * e)));
  const rows = (a, b) => b.map((r, k) => lerp(a?.[k], r));
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

// Long periods are drawn at about one point per pixel. A short window over years zigzags at a few points a pixel,
// and drawing every one (mostly the band borders) is what made those charts slow. The points kept are every
// stride-th day counted from the epoch, plus the first and last, so every series and every step of a sweep keep the
// same ones, and thinning twice changes nothing. Strides are powers of two, so a coarser one's points are among a
// finer one's. A chart with fewer days on screen than pixels is drawn in full.
const DAY_MS = 864e5;
function strideFor(el, dates, zoom) {
  const px = el.clientWidth;
  const span = Number.isFinite(zoom?.[0]) ? zoom[1] - zoom[0] : dates[dates.length - 1] - dates[0];
  if (!px || !(span > 0)) return 1;
  return 2 ** Math.max(0, Math.ceil(Math.log2(span / DAY_MS / px)));
}
const thinMemo = new WeakMap(); // data → Map stride → thinned
const sourceOf = new WeakMap(); // thinned → the data it was thinned from
function thin(data, stride) {
  const src = sourceOf.get(data) ?? data;
  if (stride <= 1) return src;
  const memo = thinMemo.get(src) ?? new Map();
  thinMemo.set(src, memo);
  if (memo.has(stride)) return memo.get(stride);
  const last = src.dates.length - 1;
  const keep = [];
  src.dates.forEach((d, i) => (i === 0 || i === last || Math.round(d / DAY_MS) % stride === 0) && keep.push(i));
  let out = src;
  if (keep.length < src.dates.length) {
    const pick = (row) => row && keep.map((i) => row[i]);
    const parts = src.parts && { ...src.parts, hours: src.parts.hours?.map((l) => l.map(pick)), share: src.parts.share?.map((l) => l.map(pick)) };
    out = { ...src, dates: pick(src.dates), hours: src.hours.map(pick), share: src.share.map(pick), parts };
    sourceOf.set(out, src);
  }
  memo.set(stride, out);
  return out;
}
const strides = new WeakMap(); // el → the stride drawn
const striding = new Set(); // charts whose outermost render is running: every render within it keeps its stride
// Redraws what's on screen at another stride, instantly, so a morph that follows has the same points on both ends.
// Done only where the change hardly shows: a period's widest end. A stand-in drawn mid-change (withArtistMorph's
// union, a zero band) can't be redrawn finer; the stride stays and the next render catches up.
function restride(el, stride) {
  const st = rollingState.get(el);
  if (!st?.args || stride === (strides.get(el) ?? 1)) return false;
  const [d, n, w, , m, o, p, sl, sm] = st.args;
  if (stride < (strides.get(el) ?? 1) && !sourceOf.has(d)) return false;
  strides.set(el, stride);
  chart(el).dispatchAction({ type: "hideTip" });
  // Drawn with the selection it was drawn with, as the parts' redraw does (see renderRolling)
  const sel = st.selected, wasRedrawing = redrawing, outer = striding.has(el);
  st.selected = st.drawnSel ?? sel;
  redrawing = true;
  striding.add(el);
  try {
    renderRolling(el, d, n, w, currentZoom(el), m, o, false, p, sl, sm);
  } finally {
    redrawing = wasRedrawing;
    st.selected = sel;
    if (!outer) striding.delete(el);
  }
  return true;
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
// Share mode draws each band as a pale tint of the artist's color (t.shade.rest), outlined on both edges
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
  // The outermost render picks the stride (see strideFor) for every render within it. A live morph keeps the one
  // drawn; a pan takes the finer of its two ends before it sets off, and lands on the new one's after
  if (!striding.has(el)) {
    const drawn = strides.get(el) ?? 1;
    let want = morph?.live ? drawn : strideFor(el, data.dates, zoom);
    if (morph?.pan) want = Math.min(want, strideFor(el, data.dates, currentZoom(el)));
    striding.add(el);
    try {
      if (!morph || !rollingState.get(el)?.args) strides.set(el, want);
      else restride(el, want);
      const strip = morph?.pan && stripOf.get(el);
      if (strip && (strides.get(strip) ?? 1) > want) restride(strip, want);
      renderRolling(el, data, names, window, zoom, mode, hasOther, morph, pins, slots, smooth);
    } finally {
      striding.delete(el);
    }
    return;
  }
  data = thin(data, strides.get(el) ?? 1);
  // Any render ends a pan or a live morph in progress
  const prev = rollingState.get(el);
  if (prev?.panRaf) {
    cancelAnimationFrame(prev.panRaf);
    prev.panRaf = 0;
    if (!morph?.pan) prev.panEnd?.(); // whatever rides the pan lands with it (a newer pan carries on from where it was)
  }
  // New artists (a pin, the artist count, a new period's): they grow in and the leavers shrink away
  if (withArtistMorph(el, data, names, window, zoom, mode, hasOther, morph, pins, slots, smooth)) return;
  // Hours mode (a live morph, which withArtistMorph leaves alone): lines are matched by series id (their rank), so an artist who moves up or down the ranking
  // would tween through a neighbour's line, and one who stays would seem to regrow. Seat the drawn lines by
  // artist first (an instant, invisible re-draw), so each returning artist's line is its own series and only
  // the artists who change places move into each other's. Share mode's bands are ranked, so it can't.
  if (morph && !morph.pan && mode === "hours" && prev?.mode === "hours" && prev.args && prev.hasOther === hasOther && prev.window === window &&
      prev.names.length === names.length && prev.names.join("\u0000") !== names.join("\u0000")) {
    const n = artistsOf(names, hasOther).length;
    const old = artistsOf(prev.names, hasOther);
    const from = names.slice(0, n).map((a) => old.indexOf(a));
    const free = old.map((_, j) => j).filter((j) => !from.includes(j));
    const seat = from.map((j) => (j >= 0 ? j : free.shift()));
    const [oldData, , , , , , , , oldSmooth] = prev.args;
    const pick = (rows) => rows.map((_, k) => rows[k < n ? seat[k] : k]);
    const parts = oldData.parts && { ...oldData.parts, names: pick(oldData.parts.names), share: pick(oldData.parts.share), hours: pick(oldData.parts.hours) };
    renderRolling(el, { ...oldData, share: pick(oldData.share), hours: pick(oldData.hours), parts }, names, window, currentZoom(el), mode, hasOther, false, pins, slots, oldSmooth);
    return renderRolling(el, data, names, window, zoom, mode, hasOther, morph, pins, slots, smooth);
  }
  const liveFrom =
    morph?.live && prev?.mode === mode && prev.hasOther === hasOther && prev.window === window &&
    prev.names.length === names.length && prev.values?.dates === data.dates.length ? liveValues(prev) : null;
  stopLive(prev);
  if (morph?.live && !liveFrom) morph = false;
  // A period change ({ms, easing, pan: true}) first scrolls (or zooms) the plot to the new range with the
  // artists already on screen, as if dragging the zoom slider, then morphs the bands into the new
  // period's artists. That needs the same series on screen; otherwise it redraws.
  if (morph?.pan) {
    // (the window can differ: switching to the tracks view changes it, and the pan is drawn with the old one)
    const same = prev && prev.mode === mode && prev.hasOther === hasOther && prev.names.length === names.length;
    const from = same && currentZoom(el);
    // All time has no zoom range of its own; give it the whole timeline so there's a range to travel to
    if (same && !Number.isFinite(zoom?.[0]) && data.dates.length) zoom = [data.dates[0], data.dates[data.dates.length - 1]];
    if (Number.isFinite(from?.[0]) && Number.isFinite(zoom?.[0]) && (from[0] !== zoom[0] || from[1] !== zoom[1])) {
      // Hours: the axis top the lines on screen need over the new range, to travel to alongside it. (The new
      // artists' top comes with their morph; going there now would shrink the old lines while they pan.)
      const travelMax = (el) => {
        const now = instances.get(el)?.getModel().getComponent("yAxis", 0)?.axis.scale.getExtent()[1];
        const shown = prev.args;
        return Number.isFinite(now) && shown ? { from: now, to: hoursTop(shown[0], prev.names, shown[2], prev.hasOther, prev.selected, zoom) } : null;
      };
      const strip = stripOf.get(el);
      panTo(el, from, zoom, morph, () => renderRolling(el, data, names, window, zoom, mode, hasOther, true, pins, slots, smooth),
        mode === "hours" ? travelMax(el) : null, strip && rollingState.get(strip) && !owes(strip.closest(".card")) && { el: strip, yMax: ridged.has(strip) ? null : travelMax(strip) });
      return;
    }
    else morph?.onFrame?.(1); // no trip to make: whatever follows the pan lands at once
    morph = same;
  }
  const { ms, easing = EASE_IN_OUT.echarts } = morph && typeof morph === "object" ? morph : { ms: morph === true ? MORPH_MS : morph || 0 };
  if (ms && withOtherMorph(el, data, names, window, zoom, mode, hasOther, ms, pins, slots, smooth)) return;
  if (ms && withSplitMorph(el, data, names, window, zoom, mode, hasOther, ms, pins, slots, smooth)) return;
  // The parts' slots: each band has as many as it has parts (agg.topParts caps the parts of the whole chart, so one
  // artist can have many). A morph that needs more slots than are drawn first redraws what's on screen with the
  // extra ones, empty, so the new parts grow out of them; one that needs fewer keeps the old slots until it lands,
  // then trims them (below)
  const needSlots = partSlots(data.parts);
  const hadSlots = prev?.partSlots ?? [];
  if (ms && !morph?.live && prev?.mode === mode && prev.args?.[0].parts && needSlots.some((v, k) => v > (hadSlots[k] ?? 0))) {
    const [d, n, w, , m, o, p, sl, sm] = prev.args;
    // (an open tooltip re-shows itself a tick after each render, by then against a chart redrawn again, and throws)
    chart(el).dispatchAction({ type: "hideTip" });
    // Drawn with the selection it was drawn with: an artist just shown or hidden would otherwise snap open or shut
    // here, and the morph would only grow their parts up from the floor
    const sel = prev.selected;
    prev.selected = prev.drawnSel ?? sel;
    redrawing = true;
    try {
      renderRolling(el, { ...d, parts: { ...d.parts, slots: slotsMax(needSlots, hadSlots) } }, n, w, currentZoom(el), m, o, false, p, sl, sm);
    } finally {
      redrawing = false;
      prev.selected = sel;
    }
    return renderRolling(el, data, names, window, zoom, mode, hasOther, morph, pins, slots, smooth);
  }
  const nSlots = data.parts && ms ? slotsMax(needSlots, hadSlots) : needSlots;
  const t = tokens();
  // (scaled by the tunables, see tune.js; all ×1 by default)
  const tint = { rest: tune.bandTint, hover: tune.hoverTint, pin: tune.hoverTint, pinHover: tune.hoverTint, dim: tune.dimTint, dimHover: tune.dimTint };
  t.shade = Object.fromEntries(Object.entries(t.shade).map(([look, w]) => [look, w * tint[look]]));
  t.line = Object.fromEntries(Object.entries(t.line).map(([look, w]) => [look, w * tune.lineFill]));
  const c = chart(el);
  const share = mode === "share";
  const otherIdx = hasOther ? names.length - 1 : -1;
  // "Everyone else" is always gray, never borrowing the next artist's slot
  const colors = names.map((_, i) => (i === otherIdx ? t.other : t.series[slots?.[i] ?? i]));
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const isStrip = mainOf.has(el);
  const ridge = isStrip && !share && ridged.has(el); // (see setRidges)
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
  st.hasOther = hasOther;
  st.window = window;
  st.partSlots = nSlots;
  st.args = [data, names, window, zoom, mode, hasOther, pins, slots, smooth];
  st.drawnSel = { ...st.selected };
  if (Number.isFinite(zoom?.[0])) st.zoom = zoom; // for currentZoom, if hiding every artist loses the range
  const visible = (s) => st.selected[names[s]] !== false;
  // Hours: a line leaving in an artist change (withArtistMorph) sinks to 0 and fades out as it goes
  const fading = (s) => !!artistCtx?.fade?.has(names[s]);

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

  // Ridges (see setRidges): a row for each artist shown, in rank order from the top; mid artist change, the rows of
  // the artists it's coming from, then going to (withArtistMorph). An artist without a row (hidden, or not arrived)
  // lies flat where it will stand once it has one, faded out, so it draws in or rises there rather than climbing to
  // it; one leaving sinks onto its own. The peaks are held through an artist change's first step, which redraws what's
  // on screen.
  // As lines, the strip lists the same names in the same order, packed up from the plot's floor, NAME_PITCH apart or
  // the ridges' gap if that's closer: switching only spreads them up from the bottom one, if at all. A hidden artist has no row or name, as if it weren't there.
  // As lines the strip sets its own axis top (the tallest shown line in range). The plot is as tall either way.
  const LINES_H = STRIP_H - STRIP_TOP - STRIP_BOTTOM;
  let ridgeBase = null, ridgeK = 0, plotH = LINES_H;
  const order = (artistCtx?.el === el && artistCtx.rows) || artistsOf(names, hasOther);
  const nameRows = isStrip && !share ? order.filter((n) => names.includes(n) && visible(names.indexOf(n)) && !fading(names.indexOf(n))) : [];
  const inRange = Number.isFinite(zoom?.[0]) ? zoom : [-Infinity, Infinity];
  const peaksOf = (d, z) => new Map(names.map((n, s) => [n, linePeak(d, s, window, z)]));
  const heldPeaks = artistCtx?.el === el && artistCtx.yMax != null && prev?.ridgePeaks;
  const peaks = !isStrip || share ? null
    : heldPeaks ? new Map(names.map((n, s) => [n, heldPeaks.get(n) ?? linePeak(data, s, window, inRange)])) : peaksOf(data, inRange);
  const lay = peaks && ridgeLayout(nameRows, peaks, LINES_H);
  if (lay) plotH = lay.h;
  if (ridge) {
    // Where an artist without a row will stand: in the artist change's next step, or once shown. (Baselines count up
    // from the floor, which moves by as much as the plot's height changes.)
    const next = artistCtx?.el === el && artistCtx.next;
    const nextLay = next && ridgeLayout(next.rows.filter((n) => names.includes(n) && visible(names.indexOf(n))),
      peaksOf(next.data, Number.isFinite(next.zoom?.[0]) ? next.zoom : inRange), LINES_H);
    const landing = (n, s) => {
      if (s === otherIdx) return null;
      if (nextLay?.at.has(n)) return nextLay.at.get(n) - (nextLay.h - plotH);
      const list = order.includes(n) ? order : names;
      const L = ridgeLayout(list.filter((m) => lay.at.has(m) || m === n), peaks, LINES_H);
      return L.at.get(n) - (L.h - plotH);
    };
    ridgeBase = names.map((n, s) => lay.at.get(n) ?? (fading(s) ? prev?.ridgeAt?.get(n) : null) ?? landing(n, s) ?? 0);
    st.ridgeAt = new Map(names.map((n, s) => [n, ridgeBase[s]]));
    ridgeK = lay.k;
    st.ridgeRows = lay.at;
  }
  if (peaks) st.ridgePeaks = peaks;
  const namePitch = Math.min(NAME_PITCH, tune.ridgeGap);
  const range = [Number.isFinite(zoom?.[0]) ? zoom[0] : data.dates[0], Number.isFinite(zoom?.[1]) ? zoom[1] : data.dates[data.dates.length - 1]];
  const stripMax = isStrip && !share && !ridge ? (artistCtx?.yMax ?? hoursTop(data, names, window, hasOther, st.selected, range)) : null;
  // An hours line's height on the plot: its hours, or as a ridge, its baseline plus its hours to scale. The strip's
  // names stand apart at the left; no line runs to them
  const lineY = (s, i) => {
    const v = hoursAt(s, i);
    return v == null || !ridge ? v : ridgeBase[s] + v * ridgeK;
  };

  // Each artist's parts (data.parts: its albums or songs, see agg.rolling), in nSlots[k] slots for band k. In
  // share mode they stack up from the band's floor, biggest first, and the band's own fill above them is the
  // rest; a slot with no part (or a hidden artist's) has no thickness. In hours mode each is a thin line.
  const parts = data.parts;
  const partRows = (k) => parts?.share[k] ?? [];
  const partKeys = parts ? names.flatMap((_, k) => (k === otherIdx ? [] : Array.from({ length: nSlots[k] ?? 0 }, (_, j) => [k, j]))) : [];
  const partTop = names.map((_, k) => {
    if (!parts || k === otherIdx) return [];
    const rows = partRows(k);
    const out = [];
    let run = bottom[k];
    for (let j = 0; j < (nSlots[k] ?? 0); j++) {
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
    points((i) => (bottom[s][i] == null ? null : !share ? lineY(s, i) : side === "t" ? top[s][i] : bottom[s][i]));
  // Visible widths 1.5px, or 2.5px for pinned bands (tune.edgeWidth, and 1 more: only a pin outlines, a hover
  // only shades), doubled since half is clipped away; hours mode hides them
  const overlayStyle = (s) => ({ width: 2 * (base.has(s) ? tune.edgeWidth + 1 : tune.edgeWidth), color: colors[s], opacity: share && visible(s) ? 1 : 0, cap: "butt", join: "round" });

  // The pinned artists (drawn ones only). With the one under the pointer (or hovered in the legend or a list),
  // they set each artist's look by the hover/pin rule (litLook, docs/motion.md). Built into the options below as
  // well as applied on hover, so a re-render or a mode morph keeps the pinned artists lit. Everything below takes
  // h, the hovered artist's index or null.
  const base = new Set(names.flatMap((n, k) => (pins?.has(n) && visible(k) && k !== otherIdx ? [k] : [])));
  const look = (k, h) => litLook(base, h, k);
  // The artist under the pointer when a click to pin or unpin re-rendered the chart stays lit from the first
  // frame (see zrClick), rather than snapping to rest and fading back in, as does one unpinned anywhere on the
  // page (holdFocus)
  const kept = st.keepFocus == null ? -1 : names.indexOf(st.keepFocus);
  const held = kept < 0 ? null : kept;
  // Fills are opaque tints, not transparency, because bands overlap down to the axis.
  // Share: a band's tint is its look's shade: deeper hovered, deeper still pinned, deepest pinned and hovered; the
  // rest dim a little while one is only hovered and more while one is pinned
  const bandFill = (k, h) => mix(t.surface, colors[k], t.shade[look(k, h)]);
  // Hours: pinned lines are thicker; lit lines (pinned or hovered) stay while the rest fade (less for a hover than
  // while one is pinned: t.fade), and only a lit line gets a faint fill, t.line of its look (a hover's, deeper under
  // a pin, deeper still under a hovered pin; pinned fills are faint enough to simply overlap). The fill is the same
  // tint as a pinned share band, at the opacity that gives that share of the artist's color. Sharing the color means
  // a morph only changes opacity: tweening a band's opaque tint to the artist's full color at low opacity would pass
  // through a stronger fill than either end.
  const hoursFill = colors.map((c) => mix(t.surface, c, t.shade.pin));
  const lineFill = (lk) => Math.min(1, (t.line[lk] ?? 0) / t.shade.pin);
  // (a line leaving in an artist change, fading, has none)
  const hoursArea = (k, h) => (k === otherIdx || fading(k) ? 0 : lineFill(look(k, h)));
  // Ridges are filled as share bands are (an opaque tint of its look), each one's fill covering the ridges above it
  const hoursFillLook = (k, h) =>
    ridge ? { color: bandFill(k, h), opacity: k === otherIdx || !visible(k) || fading(k) ? 0 : 1 } : { color: hoursFill[k], opacity: hoursArea(k, h) };
  // Morphing from share to hours, a pinned artist's fill waits until the lines have settled. Its share
  // band fills all the way down to the axis, hidden under the bands below; fading only partway while
  // theirs fade out would bare it across the whole chart mid-morph. It fades out with them and back in
  // once the morph is done (below).
  const holdFill = morph && !share && st.mode === "share";
  const renderToken = (st.renderToken = (st.renderToken ?? 0) + 1);
  // Slots kept through a morph to fewer parts go once it lands (empty, so nothing on screen changes). Not in an
  // artist change, whose own last step redraws once it lands
  if (!artistCtx && nSlots.some((v, k) => v > (needSlots[k] ?? 0))) {
    setTimeout(() => st.renderToken === renderToken && rollingState.get(el) === st &&
      renderRolling(el, data, names, window, currentZoom(el) ?? zoom, mode, hasOther, false, pins, slots, smooth), ms);
  }
  const restWidth = isStrip ? tune.hoursLine : 2; // the strip's lines are finer
  // Hover only shades a line (the others fade a little and it gets its faint fill); only a pin thickens it
  const lineLook = (k, h) => ({
    width: base.has(k) ? restWidth + 1 : restWidth,
    opacity: (!share && k === otherIdx) || !visible(k) || fading(k) ? 0 : t.fade[look(k, h)],
  });
  // Every artist always shows all its parts; lighting some artists (pinned or hovered) only dims the others'
  const partShown = (k, j) => !!parts && visible(k) && j < partRows(k).length;
  // The part under the pointer ({k, j}, or null): filled deeper than its siblings and outlined on both sides
  let hotPart = null;
  const isHot = (k, j) => hotPart?.k === k && hotPart.j === j;
  // A part's shade: the band's own tint w, deepened by part of the step from a resting band to a pinned one, most
  // for the biggest part (and less in a dimmed band). The four biggest step down; past them the parts alternate
  // between two depths, so any two neighbours differ (their dividers tell the rest apart)
  const PART_DEPTH = [0.8, 0.55, 0.35, 0.18];
  const partDepth = (j) => PART_DEPTH[j] ?? (j % 2 ? 0.06 : 0.3);
  const HOT_DEPTH = 1.6;
  const partShade = (k, j, w, depth = partDepth(j)) =>
    mix(t.surface, colors[k], Math.min(1, w + (t.shade.pin - t.shade.rest) * depth * tune.partDepth * Math.min(1, w / t.shade.rest)));
  const partFill = (k, j, h) =>
    !partShown(k, j) ? bandFill(k, h) : partShade(k, j, t.shade[look(k, h)], isHot(k, j) ? HOT_DEPTH : partDepth(j));
  // Its divider (share), or its line (hours): faint beside its artist's, and fainter while others are lit
  // (the hot part's own divider and the one below it, its outline; a line, in hours mode)
  const partLine = (k, j, h) => {
    const hot = isHot(k, j) || (share && isHot(k, j + 1));
    const lk = look(k, h);
    return {
      width: hot ? 2 : share ? 1 : base.has(k) ? 1.5 : 1.25,
      opacity: !partShown(k, j) ? 0 : hot ? 1 : share ? (t.fade[lk] < 1 ? 0.3 : 0.7) : isLitLook(lk) ? 0.85 : lk === "rest" ? 0.4 : 0.08,
    };
  };
  const partStyles = (h) =>
    partKeys.map(([k, j]) => ({
      id: `p${k}_${j}`,
      lineStyle: partLine(k, j, h),
      ...(share ? { areaStyle: { color: partFill(k, j, h) } } : {}),
    }));

  const series = names
    .map((name, s) => {
      const hide = !share && s === otherIdx;
      return {
        id: `s${s}`,
        name,
        type: "line",
        showSymbol: false,
        symbol: "none",
        smooth,
        color: colors[s],
        // Lower bands paint over the bottom of the ones above them. That order has to be explicit:
        // ECharts paints series in the order their views were created, so artists added later (raising
        // the artist count) would otherwise paint over everything below them
        // Hours mode gives every line one z, so every fill (z2 below the line's) paints under every line: a
        // pinned line's fill never covers the lines below it, nor their ends poking out past its edge
        // Ridges: each paints over the ones above it, line and all
        z: share ? 2 + (names.length - s) / 100 : ridge ? 3 + (plotH - ridgeBase[s]) / (100 * plotH) : 3,
        // Share: hidden; the edge overlays draw each band's borders instead (see edgeData)
        lineStyle: {
          ...(share ? { width: 2, opacity: 0 } : lineLook(s, held)),
          color: colors[s],
          cap: "round",
          join: "round",
        },
        // Every series ignores the pointer; the plot works out what's under it from the data (see zrMove).
        silent: true,
        // Hours mode keeps an invisible fill, so the hovered line's shading and the morph back into
        // bands can fade it in rather than have it appear
        areaStyle: {
          ...(share ? { color: bandFill(s, held), opacity: 1 } : hoursFillLook(s, held)),
          ...(!share && (hide || holdFill) ? { opacity: 0 } : {}),
          origin: ridge ? ridgeBase[s] : "start",
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
        data: points((i) => (share ? top[s][i] : lineY(s, i))),
      };
    })
    // Top band first, matching the paint order above
    .reverse()
    .concat(
      // Each part paints over the band it's in, and over the parts above it, but under the band below
      partKeys.map(([k, j]) => ({
        id: `p${k}_${j}`,
        name: names[k],
        type: "line",
        silent: true,
        showSymbol: false,
        symbol: "none",
        smooth,
        color: colors[k],
        z: share ? 2 + (names.length - k) / 100 + (nSlots[k] + 1 - j) / (100 * (nSlots[k] + 2)) : 2.9,
        lineStyle: { ...partLine(k, j, held), color: colors[k], cap: "butt", join: "round" },
        // An empty slot's fill would only repeat its band's tint, so it isn't painted (it fades out as its part goes,
        // which looks the same as crossfading to the band's tint)
        areaStyle: { color: share ? partFill(k, j, held) : hoursFill[k], opacity: share && partShown(k, j) ? 1 : 0, origin: "start" },
        emphasis: { disabled: true },
        data: points((i) => (share ? partTop[k][j][i] : partHoursAt(k, j, i))),
      }))
    )
    .concat(
      names.flatMap((name, s) =>
        ["t", "b"].map((side) => ({
          id: `${side}${s}`,
          name,
          type: "line",
          silent: true,
          showSymbol: false,
          symbol: "none",
          smooth,
          color: colors[s],
          z: 4,
          lineStyle: overlayStyle(s),
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
  const sIdx = (p) => Number(p.seriesId.slice(1));
  const bands = (params) => params.filter((p) => p.seriesId[0] === "s");
  // An artist's parts in the readout, under its row: every one drawn now that's at least PART_TIP_MIN of the
  // listening at that date (as the bands are scaled, in either mode). valueOf(j, ofArtist) gives the number
  // shown; ofArtist is true while the artist is pinned or hovered. Each comes with its size (its share of all the
  // listening there), by which fitTip drops the smallest when the readout outgrows the window
  const PART_TIP_MIN = 0.01;
  const partTips = (k, i, valueOf, fmt, extra) => {
    if (!parts || k === otherIdx) return [];
    const ofArtist = isLitLook(look(k, focused));
    return partRows(k)
      .map((_, j) => j)
      .filter((j) => partShown(k, j) && parts.share[k][j][i] * scale[i] >= PART_TIP_MIN)
      // In the order they're drawn: share mode stacks them up from the band's floor, so the top one comes first;
      // in hours mode the highest line does
      .sort((a, b) => (share ? b - a : valueOf(b) - valueOf(a)))
      .map((j) => ({
        j,
        size: parts.share[k][j][i] * scale[i],
        value: valueOf(j, ofArtist),
        html: subRow(partShade(k, j, t.shade.pin), fmt(valueOf(j, ofArtist)), parts.names[k][j] + extra(j), isHot(k, j)),
      }));
  };
  // The row counting an artist's parts left out of a crowded readout: their total, and how many
  const partNoun = { album: "albums", track: "songs", artist: "artists" };
  const moreParts = (fmt, extra) => (g, gone) =>
    [fmt(gone.reduce((s, p) => s + p.value, 0)), `${gone.length} more ${partNoun[parts.kind] ?? "parts"}${extra(g, gone)}`];
  const shareTooltip = (params) => {
    params = bands(params);
    if (!params.length || !Number.isFinite(params[0].value[1])) return "";
    const i = params[0].dataIndex;
    const pct = (v) => (v * 100).toFixed(0) + "%";
    const groups = params
      .filter((p) => visible(sIdx(p)))
      .map((p) => ({ p, share: data.share[sIdx(p)][i] * scale[i], hours: data.hours[sIdx(p)][i] }))
      // Drop anyone who would read as 0%
      .filter((r) => r.share >= 0.005)
      // Top band first, so the rows read in the same order as the bands under the pointer
      .sort((a, b) => sIdx(b.p) - sIdx(a.p))
      .map((r) => ({
        k: sIdx(r.p),
        head: row(r.p.color, pct(r.share), `${shownName(r.p.seriesName)} · ${fmtHoursRound(r.hours)}`, sIdx(r.p) === focused || base.has(sIdx(r.p))),
        // A part's percent is of everyone's listening, or of its artist's while the artist is pinned or hovered
        parts: partTips(sIdx(r.p), i, (j, ofArtist) => parts.share[sIdx(r.p)][j][i] * (ofArtist ? 1 / data.share[sIdx(r.p)][i] : scale[i]),
          pct,
          (j) => ` · ${fmtHoursRound(parts.hours[sIdx(r.p)][j][i])}`),
      }));
    const rows = fitTip(groups, moreParts(pct, (g, gone) => ` · ${fmtHoursRound(gone.reduce((s, p) => s + parts.hours[g.k][p.j][i], 0))}`));
    return `<div style="color:${t.muted};margin-bottom:4px">${window} days around ${fmtDate(params[0].value[0])}</div>${rows.join("")}`;
  };
  const hoursTooltip = (params) => {
    params = bands(params);
    if (!params.length) return "";
    const i = params[0].dataIndex;
    const h = (v) => `${v.toFixed(1)} h`;
    // (its hours, not its height: a ridge stands on its baseline)
    const groups = params
      .map((p) => ({ p, v: hoursAt(sIdx(p), i) }))
      .filter(({ p, v }) => sIdx(p) !== otherIdx && v >= 0.05)
      .sort((a, b) => b.v - a.v)
      .map(({ p, v }) => ({
        head: row(p.color, h(v), p.seriesName, sIdx(p) === focused || base.has(sIdx(p))),
        parts: partTips(sIdx(p), i, (j) => perWeek(parts.hours[sIdx(p)][j][i]), h, () => ""),
      }));
    const rows = fitTip(groups, moreParts(h, () => ""));
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
      const band = shapes.get(`s${k}:area`);
      if (!band) continue;
      const floorBand = below == null ? null : shapes.get(`s${below}:area`) ?? null;
      below = k;
      for (const side of ["t", "b"]) {
        const line = shapes.get(`${side}${k}:line`);
        if (!line || (line.__clipOf?.[0] === band && line.__clipOf[1] === floorBand)) continue;
        const clip = new band.constructor({});
        const roof = () => band.shape.points;
        const floor = () => (floorBand ? floorBand.shape.points : band.shape.stackedOnPoints);
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
  // A redraw lands any morph still in flight first: zrender would carry its tween onto the redrawn shapes and
  // paint its old target over them (a leaver's line sinking to 0 onto the artist who takes its series next)
  if (!ms && prev?.tweens) for (const e of drawnShapes(c).values()) e.stopAnimation("update", true);
  st.tweens = !liveFrom && ms > 0;
  st.still = !st.tweens; // (see stillChart)
  if (isStrip) {
    sizeStrip(el, c, STRIP_TOP + plotH + STRIP_BOTTOM, dur(ms));
    // Each name sits level with where its line starts at the plot's left edge, nudged apart where those meet
    const px = (s) => {
      let i = data.dates.findIndex((d, j) => d >= range[0] && hoursAt(s, j) != null);
      if (i < 0) i = 0;
      return Math.max(0, Math.min(plotH, ridge ? lineY(s, i) : (lineY(s, i) * plotH) / stripMax));
    };
    const want = nameRows.map((n) => STRIP_TOP + plotH - px(names.indexOf(n)));
    const put = nudge(want, NAME_H + 1, STRIP_TOP + NAME_H / 2, STRIP_TOP + plotH);
    const at = nameRows.map((n, r) => [n, put[r]]);
    paintRidgeNames(el, at, dur(ms), new Set([...base].map((k) => names[k])), new Map(names.map((n, k) => [n, colors[k]])), {
      hover: (n) => rollingState.get(el)?.focusArtist?.(n),
      // (kept lit through the re-render, as a click on the plot is, see zrClick)
      toggle: (n) => {
        if (!pins?.toggle) return;
        const was = rollingState.get(el);
        was.keepFocus = n;
        pins.toggle(n);
        was.keepFocus = null;
        const now = rollingState.get(el);
        if (now) now.keepFocus = null;
      },
    });
  }

  // An open tooltip still points at the series it was drawn from, and throws once one of them is removed (by a
  // morph, or by the part slots trimmed after one)
  {
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
      // The strip's plot is placed from the top, so its canvas can grow or shrink under it (sizeStrip)
      grid: isStrip
        // (the same left and right as lines or ridges: the names stay at the left, the hours axis at the right)
        ? { left: RIDGE_LEFT, right: 48, top: STRIP_TOP, height: plotH, bottom: null }
        : { left: 48, right: 16, top: 12, bottom: 28 },
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
        max: share ? () => 1 : ridge ? () => plotH : stripMax != null ? () => stripMax : artistCtx?.yMax != null ? () => artistCtx.yMax : unfiltered ? () => hoursTop(data, names, window, hasOther, st.selected, zoom) : (v) => niceTop(v.max),
        // null (not undefined) so a merge clears share mode's fixed 25% step
        interval: share ? 0.25 : null,
        splitNumber: isStrip ? 2 : 4,
        ...baseAxis(t),
        position: isStrip ? "right" : "left",
        axisLine: { show: false },
        // Ridges have no hours axis: the readout gives each one's hours
        axisLabel: { show: !ridge, color: t.muted, formatter: share ? (v) => `${Math.round(v * 100)}%` : (v) => `${v} h` },
        splitLine: { ...baseAxis(t).splitLine, show: !ridge },
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
        series: [...base].map((k) => ({ id: `s${k}`, areaStyle: { opacity: hoursArea(k, focused) } })),
      }, undefined, dur(FADE_MS));
    }, ms);
  }

  // Share mode: shade the band under the pointer (t.shade.hover, or pinHover over a pinned one) and dim the
  // others a little (dimHover; more, dim, while one is pinned). Its outline stays: only a pin outlines.
  const focusBand = (sIndex) => {
    if (sIndex === focused) return;
    focused = sIndex;
    tellFocus(focused == null ? null : names[focused]);
    setOptionFaded(c, {
      animationDurationUpdate: 0,
      series: names.map((_, k) => ({ id: `s${k}`, areaStyle: { color: bandFill(k, focused) } })).concat(partStyles(focused)),
    }, undefined, FADE_MS);
    clipEdges();
  };
  // Hours mode: shade one line (its faint fill) and fade the rest, by restyling directly (ECharts' own blur state is
  // cleared on every pointer move over empty plot space, which is all of it once lines are silent).
  // Only a lit line gets a faint fill (hoursArea); nothing is filled at rest.
  const focusLine = (k) => {
    if (k === focused) return;
    focused = k;
    tellFocus(focused == null ? null : names[focused]);
    setOptionFaded(c, {
      animationDurationUpdate: 0,
      series: names.map((_, j) => ({
        id: `s${j}`,
        lineStyle: lineLook(j, focused),
        areaStyle: ridge ? { color: bandFill(j, focused) } : { opacity: hoursArea(j, focused) },
      })).concat(partStyles(focused)),
    }, undefined, FADE_MS);
    if (isStrip) litRidgeName(el, focused == null ? null : names[focused]);
  };

  // Only the parts change (the pointer moved between parts of one band)
  const restyleParts = () => setOptionFaded(c, { animationDurationUpdate: 0, series: partStyles(focused) }, undefined, FADE_MS);

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
    if (ridge) {
      // The ridge whose fill is under the pointer (the lowest, painted last, where they overlap); over none, the one
      // whose baseline is nearest below
      let under = null;
      names.forEach((_, k) => {
        if (k === otherIdx || !visible(k) || fading(k) || ridgeBase[k] > y) return;
        if (y <= lineY(k, i) && (best == null || ridgeBase[k] < ridgeBase[best])) best = k;
        if (under == null || ridgeBase[k] > ridgeBase[under]) under = k;
      });
      best ??= under;
      return best == null ? null : { k: best, j: null };
    }
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
  // (mid artist change, re-stacks the artists it's going to, rather than keeping the leavers for good). The page
  // can redraw instead (pins.restack, returning true), when the artists now shown call for other data: its albums
  // or songs are picked beside the artists shown, so it reads the new selection from hiddenIn
  const restack = () => {
    const [d, n, w, , m, o, p, sl, sm] = st.args;
    const hidden = hiddenNames.get(el) ?? new Set();
    for (const name of n) st.selected[name] === false ? hidden.add(name) : hidden.delete(name);
    hiddenNames.set(el, hidden);
    if (!mainOf.has(el) && p?.restack?.()) return; // (the strip only ever follows the main chart)
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

  if (redrawing) return;
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
    // without the albums or songs: in thin lines they'd only tangle
    renderRolling(strip, { ...(sourceOf.get(sa.data) ?? sa.data), parts: undefined }, sa.names, window, zoom, "hours", hasOther, morph, pins, sa.slots, smooth);
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

// Every play and Every day: two graphs drawn on their own canvas rather than by ECharts. Every play has a mark per
// play (a hundred thousand over all time), and ECharts can neither fade that many marks on a hover nor draw them
// fast, so each artist's marks are one Path2D, built once per layout, and a frame is a dozen fills. Both follow the
// rolling chart's artists, colors, pins and hover (litLook, eased per artist), slide with a pan or a dragged period
// window (panRaster, panCalendar, dragCalendar), and show their own hover card.

import * as agg from "./aggregate.js";
import { FADE_MS, CHASE_MS, ENTER_MS, MORPH_MS, EASE_IN_OUT, EASE_OUT, dur, litLook, isPinLook } from "./motion.js";
import { shownName, OTHER } from "./state.js";
import { tune } from "./tune.js";
import { tokens, mix } from "./colors.js";
import { esc, fmtH, MON } from "./format.js";
import { HOUR } from "./aggregate.js";

const weekday = (k) => (k + 3) % 7; // a day index's weekday, Monday 0
// The same plays come as a new array from each paint, so they're compared by what they hold
const playsKey = (plays) => `${plays.length}:${plays[0]?.t}:${plays.at(-1)?.t}`;

// ---------- Shared: canvas, looks, hover card, fades ----------

const views = new WeakMap(); // el -> the graph's state

// The share of an artist's color in a mark, or the factor on a day's tint, in each look of the hover/pin rule. A
// mark is small, so it starts deep and lighting it has little room: the others dimming does most of the work.
const MARK_SHADE = { rest: 0.72, hover: 0.86, pin: 0.94, pinHover: 1, dim: 0.2, dimHover: 0.42 };
const OTHER_SHADE = { rest: 0.42, hover: 0.42, pin: 0.42, pinHover: 0.42, dim: 0.16, dimHover: 0.28 };
const DAY_FACTOR = { rest: 1, hover: 1.12, pin: 1.2, pinHover: 1.28, dim: 0.5, dimHover: 0.7 };

function setup(el, draw, pick) {
  let v = views.get(el);
  if (v) return v;
  const canvas = document.createElement("canvas");
  Object.assign(canvas.style, { position: "absolute", left: 0, top: 0 });
  el.style.position = "relative";
  el.append(canvas);
  v = { el, canvas, ctx: canvas.getContext("2d"), draw, pick, looks: new Map(), raf: 0, hovered: null, width: 0 };
  views.set(el, v);
  new ResizeObserver(() => {
    if (el.clientWidth !== v.width && v.relayout) v.relayout();
  }).observe(el);
  pointer(v);
  return v;
}

// Size the canvas for a layout of height h (the box glides to it, the canvas is already there)
function size(v, h) {
  const dpr = devicePixelRatio || 1, w = v.el.clientWidth;
  v.width = w;
  v.cssH = h;
  v.canvas.width = Math.round(w * dpr);
  v.canvas.height = Math.round(h * dpr);
  v.canvas.style.width = w + "px";
  v.canvas.style.height = h + "px";
  v.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  v.el.style.height = h + "px";
}

// Fades the canvas to an opacity from wherever it is
function fadeCanvas(v, to, ms, easing) {
  const from = +getComputedStyle(v.canvas).opacity;
  v.canvas.getAnimations().forEach((a) => a.cancel());
  v.canvas.style.opacity = to;
  if (ms) v.canvas.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing });
}

// Lay a copy of the frame on screen over the canvas and fade it out, so what's drawn next crossfades in. Only for
// a frame laid out the same (artists selected or deselected): every box and mark stays put, so only colors blend.
// A copy still fading is folded into the new one at the opacity it has reached.
function crossfade(v, ms) {
  if (!ms || !v.canvas.width) return;
  const copy = document.createElement("canvas");
  copy.width = v.canvas.width;
  copy.height = v.canvas.height;
  const ctx = copy.getContext("2d");
  ctx.drawImage(v.canvas, 0, 0);
  for (const old of v.el.querySelectorAll(".chart-fade")) {
    ctx.globalAlpha = +getComputedStyle(old).opacity;
    ctx.drawImage(old, 0, 0);
    old.remove();
  }
  copy.className = "chart-fade";
  Object.assign(copy.style, { position: "absolute", left: 0, top: 0, width: v.canvas.style.width, height: v.canvas.style.height, pointerEvents: "none" });
  v.el.append(copy);
  copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: EASE_IN_OUT.css, fill: "forwards" }).finished.then(
    () => copy.remove(),
    () => {}
  );
}

// Each artist's look eases from what's on screen to its target: { from, to, at, ms } per name, numbers in [0, 1]
// for the shade (s) and the pin's outline (o). A quick change never cuts short a slower one in flight.
function lookOf(v, name) {
  const e = v.looks.get(name);
  if (!e) return null;
  const t = e.ms ? Math.min(1, (performance.now() - e.at) / e.ms) : 1;
  const k = e.ease(t);
  return { s: e.from.s + (e.to.s - e.from.s) * k, o: e.from.o + (e.to.o - e.from.o) * k, done: t >= 1 };
}
function retarget(v, targets, ms, ease) {
  const now = performance.now();
  for (const [name, to] of targets) {
    const e = v.looks.get(name), cur = lookOf(v, name);
    if (!cur) {
      v.looks.set(name, { from: to, to, at: now, ms: 0, ease });
      continue;
    }
    if (e.to.s === to.s && e.to.o === to.o) continue;
    const left = e.ms ? e.at + e.ms - now : 0;
    const len = Math.max(ms, left);
    v.looks.set(name, { from: { s: cur.s, o: cur.o }, to, at: now, ms: len, ease: len > ms ? e.ease : ease });
  }
  animate(v);
}
// Every play's layers' opacities as they fade (v.fades: name -> { from, to, at, ms }): the gray one with the
// Everyone else toggle, an artist's as it joins while the gray is out
function alphaOf(v, name) {
  const f = v.fades?.get(name);
  if (!f) return { a: 1, done: true };
  const t = f.ms ? Math.min(1, (performance.now() - f.at) / f.ms) : 1;
  return { a: f.from + (f.to - f.from) * EASE_IN_OUT.js(t), done: t >= 1 };
}
function animate(v) {
  cancelAnimationFrame(v.raf);
  const frame = () => {
    v.draw(v);
    if ([...v.looks.keys()].some((n) => !lookOf(v, n).done) || [...(v.fades?.keys() ?? [])].some((n) => !alphaOf(v, n).done)) v.raf = requestAnimationFrame(frame);
  };
  frame();
}
// The targets for every name the graph colors, from litLook (pin outlines only for the chart's artists)
function targetsOf(v, table) {
  const out = new Map();
  for (const n of v.names) {
    const look = litLook(v.pinned, v.hovered, n);
    out.set(n, { s: table[look], o: isPinLook(look) ? 1 : 0 });
  }
  const look = litLook(v.pinned, v.hovered, OTHER);
  out.set(OTHER, { s: v.otherTable[look], o: 0 });
  return out;
}

// The hover card, one for the page, beside the pointer and under the sticky bar
let tipEl = null;
function showTip(html, x, y) {
  if (!tipEl) {
    tipEl = Object.assign(document.createElement("div"), { className: "canvas-tip" });
    document.body.append(tipEl);
  }
  tipEl.innerHTML = html;
  tipEl.classList.add("on");
  const GAP = 16, EDGE = 8;
  const { width: w, height: h } = tipEl.getBoundingClientRect();
  const bar = document.querySelector(".filters.sticky")?.getBoundingClientRect().bottom ?? 0;
  let left = x + GAP;
  if (left + w > innerWidth - EDGE) left = x - GAP - w;
  let top = y + GAP;
  if (top + h > innerHeight - EDGE) top = y - GAP - h;
  top = Math.max(Math.max(0, bar) + EDGE, top);
  tipEl.style.transform = `translate(${Math.max(EDGE, left)}px, ${top}px)`;
}
const hideTip = () => tipEl?.classList.remove("on");

const tipTitle = (color, name) =>
  `<div style="display:flex;align-items:center;gap:8px"><span style="width:12px;height:4px;background:${color};border-radius:1px"></span><b>${esc(shownName(name))}</b></div>`;
const tipMuted = (s) => `<div class="muted">${s}</div>`;

// The pointer: what's under it (pick returns { name, html } or null) lights its artist across the page and shows
// the card; a click pins
function pointer(v) {
  const c = v.canvas;
  let from = false;
  c.addEventListener("mousemove", (e) => {
    const r = c.getBoundingClientRect();
    const hit = v.pick(v, e.clientX - r.left, e.clientY - r.top);
    if (!hit) {
      hideTip();
      c.style.cursor = "default";
      if (from) v.hover?.(null);
      from = false;
      return;
    }
    from = true;
    const artist = v.names.includes(hit.name) ? hit.name : null; // "Everyone else" isn't an artist to light or pin
    c.style.cursor = artist && v.pins ? "pointer" : "default";
    if (artist !== v.hovered) v.hover?.(artist);
    showTip(hit.html, e.clientX, e.clientY);
  });
  c.addEventListener("mouseleave", () => {
    hideTip();
    if (from) v.hover?.(null);
    from = false;
  });
  c.addEventListener("click", (e) => {
    const r = c.getBoundingClientRect();
    const hit = v.pick(v, e.clientX - r.left, e.clientY - r.top);
    if (hit && v.names.includes(hit.name)) v.pins?.toggle(hit.name);
  });
}

// Shared by both graphs' renders: the artists, their colors, pins and hover. Returns the ms for the looks: a
// fade for a restyle, the morph's for a change that comes with one
function adopt(v, names, slots, pins, hover, otherTable) {
  v.t = tokens();
  v.names = names;
  v.colorOf = new Map(names.map((n, k) => [n, v.t.series[slots[k]]]));
  v.colorOf.set(OTHER, v.t.other);
  v.pins = pins;
  v.hover = hover;
  v.pinned = new Set(names.filter((n) => pins?.has(n)));
  v.otherTable = otherTable;
}

// Light one artist from a hover elsewhere on the page; null clears
export function focusEvery(el, name) {
  const v = views.get(el);
  if (!v?.names) return;
  const next = name != null && v.names.includes(name) ? name : null;
  if (next === v.hovered) return;
  v.hovered = next;
  retarget(v, targetsOf(v, v.table), dur(FADE_MS), EASE_OUT.js);
}

// The look's targets after a render: a new frame starts in them, a restyle eases to them with the data's morph
function settle(v, changed) {
  const targets = targetsOf(v, v.table);
  if (changed) {
    v.looks = new Map([...targets].map(([n, to]) => [n, { from: to, to, at: 0, ms: 0, ease: EASE_IN_OUT.js }]));
    animate(v);
  } else retarget(v, targets, dur(MORPH_MS), EASE_IN_OUT.js);
}

// ---------- Every play ----------

// Every play as a mark at its day (across) and time of day (down, midnight at the top), as tall as it lasted, in
// its artist's color (the rest gray). A play running past midnight carries on at the top of the next day. Plays
// under 10 s are left out. Plays of the same item (the view's: artist, track, album or genre) one after another are
// one mark, a run, so a long stretch of one artist reads as one bar. The marks are merged per pixel column where
// they overlap, so all time draws fast.
const GRID = { top: 10, bottom: 30, left: 52, right: 12 };
const RUN_GAP = 2 * 60000; // the longest pause a run carries on through

// The plays as runs { item, start, end, plays }: each play joins its item's run if that item's last play ended at
// most RUN_GAP before it started and nothing else played in between. In the genres view a play is one entry per
// genre (sharing its end time t), so it carries on each of its genres' runs and ends the others.
function playRuns(plays) {
  const runs = [], open = new Map(); // item -> its run still going
  let i = 0;
  while (i < plays.length) {
    const t = plays[i].t, items = new Map();
    for (; i < plays.length && plays[i].t === t; i++) {
      const p = plays[i];
      if (p.ms / (p.w ?? 1) >= 10000) items.set(p.artist, p); // (the genres view shares a play's time out between its genres)
    }
    if (!items.size) continue;
    for (const item of open.keys()) if (!items.has(item)) open.delete(item);
    for (const [item, p] of items) {
      const start = t - p.ms / (p.w ?? 1);
      let run = open.get(item);
      if (run && start - run.end <= RUN_GAP) run.end = Math.max(run.end, t), run.plays.push(p);
      else {
        run = { item, start, end: t, plays: [p] };
        runs.push(run);
        open.set(item, run);
      }
    }
  }
  return runs;
}

// With `other` off, only the named artists' plays are drawn: the gray layer is always laid out, and fades out or in
// (v.fades) where it is
export function renderRaster(el, plays, lo, hi, names = [], slots = [], pins = null, hover = () => {}, { other = true } = {}) {
  const v = setup(el, drawRaster, pickRaster);
  const data = [playsKey(plays), lo, hi, names.join("\u0000"), slots.join(), tokens().surface];
  const key = [...data, tune.rasterHeight];
  const relaid = v.key?.some((x, i) => x !== key[i]) ?? true;
  adopt(v, names, slots, pins, hover, OTHER_SHADE);
  v.table = MARK_SHADE;
  v.fades ??= new Map();
  if (v.other !== other) v.fades.set(OTHER, { from: v.key ? alphaOf(v, OTHER).a : +other, to: +other, at: performance.now(), ms: v.key ? dur(MORPH_MS) : 0 });
  refresh(v, data, key, { plays, lo, hi, other }, () => layoutRaster(v), relaid);
}

// After a render's artists are adopted: new data (a period window dragged or travelling) dims the graph a little
// (to tune.waitFade), and it waits there until the changes stop coming, then the new frame takes its place at that
// dimness and brightens, rather than redrawing under the moving window or crossfading (two layouts of boxes
// overlapping). Anything else in the key (a new height) only lays it out again; the first draw fades in.
function refresh(v, data, key, fields, layout, relaid) {
  const first = !v.key, moved = !first && data.some((x, i) => x !== v.key[i]);
  // The same period (artists selected or deselected, a theme): the boxes stay put, so the colors just crossfade
  const still = moved && !v.waiting && v.lo === fields.lo && v.hi === fields.hi && v.key.every((x, i) => i < data.length || x === key[i]);
  Object.assign(v, { key, ...fields });
  v.relayout = layout;
  if (still) {
    crossfade(v, dur(MORPH_MS));
    layout();
    settle(v, true);
    return;
  }
  if (moved) {
    if (!v.waiting) fadeCanvas(v, tune.waitFade, dur(FADE_MS), EASE_OUT.css);
    v.waiting = true;
    hideTip();
    clearTimeout(v.waitTimer);
    v.waitTimer = setTimeout(() => {
      v.waiting = false;
      layout();
      settle(v, true);
      fadeCanvas(v, 1, dur(MORPH_MS), EASE_IN_OUT.css);
    }, dur(CHASE_MS));
    return;
  }
  if (v.waiting) return; // (the wait's end draws with what's current)
  if (relaid) {
    if (first) fadeCanvas(v, 1, dur(ENTER_MS), EASE_OUT.css);
    layout();
  }
  settle(v, relaid);
}

function layoutRaster(v) {
  const { plays, lo, hi, names } = v;
  size(v, tune.rasterHeight);
  const w = v.width, h = v.cssH;
  // (sliding, it's laid out at the width a day had before, over both periods: see panRaster)
  const days = hi - lo + 1, plotH = h - GRID.top - GRID.bottom;
  const plotW = v.panning ? v.panning.dw * days : Math.max(1, w - GRID.left - GRID.right);
  const dw = plotW / days, pph = plotH / 24;
  const dpr = devicePixelRatio || 1;
  const known = new Set(names);
  // An artist new to the frame was in the gray, so it fades in from as much of the gray as showed
  const gray = alphaOf(v, OTHER).a;
  if (v.drawn && gray < 1)
    for (const n of names) if (!v.drawn.has(n)) v.fades.set(n, { from: gray, to: 1, at: performance.now(), ms: dur(MORPH_MS) });
  v.drawn = known;
  // Per layer, per device-pixel column, the marks' [y0, y1] runs; and per day, the plays for the pointer
  const cols = new Map([[OTHER, new Map()], ...names.map((n) => [n, new Map()])]);
  v.byDay = Array.from({ length: days }, () => []);
  const put = (layer, day, y0, y1, run) => {
    const x0 = GRID.left + day * dw;
    const col = Math.floor(x0 * dpr);
    const m = cols.get(layer);
    let runs = m.get(col);
    if (!runs) m.set(col, (runs = []));
    runs.push([y0, y1, x0]);
    v.byDay[day].push({ y0, y1, run, day, layer });
  };
  // A run is one mark, carried on at the top of each next day it reaches
  for (const run of playRuns(plays)) {
    const s = new Date(run.start), hour = s.getHours() + s.getMinutes() / 60 + s.getSeconds() / 3600;
    const layer = known.has(run.item) ? run.item : OTHER;
    let day = agg.dayIndex(run.start) - lo, from = hour, left = (run.end - run.start) / HOUR;
    for (; left > 0 && day < days; day++, from = 0) {
      const y0 = GRID.top + from * pph, y1 = GRID.top + Math.min(24, from + left) * pph;
      if (day >= 0) put(layer, day, y0, Math.max(y1, y0 + 1.5), run);
      left -= 24 - from;
    }
  }
  // Merge each column's runs that touch, then one rect each
  const mw = Math.max(1, dw);
  v.paths = new Map();
  for (const [layer, m] of cols) {
    const path = new Path2D();
    for (const runs of m.values()) {
      runs.sort((a, b) => a[0] - b[0]);
      let [a, b, x] = runs[0];
      for (let i = 1; i <= runs.length; i++) {
        const r = runs[i];
        if (r && r[0] <= b + 0.5 && Math.abs(r[2] - x) < 0.5) b = Math.max(b, r[1]);
        else {
          path.rect(x, a, mw, b - a);
          if (r) [a, b, x] = r;
        }
      }
    }
    v.paths.set(layer, path);
  }
  v.dw = dw;
  v.pph = pph;
  v.xTicks = timeTicks(lo, hi, plotW);
  if (v.looks.size) v.draw(v);
}

// A pan (state.js) sliding Every play to another period: it's laid out once over `lo`…`hi` (both periods), still
// with the artists it has and each day as wide as it was, and each frame (panRasterTo) shows the days `at` covers by
// moving and stretching that picture, so a step of the same length is a pure scroll. endPanRaster hands back to the
// usual render, which lands on what's already on screen.
export function panRaster(el, plays, lo, hi) {
  const v = views.get(el);
  if (!v?.paths) return false;
  if (v.waiting) {
    clearTimeout(v.waitTimer);
    v.waiting = false;
    fadeCanvas(v, 1, dur(FADE_MS), EASE_OUT.css);
  }
  hideTip();
  v.panning = { dw: v.panning?.dw ?? v.dw };
  Object.assign(v, { plays, lo, hi });
  layoutRaster(v);
  return true;
}
export function panRasterTo(el, at) {
  const v = views.get(el);
  if (!v?.panning) return;
  v.panning.at = at;
  drawRaster(v);
}
export function endPanRaster(el, { lo, hi }) {
  const v = views.get(el);
  if (!v?.panning) return;
  v.panning = null;
  Object.assign(v, { lo, hi });
}

// Labels along the bottom: years, quarters, months or weeks, whichever leaves them room
function timeTicks(lo, hi, plotW) {
  const days = hi - lo + 1, px = plotW / days;
  const out = [];
  const first = agg.dayToDate(lo);
  const room = 64;
  if (px * 7 >= room) {
    for (let k = lo + ((7 - weekday(lo)) % 7); k <= hi; k += 7) {
      const d = agg.dayToDate(k);
      out.push([k - lo, `${MON[d.getMonth()]} ${d.getDate()}`]);
    }
    return out;
  }
  const step = [1, 3, 6, 12, 24, 48].find((m) => px * 30.4 * m >= room) ?? 96;
  let y = first.getFullYear(), m = first.getMonth();
  for (;;) {
    const k = agg.dayIndex(new Date(y, m, 1).getTime());
    if (k > hi) break;
    if (k >= lo && m % Math.min(step, 12) === 0 && (step <= 12 || y % (step / 12) === 0)) out.push([k - lo, m === 0 ? String(y) : MON[m]]);
    m++;
    if (m === 12) (m = 0), y++;
  }
  return out;
}

function drawRaster(v) {
  const { ctx, t, width: w, cssH: h } = v;
  if (!v.paths || v.waiting) return;
  ctx.clearRect(0, 0, w, h);
  ctx.font = `12px ${t.font}`;
  ctx.fillStyle = t.muted;
  // Hours down the left, with faint lines across
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ["12am", "6am", "noon", "6pm", "12am"].forEach((label, i) => {
    const y = GRID.top + i * 6 * v.pph;
    if (i > 0 && i < 4) {
      ctx.fillStyle = t.grid;
      ctx.fillRect(GRID.left, Math.round(y) - 0.5, w - GRID.left - GRID.right, 1);
      ctx.fillStyle = t.muted;
    }
    if (v.cssH > 300 || i % 2 === 0) ctx.fillText(label, GRID.left - 10, y);
  });
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // Sliding: day k of the layout is at x(k), the marks are moved and stretched there, inside the plot
  const at = v.panning?.at, plotW = w - GRID.left - GRID.right;
  const dwAt = at ? plotW / (at.hi + 1 - at.lo) : v.dw;
  const x = (k) => GRID.left + (k + (at ? v.lo - at.lo : 0)) * dwAt;
  ctx.save();
  ctx.beginPath();
  ctx.rect(GRID.left - 32, 0, plotW + 32 + GRID.right, h); // (room for the end labels' halves)
  ctx.clip();
  for (const [k, label] of v.xTicks) ctx.fillText(label, x(k), h - GRID.bottom + 10);
  ctx.restore();
  ctx.save();
  if (at) {
    ctx.beginPath();
    ctx.rect(GRID.left, 0, plotW, h);
    ctx.clip();
    const s = dwAt / v.dw;
    ctx.transform(s, 0, 0, 1, x(0) - GRID.left * s, 0);
  }
  // The gray first, then the artists from the last in rank up, the pinned on top
  const order = [OTHER, ...[...v.names].reverse().filter((n) => !v.pinned.has(n)), ...v.names.filter((n) => v.pinned.has(n))];
  for (const n of order) {
    const look = lookOf(v, n);
    const path = v.paths.get(n);
    if (!look || !path) continue;
    ctx.globalAlpha = alphaOf(v, n).a;
    if (!ctx.globalAlpha) continue;
    ctx.fillStyle = mix(t.surface, v.colorOf.get(n), look.s);
    ctx.fill(path);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function pickRaster(v, x, y) {
  if (!v.byDay || v.waiting || v.panning || x < GRID.left || x > v.width - GRID.right || y < GRID.top || y > v.cssH - GRID.bottom) return null;
  const day = Math.floor((x - GRID.left) / v.dw);
  // Under a pixel wide, a day's marks share their column with their neighbours': look a pixel or two either way
  const reach = Math.ceil(2 / v.dw);
  let best = null, bestD = Infinity;
  for (let d = Math.max(0, day - (v.dw < 1 ? reach : 0)); d <= Math.min(v.byDay.length - 1, day + (v.dw < 1 ? reach : 0)); d++) {
    for (const m of v.byDay[d]) {
      if (m.layer === OTHER && !v.other) continue; // (faded out: nothing to hover)
      const dy = y < m.y0 ? m.y0 - y : y > m.y1 ? y - m.y1 : 0;
      const dd = dy + Math.abs(d - day) * v.dw;
      if (dy <= 2 && dd < bestD) (best = m), (bestD = dd);
    }
  }
  if (!best) return null;
  const { run, layer } = best;
  // The play under the pointer: the first of the run still playing at that time of day
  const at = agg.dayToDate(v.lo + best.day).getTime() + ((y - GRID.top) / v.pph) * HOUR;
  const p = run.plays.find((p) => at <= p.t) ?? run.plays.at(-1);
  const col = mix(v.t.surface, v.colorOf.get(layer), 0.9);
  const sub = p.track && p.track !== shownName(p.artist) ? `<div>${esc(p.track)}${p.by && p.by !== p.artist ? ` · ${esc(p.by)}` : ""}</div>` : "";
  const date = (t) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const head = tipTitle(col, layer === OTHER ? run.item : layer), name = layer === OTHER ? OTHER : run.item;
  const long = fmtH((run.end - run.start) / HOUR);
  if (run.plays.length === 1) return { name, html: head + sub + tipMuted(`${esc(date(run.start))} · ${long}`) };
  // A run: when it went on, how long and how many plays, then the one under the pointer
  const end = agg.dayIndex(run.end) === agg.dayIndex(run.start) ? new Date(run.end).toLocaleTimeString([], { timeStyle: "short" }) : date(run.end);
  const span = tipMuted(`${esc(date(run.start))} – ${esc(end)}<br>${long} in a row · ${run.plays.length} plays`);
  return { name, html: head + span + sub };
}

// ---------- Every day ----------

// A calendar of the period, each box tinted by its top artist and darker the more you listened (up to the period's
// 95th percentile). Up to two years it has a box per day (a rolling year in one strip, longer in a strip per
// calendar year); beyond, a square box per week, a row per year. Days whose top isn't one of the chart's artists
// are gray.
const DAY_MODE_MAX = 731;

// onUnit("day" | "week") is told which it draws, as it draws it (for the card's title and note). With `other` off,
// a day is tinted by its top of the named artists (and as dark as their hours), gray if it had none of them.
export function renderCalendar(el, plays, lo, hi, names = [], slots = [], pins = null, hover = () => {}, { other = true, onUnit = null } = {}) {
  const v = setup(el, drawCalendar, pickCalendar);
  const key = [playsKey(plays), lo, hi, names.join("\u0000"), slots.join(), tokens().surface, other, tune.calendarHeight];
  const relaid = v.key?.some((x, i) => x !== key[i]) ?? true;
  adopt(v, names, slots, pins, hover, DAY_FACTOR);
  v.table = DAY_FACTOR;
  v.onUnit = onUnit;
  const keep = other ? null : names.join("\u0000");
  refresh(v, key, key, { plays, lo, hi, keep }, () => {
    if (v.cells?.plays !== v.plays || v.cells.lo !== v.lo || v.cells.hi !== v.hi || v.cells.keep !== v.keep) v.cells = calendarCells(v.plays, v.lo, v.hi, v.keep);
    v.onUnit?.(v.cells.weeks ? "week" : "day");
    layoutCalendar(v);
  }, relaid);
}

// Each day's (or week's) hours and top artist, and the scale for the tint. `keep` (the names joined by \0, or null
// for everyone) leaves only those artists in the hours and the pick; a day that played none of them has best null.
function calendarCells(plays, lo, hi, keep = null, weeks = hi - lo + 1 > DAY_MODE_MAX) {
  const kept = keep == null ? null : new Set(keep ? keep.split("\u0000") : []);
  const by = new Map();
  let next = -Infinity, m = null; // (the plays come in time order: a day's are looked up once, at its first)
  for (const p of plays) {
    if (p.t >= next) {
      const k = agg.dayIndex(p.t), key = weeks ? weekKey(k) : k;
      next = agg.dayToDate(k + 1).getTime();
      m = by.get(key);
      if (!m) by.set(key, (m = new Map()));
    }
    if (!kept || kept.has(p.artist)) m.set(p.artist, (m.get(p.artist) ?? 0) + p.ms / HOUR);
  }
  const cells = new Map();
  for (const [key, m] of by) {
    let h = 0, best = null, bh = 0;
    for (const [a, x] of m) {
      h += x;
      if (x > bh) (bh = x), (best = a);
    }
    cells.set(key, { h, best, bh });
  }
  const sorted = [...cells.values()].filter((c) => c.best).map((c) => c.h).sort((a, b) => a - b);
  return { plays, lo, hi, keep, weeks, cells, top: sorted[Math.floor(sorted.length * 0.95)] || 1 };
}

const CAL = { top: 22, bottom: 6, left: 52, right: 8, gap: 2, rowGap: 14 }; // (left: the week rows'; the day strips set their own)
const wkOf = (k) => (k - weekday(k)) / 7; // a day's week column, counted from any Monday
const yearOf = (k) => agg.dayToDate(k).getFullYear();
const jan1 = (y) => agg.dayIndex(new Date(y, 0, 1).getTime());
// The week box a day belongs to: its year's 7-day blocks from Jan 1, the 53rd taking the rest
const weekKey = (k) => {
  const y = yearOf(k);
  return y * 100 + Math.min(52, Math.floor((k - jan1(y)) / 7));
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, f) => a + (b - a) * f;

// How a period is laid out on a width w, always tune.calendarHeight tall: "strip", a box per day in one strip (a
// year or less); "years", a strip of days per calendar year, the years' weeks lined up (up to two years); "weeks", a
// box per week, a row per year. cw: a column's width (from the width); ch: a day's height (a week row's), the rows
// filling the height, so boxes are only square by chance; shift: the first column (strip) or year (the others),
// which a pan slides. A drag holds the kind it started in (`kind`), so a period too long for it squeezes in.
const kindOf = (lo, hi) => (hi - lo + 1 > DAY_MODE_MAX ? "weeks" : hi - lo + 1 <= 371 ? "strip" : "years");
function calMode(lo, hi, w, kind = kindOf(lo, hi)) {
  const room = tune.calendarHeight - CAL.top - CAL.bottom, years = yearOf(hi) - yearOf(lo) + 1;
  const min = kind === kindOf(lo, hi) ? 1 : 0.4; // (the share of a box's smallest size it can squeeze to)
  if (kind === "weeks") return { kind, left: CAL.left, cw: Math.max(5 * min, Math.min(24, Math.floor((w - CAL.left - CAL.right) / 53))), ch: Math.floor(room / years), shift: yearOf(lo) };
  const left = kind === "years" ? 72 : 28, rows = kind === "strip" ? 1 : years;
  const cols = kind === "strip" ? wkOf(hi) - wkOf(lo) + 1 : 54;
  const cw = Math.max(6 * min, Math.min(24, Math.floor((w - left - CAL.right) / cols)));
  return { kind, left, cw, ch: Math.max(2, Math.floor((room - (rows - 1) * CAL.rowGap) / (7 * rows))), shift: kind === "strip" ? wkOf(lo) : yearOf(lo) };
}
const rowH = (m) => (m.kind === "weeks" ? m.ch : m.ch * 7 + CAL.rowGap);

// Day k's box in layout m (in "weeks", its week's box)
function rectOf(m, k) {
  const { cw, ch } = m, w = cw - Math.min(CAL.gap, cw / 3), h = ch - Math.min(CAL.gap, ch / 3); // (a squeezed box keeps some of its size)
  if (m.kind === "strip") return { x: m.left + (wkOf(k) - m.shift) * cw, y: CAL.top + weekday(k) * ch, w, h };
  const y = yearOf(k), top = CAL.top + (y - m.shift) * rowH(m);
  if (m.kind === "weeks") return { x: CAL.left + (weekKey(k) % 100) * cw, y: top, w, h };
  return { x: m.left + (wkOf(k) - wkOf(jan1(y))) * cw, y: top + weekday(k) * ch, w, h };
}

// How grown a box centred on day c is while one edge of the window travels from e0 to e1 (now at e): a box the edge
// uncovers grows from when it passes until the pan ends, one it covers shrinks from the start until it passes, so
// every box is whole at either end and none pops. (The right edge is the left one mirrored: -c against -(hi + 1).)
function edgeGrow(c, e0, e1, e) {
  if (c >= Math.max(e0, e1)) return 1;
  if (c < Math.min(e0, e1)) return 0;
  const u = (c - e0) / (e1 - e0), f = (e - e0) / (e1 - e0); // when the edge passes c, and how far it's come
  return e1 < e0 ? clamp01((f - u) / (1 - u)) : clamp01((u - f) / u);
}
const growAt = (c, { from, to }, at) => Math.min(edgeGrow(c, from.lo, to.lo, at.lo), edgeGrow(-c, -from.hi - 1, -to.hi - 1, -at.hi - 1));

// The boxes and labels for the days `at` shows ({lo, hi}, fractional while a pan slides it), laid out as `m` with the
// columns or rows moved along by m.shift. Each has an opacity a: how much of its first day (a week: of its days) is
// in view, so days fade in and out as the window's edges pass over them. During a resize (grow: the pan's from and
// to ranges) boxes scale instead (g, about their centre) and only the labels fade; grow true (a dragged edge) scales
// each by how much of it is in view.
function calPlace(v, m, at, grow = null) {
  const { cw, ch, left, shift } = m;
  const seen = (a, b) => clamp01(Math.min(b + 1, at.hi + 1) - Math.max(a, at.lo)); // days a…b in view, up to 1
  const shown = (a, b) => (grow === true ? { a: 1, g: seen(a, b) } : grow ? { a: 1, g: growAt((a + b + 1) / 2, grow, at) } : { a: seen(a, b), g: 1 });
  const boxes = []; // { x, y, w, h, key, from, a, g } for each box in view
  const labels = []; // [x, y, text, align, a year?, a]
  const k0 = Math.max(v.lo, Math.floor(at.lo)), k1 = Math.min(v.hi, Math.ceil(at.hi));
  const weekdays = (top, a) => ["M", "", "W", "", "F", "", ""].forEach((d, r) => d && labels.push([left - 8, top + r * ch + ch / 2, d, "right", false, a]));
  // Month labels at the month's first column, or (one in view from partway) at the first column in view
  const months = (y, top, col0) => {
    for (let mo = 0; mo < 12; mo++) {
      const first = agg.dayIndex(new Date(y, mo, 1).getTime()), last = agg.dayIndex(new Date(y, mo + 1, 1).getTime()) - 1;
      if (last < at.lo || first > at.hi + 1) continue;
      const days = Math.min(last + 1, at.hi + 1) - Math.max(first, at.lo);
      const a = Math.max(seen(first, first), clamp01((days - 10) / 4));
      const from = Math.max(first, Math.min(last, Math.ceil(at.lo)));
      if (a > 0) labels.push([left + (wkOf(from) - col0) * cw, top - 8, MON[mo], "left", false, a]);
    }
  };
  const day = (k) => {
    const o = shown(k, k);
    if (o.a * o.g > 0) boxes.push({ ...rectOf(m, k), key: k, from: k, ...o });
  };
  if (m.kind === "strip") {
    weekdays(CAL.top, 1);
    for (let k = k0; k <= k1; k++) day(k);
    for (let y = yearOf(k0); y <= yearOf(k1); y++) months(y, CAL.top, shift);
  } else {
    for (let y = yearOf(k0); y <= yearOf(k1); y++) {
      const top = CAL.top + (y - shift) * rowH(m);
      const ya = clamp01((Math.min(jan1(y + 1), at.hi + 1) - Math.max(jan1(y), at.lo)) / 7);
      if (m.kind === "weeks") {
        labels.push([CAL.left - 10, top + ch / 2, String(y), "right", true, ya]);
        for (let wk = 0; wk < 53; wk++) {
          const from = jan1(y) + 7 * wk, to = wk === 52 ? jan1(y + 1) - 1 : from + 6;
          const o = shown(from, to);
          if (o.a * o.g > 0) boxes.push({ ...rectOf(m, from), key: y * 100 + wk, from, ...o });
        }
        continue;
      }
      labels.push([left - 26, top + (ch * 7) / 2, String(y), "right", true, ya]);
      weekdays(top, ya);
      for (let k = Math.max(k0, jan1(y)); k <= Math.min(k1, jan1(y + 1) - 1); k++) day(k);
      months(y, top, wkOf(jan1(y)));
    }
    if (m.kind === "weeks") {
      const DOY = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]; // each month's first day of the year
      DOY.forEach((d, mo) => labels.push([CAL.left + Math.floor(d / 7) * cw, CAL.top - 8, MON[mo], "left", false, 1]));
    }
  }
  // Month labels that would collide with the one before give way
  let lastX = -Infinity, lastY = null;
  v.labels = labels.filter(([x, y, text, align]) => {
    if (align !== "left") return true;
    if (y === lastY && x - lastX < 28) return false;
    (lastX = x), (lastY = y);
    return !!text;
  });
  v.boxes = boxes;
}

function layoutCalendar(v) {
  calPlace(v, calMode(v.lo, v.hi, v.el.clientWidth || 1000), { lo: v.lo, hi: v.hi });
  size(v, tune.calendarHeight);
  if (v.looks.size) v.draw(v);
}

// A box's fill, from its cell (none: nothing played) at the tint's scale `top`, and the artist a pin rings it for
function tintOf(v, c, top) {
  if (!c?.best) return { fill: mix(v.t.surface, v.t.grid, 0.6), name: null };
  const name = v.colorOf.has(c.best) ? c.best : OTHER;
  const look = lookOf(v, name) ?? { s: 1, o: 0 };
  const share = Math.min(1, (0.15 + 0.6 * Math.min(1, Math.sqrt(c.h / top))) * look.s) * (name === OTHER ? 0.75 : 1);
  return { fill: mix(v.t.surface, v.colorOf.get(name), share), name };
}

// A pan (state.js) sliding Every day to another period: the days of both periods, still with the artists it has, and
// each frame (panCalendarTo) places them for the days `at` shows. Laid out the same way at both ends (both a strip,
// both strips per year, or both rows of weeks), the strip's columns or the rows travel from the old period's place
// to the new one's in step with the window, the box size and the tint's scale between the two. Laid out differently
// (a morph), every day has a box in each layout (in "weeks", its week's) and moves and resizes from one to the other,
// its tint crossing from the old layout's to the new one's, so a week's seven days gather into its box or spread out
// of it, and the labels cross-fade. Either way, when the length changes, days at the ends grow or shrink.
// endPanCalendar hands back to the usual render, which lands where it already is.
export function panCalendar(el, plays, lo, hi, p) {
  const v = views.get(el);
  if (!v?.boxes) return false;
  const w = el.clientWidth || 1000;
  const from = { lo: Math.round(p.from.lo), hi: Math.round(p.from.hi) };
  const was = v.calPan;
  const mf = was?.now ?? calMode(from.lo, from.hi, w), mt = calMode(p.to.lo, p.to.hi, w);
  if (v.waiting) {
    clearTimeout(v.waitTimer);
    v.waiting = false;
    fadeCanvas(v, 1, dur(FADE_MS), EASE_OUT.css);
  }
  hideTip();
  // (a resize, the two lengths differing, grows and shrinks the boxes at its ends instead of fading them)
  const grow = Math.abs(p.to.hi - p.to.lo - (p.from.hi - p.from.lo)) > 0.5 ? { from: p.from, to: p.to } : null;
  const cellsOf = (r, weeks) => calendarCells(agg.filterRange(plays, r.lo, r.hi), r.lo, r.hi, v.keep, weeks);
  const toCells = cellsOf(p.to, mt.kind === "weeks");
  const fromTop = v.cells.top;
  Object.assign(v, { plays, lo, hi });
  v.cells = calendarCells(plays, lo, hi, v.keep, mt.kind === "weeks");
  size(v, tune.calendarHeight);
  if (mf.kind === mt.kind && !was?.days) {
    v.calPan = { p, mf, mt, grow, topFrom: fromTop, topTo: toCells.top, now: mf };
    return true;
  }
  // A morph: each day's box and tint at both ends, the old end taken from what's on screen
  const fromCells = was?.days ? null : cellsOf(from, mf.kind === "weeks");
  const prev = new Map(was?.days?.map((d) => [d.k, d]));
  const tint = (cells, k, top, weeks) => tintOf(v, cells.cells.get(weeks ? weekKey(k) : k), top);
  // (a day in only one of the periods grows or shrinks where it is at that end, rather than flying in from a layout
  // that doesn't show it)
  const days = [];
  for (let k = lo; k <= hi; k++) {
    const d = prev.get(k), inFrom = !!d?.fill || (k >= from.lo && k <= from.hi), inTo = k >= p.to.lo && k <= p.to.hi;
    const ct = inTo ? tint(toCells, k, toCells.top, mt.kind === "weeks") : null;
    const cf = d?.fill ? { fill: d.fill, name: d.name } : inFrom ? tint(fromCells, k, fromTop, mf.kind === "weeks") : ct;
    const rf = inFrom ? (d?.now ?? rectOf(mf, k)) : null, rt = inTo ? rectOf(mt, k) : null;
    days.push({ k, rf: rf ?? rt, rt: rt ?? rf, cf: cf ?? ct, ct: ct ?? cf });
  }
  // The labels as they are at either end
  calPlace(v, mf, p.from);
  const labelsFrom = v.labels;
  calPlace(v, mt, p.to);
  v.calPan = { p, mf, mt, grow: { from: p.from, to: p.to }, days, labelsFrom, labelsTo: v.labels };
  return true;
}
export function panCalendarTo(el, at, e) {
  const v = views.get(el);
  const cp = v?.calPan;
  if (!cp) return;
  const { p, mf, mt } = cp;
  // (the columns or rows travel with the window's start, or with the clock if only its end moves)
  const f = p.to.lo !== p.from.lo ? clamp01((at.lo - p.from.lo) / (p.to.lo - p.from.lo)) : e;
  if (cp.days) morphPlace(v, cp, at, f);
  else {
    cp.now = { ...mt, cw: lerp(mf.cw, mt.cw, f), ch: lerp(mf.ch, mt.ch, f), shift: lerp(mf.shift, mt.shift, f) };
    v.cells.top = lerp(cp.topFrom, cp.topTo, e);
    calPlace(v, cp.now, at, cp.grow);
  }
  drawCalendar(v);
}
export function endPanCalendar(el, { lo, hi }) {
  const v = views.get(el);
  if (!v?.calPan) return;
  v.calPan = null;
  Object.assign(v, { lo, hi });
}

// A drag of the period window (rollingview.js): Every day follows each move rather than waiting for it to stop. It's
// given the days of a span wide enough for any drag, with the artists and tint scale it has, and held in the layout
// it was in (a strip, strips per year or rows of weeks); each move (dragCalendarTo) sets where it's heading, and the
// days shown and the layout's sizes and place chase it (CHASE_MS), so the columns or rows glide, days fade in and out
// at the window's ends as it moves and grow or shrink at an edge being dragged. endDragCalendar lands on the window's
// range as a pan does (panCalendar), morphing into another layout if its new length calls for one, then calls done.
export function dragCalendar(el, plays, lo, hi) {
  const v = views.get(el);
  if (!v?.boxes) return false;
  if (v.waiting) {
    clearTimeout(v.waitTimer);
    v.waiting = false;
    fadeCanvas(v, 1, dur(FADE_MS), EASE_OUT.css);
  }
  hideTip();
  // From what's on screen: a landing still in flight carries on from where it is (a morph from where it's heading)
  const land = v.calLand?.cp === v.calPan ? v.calLand : null;
  if (land) cancelAnimationFrame(land.raf);
  const at = land ? { ...land.at } : { lo: v.lo, hi: v.hi };
  const now = { ...(land ? (land.cp.now ?? land.cp.mt) : calMode(v.lo, v.hi, el.clientWidth || 1000)) };
  const top = v.cells.top;
  v.calPan = v.calLand = null;
  Object.assign(v, { plays, lo, hi });
  v.cells = calendarCells(plays, lo, hi, v.keep, now.kind === "weeks");
  v.cells.top = top;
  v.calDrag = { now, at, to: at, len: at.hi - at.lo, grow: false, t: 0, raf: 0 };
  return true;
}
export function dragCalendarTo(el, at) {
  const v = views.get(el), d = v?.calDrag;
  if (!d) return;
  d.to = { ...at };
  d.grow ||= Math.abs(at.hi - at.lo - d.len) > 0.5; // (an edge: its days grow and shrink rather than fade)
  if (d.raf) return;
  d.t = performance.now();
  d.raf = requestAnimationFrame(() => chaseCalendar(v));
}
function chaseCalendar(v) {
  const d = v.calDrag;
  if (!d) return;
  const now = performance.now(), ms = dur(CHASE_MS);
  const k = ms ? 1 - Math.exp((d.t - now) / (ms / 4)) : 1; // (most of the way there in CHASE_MS)
  d.t = now;
  const m = calMode(d.to.lo, d.to.hi, v.width || 1000, d.now.kind);
  let still = true;
  const near = (a, b) => {
    const x = lerp(a, b, k);
    if (Math.abs(b - x) < 0.01) return b;
    still = false;
    return x;
  };
  for (const f of ["left", "cw", "ch", "shift"]) d.now[f] = near(d.now[f], m[f]);
  d.at = { lo: near(d.at.lo, d.to.lo), hi: near(d.at.hi, d.to.hi) };
  calPlace(v, d.now, d.at, d.grow || null);
  drawCalendar(v);
  d.raf = still ? 0 : requestAnimationFrame(() => chaseCalendar(v));
}
export function endDragCalendar(el, to, done) {
  const v = views.get(el), d = v?.calDrag;
  if (!d) return done();
  cancelAnimationFrame(d.raf);
  v.calDrag = null;
  const from = { ...d.at };
  const a = Math.floor(Math.min(from.lo, to.lo)), b = Math.ceil(Math.max(from.hi, to.hi));
  v.calPan = { now: d.now }; // (so the landing starts from the layout on screen)
  panCalendar(el, agg.filterRange(v.plays, a, b), a, b, { from, to });
  const cp = v.calPan, morph = !!cp.days;
  const ms = dur(morph ? MORPH_MS : CHASE_MS), ease = morph ? EASE_IN_OUT.js : EASE_OUT.js, t0 = performance.now();
  const land = (v.calLand = { cp, at: from, raf: 0 });
  const frame = (now) => {
    if (v.calPan !== cp) return; // (a pan or another drag took over)
    const t = ms ? clamp01((now - t0) / ms) : 1, e = ease(t);
    land.at = { lo: lerp(from.lo, to.lo, e), hi: lerp(from.hi, to.hi, e) };
    panCalendarTo(el, land.at, e);
    if (t < 1) {
      land.raf = requestAnimationFrame(frame);
      return;
    }
    v.calLand = null;
    endPanCalendar(el, to);
    done();
  };
  frame(t0);
}

// A morph's frame: each day's box f of the way from its old rect to its new one, grown as the window's ends allow,
// and its fill f of the way to its new tint
function morphPlace(v, cp, at, f) {
  const boxes = [];
  for (const d of cp.days) {
    const { rf, rt, cf, ct } = d;
    d.now = { x: lerp(rf.x, rt.x, f), y: lerp(rf.y, rt.y, f), w: lerp(rf.w, rt.w, f), h: lerp(rf.h, rt.h, f) };
    d.fill = cf.fill === ct.fill ? cf.fill : mix(cf.fill, ct.fill, f);
    d.name = f < 0.5 ? cf.name : ct.name;
    const g = growAt(d.k + 0.5, cp.grow, at);
    if (g > 0) boxes.push({ ...d.now, a: 1, g, fill: d.fill, name: d.name });
  }
  v.boxes = boxes;
  const fade = (labels, a) => labels.map((l) => [...l.slice(0, 5), l[5] * a]);
  v.labels = [...fade(cp.labelsFrom, 1 - f), ...fade(cp.labelsTo, f)];
}

function drawCalendar(v) {
  const { ctx, t, width: w, cssH: h } = v;
  if (!v.boxes || v.waiting) return;
  const { cells, top } = v.cells;
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = "middle";
  // The years read first, larger and brightest; the months along the top next; the weekdays quietest
  for (const [x, y, text, align, year, a] of v.labels) {
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    ctx.font = year ? `600 13px ${t.font}` : `11px ${t.font}`;
    ctx.fillStyle = year ? t.primary : align === "left" ? t.secondary : t.muted;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  }
  const rings = [];
  for (const b of v.boxes) {
    ctx.globalAlpha = b.a;
    const { fill, name } = b.fill ? b : tintOf(v, cells.get(b.key), top); // (a morph's boxes carry their fill)
    ctx.fillStyle = fill;
    roundRect(ctx, ...scaled(b), 2);
    const o = name ? (lookOf(v, name)?.o ?? 0) : 0;
    if (o > 0.01) rings.push([b, name, o * b.a]);
  }
  // A pinned artist's boxes are ringed in their color (only a pin outlines)
  ctx.lineWidth = 1.5;
  for (const [b, name, o] of rings) {
    ctx.globalAlpha = o;
    ctx.strokeStyle = v.colorOf.get(name);
    const [x, y, bw, bh] = scaled(b);
    ctx.beginPath();
    ctx.roundRect(x + 0.75, y + 0.75, Math.max(0, bw - 1.5), Math.max(0, bh - 1.5), 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// A box's rect, scaled about its centre by how grown it is
const scaled = ({ x, y, w, h, g = 1 }) => [x + (w * (1 - g)) / 2, y + (h * (1 - g)) / 2, w * g, h * g];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  ctx.fill();
}

function pickCalendar(v, x, y) {
  const b = !v.waiting && !v.calPan && !v.calDrag && v.boxes?.find((b) => x >= b.x && x < b.x + b.w + CAL.gap && y >= b.y && y < b.y + b.h + CAL.gap);
  if (!b) return null;
  const c = v.cells.cells.get(b.key);
  const d = agg.dayToDate(b.from);
  const title = v.cells.weeks
    ? `Week of ${d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`
    : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  if (!c) return { name: null, html: `<b>${esc(title)}</b>${tipMuted("Nothing played")}` };
  if (!c.best) return { name: null, html: `<b>${esc(title)}</b>${tipMuted("None of the shown artists")}` };
  const name = v.colorOf.has(c.best) ? c.best : OTHER;
  return {
    name: name === OTHER ? OTHER : c.best,
    html: `<div class="muted" style="margin-bottom:4px">${esc(title)} · ${fmtH(c.h)}</div>` + tipTitle(v.colorOf.get(name), c.best) + tipMuted(`${fmtH(c.bh)} of it`),
  };
}

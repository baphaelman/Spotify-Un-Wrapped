// Every play and Every day: two graphs drawn on their own canvas rather than by ECharts. Every play has a mark per
// play (a hundred thousand over all time), and ECharts can neither fade that many marks on a hover nor draw them
// fast, so each artist's marks are one Path2D, built once per layout, and a frame is a dozen fills. Both follow the
// rolling chart's artists, colors, pins and hover (litLook, eased per artist), fade out while the period moves and
// back in once it settles (refresh), and show their own hover card.

import * as agg from "./aggregate.js";
import { FADE_MS, CHASE_MS, ENTER_MS, MORPH_MS, EASE_IN_OUT, EASE_OUT, dur, litLook, isPinLook } from "./motion.js";
import { shownName, OTHER } from "./state.js";
import { tune } from "./tune.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Blend two hex colors; w is the share of b
function mix(a, b, w) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v * (1 - w) + y[i] * w).toString(16).padStart(2, "0")).join("");
}

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
    other: v("--other"),
    series: Array.from({ length: 10 }, (_, i) => v(`--series-${i + 1}`)),
    font: getComputedStyle(document.body).fontFamily,
  };
}

const fmtH = (h) => (h >= 10 ? Math.round(h) + " h" : h >= 1 ? h.toFixed(1) + " h" : Math.max(1, Math.round(h * 60)) + " min");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HOUR = 3600e3;
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
function animate(v) {
  cancelAnimationFrame(v.raf);
  const frame = () => {
    v.draw(v);
    if ([...v.looks.keys()].some((n) => !lookOf(v, n).done)) v.raf = requestAnimationFrame(frame);
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
// under 10 s are left out. The marks are merged per pixel column where they overlap, so all time draws fast.
const GRID = { top: 10, bottom: 30, left: 52, right: 12 };

export function renderRaster(el, plays, lo, hi, names = [], slots = [], pins = null, hover = () => {}) {
  const v = setup(el, drawRaster, pickRaster);
  const data = [playsKey(plays), lo, hi, names.join("\u0000"), slots.join(), tokens().surface];
  const key = [...data, tune.rasterHeight];
  const relaid = v.key?.some((x, i) => x !== key[i]) ?? true;
  adopt(v, names, slots, pins, hover, OTHER_SHADE);
  v.table = MARK_SHADE;
  refresh(v, data, key, { plays, lo, hi }, () => layoutRaster(v), relaid);
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
  const plotW = Math.max(1, w - GRID.left - GRID.right), plotH = h - GRID.top - GRID.bottom;
  const days = hi - lo + 1, dw = plotW / days, pph = plotH / 24;
  const dpr = devicePixelRatio || 1;
  const known = new Set(names);
  // Per layer, per device-pixel column, the marks' [y0, y1] runs; and per day, the plays for the pointer
  const cols = new Map([[OTHER, new Map()], ...names.map((n) => [n, new Map()])]);
  v.byDay = Array.from({ length: days }, () => []);
  const put = (layer, day, y0, y1, p) => {
    const x0 = GRID.left + day * dw;
    const col = Math.floor(x0 * dpr);
    const m = cols.get(layer);
    let runs = m.get(col);
    if (!runs) m.set(col, (runs = []));
    runs.push([y0, y1, x0]);
    v.byDay[day].push({ y0, y1, p, layer });
  };
  for (const p of plays) {
    const ms = p.ms / (p.w ?? 1); // the genres view shares a play's time out between its genres
    if (ms < 10000) continue;
    const start = p.t - ms;
    const day = agg.dayIndex(start) - lo;
    const s = new Date(start), hour = s.getHours() + s.getMinutes() / 60 + s.getSeconds() / 3600;
    const layer = known.has(p.artist) ? p.artist : OTHER;
    const len = ms / HOUR;
    const y0 = GRID.top + hour * pph;
    const y1 = GRID.top + Math.min(24, hour + len) * pph;
    if (day >= 0 && day < days) put(layer, day, y0, Math.max(y1, y0 + 1.5), p);
    if (hour + len > 24 && day + 1 >= 0 && day + 1 < days) put(layer, day + 1, GRID.top, GRID.top + (hour + len - 24) * pph, p);
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
  for (const [k, label] of v.xTicks) ctx.fillText(label, GRID.left + k * v.dw, h - GRID.bottom + 10);
  // The gray first, then the artists from the last in rank up, the pinned on top
  const order = [OTHER, ...[...v.names].reverse().filter((n) => !v.pinned.has(n)), ...v.names.filter((n) => v.pinned.has(n))];
  for (const n of order) {
    const look = lookOf(v, n);
    const path = v.paths.get(n);
    if (!look || !path) continue;
    ctx.fillStyle = mix(t.surface, v.colorOf.get(n), look.s);
    ctx.fill(path);
  }
}

function pickRaster(v, x, y) {
  if (!v.byDay || v.waiting || x < GRID.left || x > v.width - GRID.right || y < GRID.top || y > v.cssH - GRID.bottom) return null;
  const day = Math.floor((x - GRID.left) / v.dw);
  // Under a pixel wide, a day's marks share their column with their neighbours': look a pixel or two either way
  const reach = Math.ceil(2 / v.dw);
  let best = null, bestD = Infinity;
  for (let d = Math.max(0, day - (v.dw < 1 ? reach : 0)); d <= Math.min(v.byDay.length - 1, day + (v.dw < 1 ? reach : 0)); d++) {
    for (const m of v.byDay[d]) {
      const dy = y < m.y0 ? m.y0 - y : y > m.y1 ? y - m.y1 : 0;
      const dd = dy + Math.abs(d - day) * v.dw;
      if (dy <= 2 && dd < bestD) (best = m), (bestD = dd);
    }
  }
  if (!best) return null;
  const p = best.p;
  const col = mix(v.t.surface, v.colorOf.get(best.layer), 0.9);
  const sub = p.track && p.track !== shownName(p.artist) ? `<div>${esc(p.track)}${p.by && p.by !== p.artist ? ` · ${esc(p.by)}` : ""}</div>` : "";
  const when = new Date(p.t - p.ms / (p.w ?? 1)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return { name: best.layer === OTHER ? OTHER : p.artist, html: tipTitle(col, best.layer === OTHER ? p.artist : best.layer) + sub + tipMuted(`${esc(when)} · ${fmtH(p.ms / (p.w ?? 1) / HOUR)}`) };
}

// ---------- Every day ----------

// A calendar of the period, each box tinted by its top artist and darker the more you listened (up to the period's
// 95th percentile). Up to two years it has a box per day (a rolling year in one strip, longer in a strip per
// calendar year); beyond, a box per week, a row per year, the boxes about twice as tall as wide so all time isn't a
// thin strip. Days whose top isn't one of the chart's artists are gray.
const DAY_MODE_MAX = 731;

// onUnit("day" | "week") is told which it draws, as it draws it (for the card's title and note)
export function renderCalendar(el, plays, lo, hi, names = [], slots = [], pins = null, hover = () => {}, onUnit = null) {
  const v = setup(el, drawCalendar, pickCalendar);
  const key = [playsKey(plays), lo, hi, names.join("\u0000"), slots.join(), tokens().surface];
  const relaid = v.key?.some((x, i) => x !== key[i]) ?? true;
  adopt(v, names, slots, pins, hover, DAY_FACTOR);
  v.table = DAY_FACTOR;
  v.onUnit = onUnit;
  refresh(v, key, key, { plays, lo, hi }, () => {
    if (v.cells?.plays !== v.plays || v.cells.lo !== v.lo || v.cells.hi !== v.hi) v.cells = calendarCells(v.plays, v.lo, v.hi);
    v.onUnit?.(v.cells.weeks ? "week" : "day");
    layoutCalendar(v);
  }, relaid);
}

// Each day's (or week's) hours and top artist, and the scale for the tint
function calendarCells(plays, lo, hi) {
  const weeks = hi - lo + 1 > DAY_MODE_MAX;
  const jan1 = (y) => agg.dayIndex(new Date(y, 0, 1).getTime());
  const keyOf = weeks
    ? (k) => {
        const y = agg.dayToDate(k).getFullYear();
        return y * 100 + Math.min(52, Math.floor((k - jan1(y)) / 7));
      }
    : (k) => k;
  const by = new Map();
  for (const p of plays) {
    const key = keyOf(agg.dayIndex(p.t));
    let m = by.get(key);
    if (!m) by.set(key, (m = new Map()));
    m.set(p.artist, (m.get(p.artist) ?? 0) + p.ms / HOUR);
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
  const sorted = [...cells.values()].map((c) => c.h).sort((a, b) => a - b);
  return { plays, lo, hi, weeks, jan1, cells, top: sorted[Math.floor(sorted.length * 0.95)] || 1 };
}

const CAL = { top: 22, left: 52, right: 8, gap: 2, rowGap: 14 }; // (left: the week rows'; the day strips set their own)

function layoutCalendar(v) {
  const { lo, hi } = v;
  const { weeks, jan1 } = v.cells;
  const w = v.el.clientWidth || 1000;
  const y0 = agg.dayToDate(lo).getFullYear(), y1 = agg.dayToDate(hi).getFullYear();
  const boxes = []; // { x, y, w, h, key, from } for each box in the period
  const labels = []; // [x, y, text, align, a year?]
  let height;
  if (weeks) {
    const cw = Math.max(5, Math.min(24, Math.floor((w - CAL.left - CAL.right) / 53)));
    const ch = cw * 2;
    for (let y = y0; y <= y1; y++) {
      const top = CAL.top + (y - y0) * (ch + CAL.gap);
      labels.push([CAL.left - 10, top + ch / 2, String(y), "right", true]);
      for (let wk = 0; wk < 53; wk++) {
        const from = jan1(y) + 7 * wk, to = wk === 52 ? jan1(y + 1) - 1 : from + 6;
        if (to < lo || from > hi) continue;
        boxes.push({ x: CAL.left + wk * cw, y: top, w: cw - CAL.gap, h: ch - CAL.gap, key: y * 100 + wk, from });
      }
    }
    const DOY = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]; // each month's first day of the year
    DOY.forEach((d, m) => labels.push([CAL.left + Math.floor(d / 7) * cw, CAL.top - 8, MON[m], "left"]));
    height = CAL.top + (y1 - y0 + 1) * (ch + CAL.gap) + 6;
  } else {
    // A strip per calendar year, or one for a period of a year or less
    const segs = [];
    if (hi - lo + 1 <= 371) segs.push([lo, hi]);
    else for (let y = y0; y <= y1; y++) segs.push([Math.max(lo, jan1(y)), Math.min(hi, jan1(y + 1) - 1)]);
    const left = segs.length > 1 ? 72 : 28; // room for the years, then the weekdays
    const colsOf = ([a, b]) => Math.floor((b - a + weekday(a)) / 7) + 1;
    const most = Math.max(...segs.map(colsOf));
    const cell = Math.max(6, Math.min(24, Math.floor((w - left - CAL.right) / most)));
    const segH = cell * 7 + CAL.top + CAL.rowGap;
    segs.forEach(([a, b], i) => {
      const top = CAL.top + i * segH;
      const start = a - weekday(a); // the Monday of the first column
      if (segs.length > 1) labels.push([left - 26, top + (cell * 7) / 2, String(agg.dayToDate(a).getFullYear()), "right", true]);
      ["M", "", "W", "", "F", "", ""].forEach((d, r) => d && labels.push([left - 8, top + r * cell + cell / 2, d, "right"]));
      for (let k = a; k <= b; k++) {
        const col = Math.floor((k - start) / 7), row = weekday(k);
        boxes.push({ x: left + col * cell, y: top + row * cell, w: cell - CAL.gap, h: cell - CAL.gap, key: k, from: k });
        const d = agg.dayToDate(k);
        // (a period starting late in a month labels it only if there's room before the next)
        if (d.getDate() === 1 || (k === a && d.getDate() <= 18)) labels.push([left + col * cell, top - 8, MON[d.getMonth()], "left"]);
      }
    });
    height = CAL.top + (segs.length - 1) * segH + cell * 7 + 6;
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
  size(v, height);
  if (v.looks.size) v.draw(v);
}

function drawCalendar(v) {
  const { ctx, t, width: w, cssH: h } = v;
  if (!v.boxes || v.waiting) return;
  const { cells, top } = v.cells;
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = "middle";
  // The years read first, larger and brightest; the months along the top next; the weekdays quietest
  for (const [x, y, text, align, year] of v.labels) {
    ctx.font = year ? `600 13px ${t.font}` : `11px ${t.font}`;
    ctx.fillStyle = year ? t.primary : align === "left" ? t.secondary : t.muted;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  }
  const empty = mix(t.surface, t.grid, 0.6);
  const rings = [];
  for (const b of v.boxes) {
    const c = cells.get(b.key);
    if (!c) {
      ctx.fillStyle = empty;
      roundRect(ctx, b.x, b.y, b.w, b.h, 2);
      continue;
    }
    const name = v.colorOf.has(c.best) ? c.best : OTHER;
    const look = lookOf(v, name) ?? { s: 1, o: 0 };
    const q = Math.min(1, Math.sqrt(c.h / top));
    const share = Math.min(1, (0.15 + 0.6 * q) * look.s) * (name === OTHER ? 0.75 : 1);
    ctx.fillStyle = mix(t.surface, v.colorOf.get(name), share);
    roundRect(ctx, b.x, b.y, b.w, b.h, 2);
    if (look.o > 0.01) rings.push([b, name, look.o]);
  }
  // A pinned artist's boxes are ringed in their color (only a pin outlines)
  ctx.lineWidth = 1.5;
  for (const [b, name, o] of rings) {
    ctx.globalAlpha = o;
    ctx.strokeStyle = v.colorOf.get(name);
    ctx.beginPath();
    ctx.roundRect(b.x + 0.75, b.y + 0.75, b.w - 1.5, b.h - 1.5, 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  ctx.fill();
}

function pickCalendar(v, x, y) {
  const b = !v.waiting && v.boxes?.find((b) => x >= b.x && x < b.x + b.w + CAL.gap && y >= b.y && y < b.y + b.h + CAL.gap);
  if (!b) return null;
  const c = v.cells.cells.get(b.key);
  const d = agg.dayToDate(b.from);
  const title = v.cells.weeks
    ? `Week of ${d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`
    : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  if (!c) return { name: null, html: `<b>${esc(title)}</b>${tipMuted("Nothing played")}` };
  const name = v.colorOf.has(c.best) ? c.best : OTHER;
  return {
    name: name === OTHER ? OTHER : c.best,
    html: `<div class="muted" style="margin-bottom:4px">${esc(title)} · ${fmtH(c.h)}</div>` + tipTitle(v.colorOf.get(name), c.best) + tipMuted(`${fmtH(c.bh)} of it`),
  };
}

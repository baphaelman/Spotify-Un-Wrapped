// "Rank race": where each item stood over the period, as a bump chart. The period is cut into months, or into
// 3 months, 6 months, a year or 2 years as Hours per month does (agg.monthSpan), at most one slice more than its bars.
// Every item that reached the top `tune.rankMax` in the period gets a line; the chart's artists keep their colors
// and the rest are gray, behind them. By the month, a rank is taken over the months around each one, so a phase
// reads as a line rather than dots. Circles sit only where an item is on the chart, and are the data; between them
// a line dives below the floor, the deeper the further down the item really was, and comes back. Every line is
// named at its best point (the chart's and pinned artists; grays aren't named). Hovering marks the slice nearest the
// pointer with a column and reads it in a card beside it; there the circles ride their lines while the rest shrink
// into them, and moving to another slice glides the column, the circles (along the lines, through the floor) and the
// card's rows (overtaking each other like the bars of a race) together, on one tick (see glide).
// Lines that leave (a new period, a deselected artist) dive away and fade before they're dropped.
// Lit looks follow the page: hover (anywhere) and pins.
import * as agg from "./aggregate.js";
import { FADE_MS, CHASE_MS, MORPH_MS, EASE_IN_OUT, EASE_OUT, dur, litLook, isLitLook, setOptionFaded, easeOut } from "./motion.js";
import { $, state, putOff, rangePlays, shownName } from "./state.js";
import { tune } from "./tune.js";
import { focusArtist } from "./charts.js";
import { mixArgs } from "./rollingview.js";

const HOUR = 3_600_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Per span (months): what a slice is called, and how the note says the chart steps
const SPANS = {
  1: ["month", "month by month"],
  3: ["quarter", "quarter by quarter"],
  6: ["half-year", "half-year by half-year"],
  12: ["year", "year by year"],
  24: ["two years", "two years at a time"],
};
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const fmtH = (h) => (h >= 10 ? Math.round(h) + " h" : h >= 1 ? h.toFixed(1) + " h" : Math.max(1, Math.round(h * 60)) + " min");

function alpha(hex, a) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

let c = null;
let st = null; // what the last paint drew: { names, leaving, rows, labels, colors, MAX, t, unit, hovered }
let dropTimer = 0; // drops the lines that faded out

function tokens() {
  const css = getComputedStyle(document.body);
  const v = (n) => css.getPropertyValue(n).trim();
  return { surface: v("--surface"), primary: v("--text-primary"), secondary: v("--text-secondary"), muted: v("--text-muted"), grid: v("--grid"), axis: v("--axis") || v("--grid"), other: v("--other"), series: (slot) => v(`--series-${slot + 1}`) };
}

function chart(el) {
  if (!c || c.isDisposed() || c.getDom() !== el) {
    c?.dispose();
    c = echarts.init(el, null, { renderer: "canvas" });
    new ResizeObserver(() => {
      if (el.clientWidth === c.getWidth() && el.clientHeight === c.getHeight()) return;
      c.resize();
      paintTimeline();
    }).observe(el);
    // The lines don't take the pointer: scrub picks who it's on. A click pins them (one that isn't the chart's joins it)
    c.getZr().on("click", () => st?.hovered != null && pointer && mixArgs?.[3]?.toggle(st.hovered));
    c.getZr().on("mousemove", (e) => scrub(e.offsetX, e.offsetY));
    c.getZr().on("globalout", () => scrub(null));
  }
  return c;
}

// Hovering a line lights it here and, when it's one of the chart's artists, everywhere
function hover(name) {
  if (!st || st.hovered === name || st.leaving.has(name)) return;
  if (name == null || st.colors.has(name)) focusArtist($("chart-rolling"), name);
  focusRankRace(name);
}

// The period's ranks: for each slice of `span` months (empty ones too), a Map item -> { r: rank, h: the hours it's
// ranked by (by the month, the month and those either side)
function ranksOf(plays, span) {
  const keyOf = (t) => { const d = new Date(t); return Math.floor((d.getFullYear() * 12 + d.getMonth()) / span); };
  const buckets = new Map();
  for (const p of plays) {
    const k = keyOf(p.t);
    if (!buckets.has(k)) buckets.set(k, new Map());
    const m = buckets.get(k);
    m.set(p.artist, (m.get(p.artist) ?? 0) + p.ms / HOUR);
  }
  const keys = [];
  if (plays.length) for (let k = keyOf(plays[0].t); k <= keyOf(plays.at(-1).t); k++) keys.push(k);
  const reach = span === 1 ? 1 : 0;
  const rows = keys.map((k, i) => {
    const m = new Map();
    for (const kk of keys.slice(Math.max(0, i - reach), i + reach + 1))
      for (const [a, h] of buckets.get(kk) ?? []) m.set(a, (m.get(a) ?? 0) + h);
    return new Map([...m].sort((a, b) => b[1] - a[1]).map(([a, h], j) => [a, { r: j + 1, h }]));
  });
  const label = (k) => {
    const m0 = k * span, y = Math.floor(m0 / 12), m = m0 % 12, yy = String(y).slice(2);
    if (span === 1) return `${MON[m]} ${yy}`;
    if (span === 3) return `Q${m / 3 + 1} ${yy}`;
    if (span === 6) return `H${m / 6 + 1} ${yy}`;
    if (span === 12) return String(y);
    return `${y}–${String(y + 1).slice(2)}`;
  };
  return { rows, labels: keys.map(label) };
}

export function paintRankRace() {
  const el = $("chart-rank");
  if (!state.plays || !state.range || putOff($("rank-card"), () => paintRankRace())) return;
  const t = tokens();
  const plays = rangePlays();
  const span = agg.monthSpan(plays, tune.maxBars + 1);
  const { rows, labels } = ranksOf(plays, span);
  const [unit, steps] = SPANS[span];
  $("rank-note").textContent = `Where everything that reached the top ${tune.rankMax} stood, ${steps}` +
    (span === 1 ? ", ranked over the months around each month" : "") + ". Circles are where it was on the chart.";
  if (rows.length < 2) { scrub(null); dropRiders(); paintTimeline(true); c?.clear(); st = null; return; }

  const MAX = tune.rankMax;
  const hidden = new Set(state.hidden);
  const colors = new Map();
  for (const [name, slot] of state.colorSlots) if (state.chartNames?.includes(name)) colors.set(name, t.series(slot));
  const names = new Set();
  for (const m of rows) for (const [a, e] of m) if (e.r <= MAX && !hidden.has(a)) names.add(a);
  // Lines drawn before and not now stay a while, diving away as they fade (also any still fading from before)
  const fresh = !c || c.isDisposed() || !st;
  const leaving = new Set(fresh ? [] : [...st.names, ...st.leaving].filter((a) => !names.has(a)));
  st = { names: [...names], leaving, rows, labels, colors, MAX, t, unit, hovered: st?.hovered ?? null, col: null };
  // (the column the pointer is over, set before drawing, so a redraw under the pointer doesn't cut its own morph short)
  if (pointer && c && !c.isDisposed()) st.col = at = colAt(pointer[0]);
  const cc = chart(el);
  el.parentElement.dataset.look = tune.rankCursor;
  clearTimeout(dropTimer);
  if (fresh) cc.setOption(option(), { notMerge: true });
  else setOptionFaded(cc, option(), { replaceMerge: ["series"] }, dur(MORPH_MS));
  paintTimeline();
  // The card and circles follow at once (a pin's color, new ranks)
  if (pointer) draw();
  if (leaving.size) dropTimer = setTimeout(() => {
    st.leaving = new Set();
    cc.setOption({ series: seriesOf() }, { replaceMerge: ["series"] });
  }, dur(MORPH_MS) + 50);
}

const yOf = (m, a, MAX) => {
  const e = m.get(a);
  if (e && e.r <= MAX) return e.r;
  return MAX + tune.rankDive * Math.log2((e ? e.r : m.size + 50) - MAX + 1);
};

// Room above #1 for a name over its circle
const headroom = () => Math.ceil(tune.rankDot / 2 + 8 + tune.rankText + 2 + 4);
// The plot keeps the spacing it has with REF_RANKS ranks in the chart's height; fewer, and what's left goes to the lane
// above #1 ("Timeline"), from LANE_TOP down (at least the room for #1's names and the word)
const REF_RANKS = 20, LANE_TOP = 6, PLOT_TOP = 30, PLOT_BOTTOM = 30, PLOT_LEFT = 64; // (room for "Timeline")
function plotTop(MAX) {
  const H = $("chart-rank").clientHeight || 520;
  const per = (H - PLOT_TOP - PLOT_BOTTOM) / (REF_RANKS + 0.4 - 1);
  const lane = H - PLOT_TOP - PLOT_BOTTOM - per * (MAX + 0.4 - 1);
  return PLOT_TOP + Math.max(lane, headroom() + 20 - PLOT_TOP);
}
const laneY = (MAX) => (LANE_TOP + plotTop(MAX) - headroom()) / 2; // (the timeline's height)

// The chart's pinned items that are drawn
const pinnedSet = () => new Set(state.pinned.filter((n) => st.names.includes(n)));

// How an item shows, by the page's lit looks: its color, how much it dims, whether it's lit, its line's opacity and
// its circle's size
function lookOf(a, pinned) {
  const col = st.colors.get(a), gone = st.leaving.has(a);
  const look = litLook(pinned, st.hovered, a);
  const lit = isLitLook(look), dimmed = look === "dim" || look === "dimHover";
  const k = gone ? 0 : dimmed ? tune.rankDim : 1;
  const lineOp = (col ? 1 : tune.rankGrayOpacity) * k;
  return { col, gone, lit, k, base: col ?? st.t.other, lineOp, size: (col ? tune.rankDot : tune.rankGrayDot) * (lit ? 1.25 : 1) };
}
const nameStyle = (L) => ({
  fontSize: L.col ? tune.rankText + 2 : tune.rankText, fontWeight: L.col ? 700 : 500,
  color: L.col ? alpha(L.base, Math.min(1, 0.4 + L.k)) : alpha(st.t.muted, tune.rankGrayText * L.k),
  textBorderColor: alpha(st.t.surface, 0.85), textBorderWidth: L.col ? 3 : 2.5,
});

const SMOOTH = 0.5; // the lines' curve rounding (lineY follows it)

// ms: how long the circles take to grow or shrink (into the lines, while hovering)
function seriesOf(ms = MORPH_MS) {
  const { names, leaving, rows, MAX, col: at } = st;
  const pinned = pinnedSet();
  const n = rows.length;
  return [...names, ...leaving].map((a) => {
    const L = lookOf(a, pinned);
    const ys = rows.map((m) => yOf(m, a, MAX));
    // The best (lowest) rank, earliest: where the name goes, for the chart's and pinned artists. Hovering, one on the
    // chart in the hovered column is named there instead, over its riding circle
    let named = -1;
    if (!L.gone && (L.col || pinned.has(a)) && !(at != null && ys[at] <= MAX))
      ys.forEach((y, i) => { if (y <= MAX && (named < 0 || y < ys[named])) named = i; });
    const data = ys.map((y, i) => {
      const d = { value: y, symbol: y <= MAX ? "circle" : "none" };
      if (at != null) d.symbolSize = 0;
      if (i === named)
        d.label = { show: true, formatter: shownName(a), position: i < n * 0.15 ? "right" : i > n * 0.85 ? "left" : "top", distance: L.col ? 8 : 6, ...nameStyle(L) };
      return d;
    });
    return {
      id: a, name: a, type: "line", smooth: SMOOTH, smoothMonotone: "x", clip: true, z: L.col ? (L.lit ? 6 : 4) : L.lit ? 5 : 2,
      symbol: "circle", symbolSize: L.size, showSymbol: true,
      silent: true,
      data, animationDurationUpdate: dur(ms),
      lineStyle: { width: (L.col ? tune.rankWidth : tune.rankGrayWidth) * (L.lit ? 1.4 : 1), color: L.base, opacity: L.lineOp },
      itemStyle: { color: L.base, opacity: Math.min(1, L.lineOp + (L.gone ? 0 : 0.3)), borderColor: st.t.surface, borderWidth: L.col ? 1.5 : 1 },
      emphasis: { disabled: true },
    };
  });
}

function option() {
  const { labels, MAX, t } = st;
  const axis = { axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false }, axisLabel: { color: t.muted } };
  return {
    // (lines appear by drawing in left to right, on the same tier as lines leaving)
    animationDuration: dur(MORPH_MS), animationEasing: EASE_IN_OUT.echarts, animationDurationUpdate: dur(MORPH_MS), animationEasingUpdate: EASE_IN_OUT.echarts,
    textStyle: { fontFamily: "inherit", color: t.secondary },
    tooltip: { show: false }, // (the hover draws its own card)
    grid: { top: plotTop(MAX), bottom: PLOT_BOTTOM, left: PLOT_LEFT, right: 28 },
    // The lane above #1, named like a rank (its line and dots are paintTimeline's); between it and #1 is the room
    // for #1's names
    graphic: [{ type: "text", id: "lane", silent: true, x: PLOT_LEFT - 8, y: laneY(MAX),
      style: { text: "Timeline", align: "right", verticalAlign: "middle", fill: t.muted, font: "500 12px Inter, sans-serif" } }],
    xAxis: { type: "category", data: labels, boundaryGap: false, ...axis, splitLine: { show: false } },
    yAxis: { type: "value", inverse: true, min: 1, max: MAX + 0.4, interval: 1, ...axis, splitLine: { lineStyle: { color: t.grid, opacity: 0.5 } }, axisLabel: { color: t.muted, formatter: (r) => (Number.isInteger(r) && r <= MAX ? "#" + r : "") } },
    series: seriesOf(),
  };
}

// An item lit from anywhere (the key, another graph, a hover here), or null for none
export function focusRankRace(name) {
  if (!st || !c || c.isDisposed()) return;
  if (st.hovered === name) return;
  st.hovered = name;
  setOptionFaded(c, { series: seriesOf(CHASE_MS) }, undefined, dur(FADE_MS));
  if (pointer) draw();
}

// ---------- hovering ----------
// The pointer over the plot picks the nearest slice (st.col). In the lane above #1 (the timeline) it lights no one, so the
// column can be swept to watch the race; below, it's always on someone: whoever in the column is nearest it up or
// down. `at` is the slice shown, fractional while gliding to
// it; `shown` is how far the hover's look is in, 0 to 1 (the riders' names; as it leaves, the riders too).
let pointer = null;
let at = 0, shown = 0;
let anim = 0; // the glide's frame
let riders = null; // item -> { dot, text }: a circle per line, riding it at `at`
let tlRider = null; // the timeline's
const rowEls = new Map(); // item -> its row in the card

function scrub(x, y) {
  const rect = x != null && st && c && !c.isDisposed() ? gridRect() : null;
  if (!rect || x < rect.x - 8 || x > rect.x + rect.width + 8 || y < LANE_TOP || y > rect.y + rect.height) {
    if (pointer) leave();
    return;
  }
  const entering = !pointer;
  pointer = [x, y];
  const k = colAt(x);
  const who = y < rect.y - headroom() / 2 ? null : nearestAt(k, y, rect); // (#1's names count as below)
  if (entering) {
    // The circles shrink into the lines while riders take their place in the column (the same size there, so only
    // the names coming in show); the card and column fade in where they are
    st.col = at = k;
    setOptionFaded(c, { series: seriesOf(CHASE_MS) }, undefined, dur(CHASE_MS));
    timelineDots(0);
    glide(k, 1, true);
  } else if (k !== st.col) {
    st.col = k;
    setOptionFaded(c, { series: seriesOf(CHASE_MS) }, undefined, dur(CHASE_MS));
    glide(k, 1);
  } else draw();
  hover(who);
}

function leave() {
  pointer = null;
  hover(null);
  const frame = $("chart-rank").parentElement;
  frame.querySelector(".rank-tip").classList.remove("on");
  frame.querySelector(".rank-cursor").classList.remove("on");
  if (!st || !c || c.isDisposed()) return;
  st.col = null;
  setOptionFaded(c, { series: seriesOf(CHASE_MS) }, undefined, dur(CHASE_MS));
  timelineDots(TL_R);
  glide(at, 0);
}

// One tick moves everything the hover moves: the column, the riders along their lines, the card and its rows. An
// interruption carries on from where they are.
function glide(to, toShown, jump = false) {
  cancelAnimationFrame(anim);
  const from = jump ? to : at, fromShown = shown, ms = dur(CHASE_MS), start = performance.now();
  const tick = (now) => {
    // (a frame's time can be a little before the glide began: never ease outside 0..1, which would put `at` off the chart)
    const e = ms ? easeOut(Math.max(0, Math.min(1, (now - start) / ms))) : 1;
    at = from + (to - from) * e;
    shown = fromShown + (toShown - fromShown) * e;
    draw();
    if (e < 1) anim = requestAnimationFrame(tick);
    else if (!shown) dropRiders();
  };
  anim = requestAnimationFrame(tick);
}

const gridRect = () => c.getModel().getComponent("grid").coordinateSystem.getRect();
const rankY = (v, rect) => rect.y + ((v - 1) / (st.MAX + 0.4 - 1)) * rect.height;

// Whoever on the chart in slice k is nearest y (pixels)
function nearestAt(k, y, rect) {
  let best = null, gap = Infinity;
  for (const [a, e] of st.rows[k]) {
    if (e.r > st.MAX) break;
    if (!st.names.includes(a)) continue;
    const d = Math.abs(rankY(e.r, rect) - y);
    if (d < gap) { gap = d; best = a; }
  }
  return best;
}
function colAt(x) {
  const rect = gridRect(), n = st.rows.length;
  return Math.max(0, Math.min(n - 1, Math.round(((x - rect.x) / rect.width) * (n - 1))));
}

// Where a line is at x (pixels), as ECharts draws it: with smoothMonotone "x", each segment is a cubic Bézier whose
// control points are level with its ends, SMOOTH of a slice in from them (none at the line's two ends)
function lineY(a, x, rect) {
  const { rows, MAX } = st, n = rows.length, slice = rect.width / (n - 1);
  const py = (v) => rankY(v, rect);
  const i = Math.max(0, Math.min(n - 2, Math.floor((x - rect.x) / slice)));
  const x0 = rect.x + i * slice, x3 = x0 + slice;
  const x1 = i === 0 ? x0 : x0 + SMOOTH * slice, x2 = i + 1 === n - 1 ? x3 : x3 - SMOOTH * slice;
  const y0 = py(yOf(rows[i], a, MAX)), y3 = py(yOf(rows[i + 1], a, MAX));
  const bx = (t) => (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3 * x3;
  let lo = 0, hi = 1;
  for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; }
  const t = (lo + hi) / 2;
  return (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * y0 + 3 * (1 - t) * t * t * y3 + t ** 3 * y3;
}

function dropRiders() {
  if (riders && c && !c.isDisposed()) for (const { dot, text } of riders.values()) { c.getZr().remove(dot); c.getZr().remove(text); }
  if (tlRider && c && !c.isDisposed()) c.getZr().remove(tlRider);
  riders = tlRider = null;
}

// ---------- the timeline ----------
// The lane above #1: a line with a dot at each slice. Hovering, the dots shrink into it and one rides it with the
// column (the riders' "timeline"). Drawn again only when its slices or place change, the old fading out as the new
// fades in.
const TL_R = 3.5;
let tl = null; // { key, line, dots }
function paintTimeline(drop = false) {
  if (!c || c.isDisposed()) return;
  const zr = c.getZr();
  const fade = (e, to, done) => e.animateTo({ style: { opacity: to } }, { duration: dur(MORPH_MS), easing: EASE_IN_OUT.echarts, done });
  const old = tl;
  if (drop || !st) {
    if (old) for (const e of [old.line, ...old.dots]) fade(e, 0, () => zr.remove(e));
    tl = null;
    return;
  }
  const rect = gridRect(), n = st.rows.length, slice = rect.width / (n - 1), y = laneY(st.MAX);
  const key = [n, rect.x, rect.width, y].join();
  if (old?.key === key) return;
  if (old) for (const e of [old.line, ...old.dots]) fade(e, 0, () => zr.remove(e));
  const line = new echarts.graphic.Line({ silent: true, z: 1, shape: { x1: rect.x, y1: y, x2: rect.x + rect.width, y2: y }, style: { stroke: st.t.axis, lineWidth: 1.5, opacity: 0 } });
  const dots = st.rows.map((_, i) => new echarts.graphic.Circle({ silent: true, z: 2, shape: { cx: rect.x + i * slice, cy: y, r: pointer ? 0 : TL_R }, style: { fill: st.t.muted, opacity: 0 } }));
  for (const e of [line, ...dots]) { zr.add(e); fade(e, 1); }
  tl = { key, line, dots };
}
function timelineDots(r) {
  for (const d of tl?.dots ?? []) {
    d.stopAnimation("shape");
    d.animateTo({ shape: { r } }, { duration: dur(CHASE_MS), easing: EASE_OUT.echarts, scope: "shape" });
  }
}

// Draws the hover at `at` and `shown`
function draw() {
  if (!st || !c || c.isDisposed()) return;
  const el = $("chart-rank"), frame = el.parentElement, tip = frame.querySelector(".rank-tip"), cursor = frame.querySelector(".rank-cursor");
  const rect = gridRect(), { rows, labels, colors, MAX, unit, hovered, names } = st;
  const n = rows.length, slice = rect.width / (n - 1), x = rect.x + at * slice;
  const pinned = pinnedSet();
  const floor = rect.y + rect.height;

  // The riders: a circle on each line at the column, hidden below the floor (clipped, as the lines are). The chart's
  // and pinned artists are named over theirs, and so is a gray one while it's lit; a name fades as it nears the floor
  const zr = c.getZr();
  riders ??= new Map();
  for (const [a, r] of riders) if (!names.includes(a)) { zr.remove(r.dot); zr.remove(r.text); riders.delete(a); }
  for (const a of names) {
    let r = riders.get(a);
    if (!r) {
      const clip = () => new echarts.graphic.Rect({ shape: { x: 0, y: 0, width: c.getWidth(), height: floor } });
      r = { dot: new echarts.graphic.Circle({ z: 10, silent: true }), text: new echarts.graphic.Text({ z: 11, silent: true }) };
      r.dot.setClipPath(clip());
      r.text.setClipPath(clip());
      zr.add(r.dot);
      zr.add(r.text);
      riders.set(a, r);
    }
    const L = lookOf(a, pinned), y = lineY(a, x, rect);
    const out = pointer ? 1 : shown; // (leaving, they fade with the rest)
    r.dot.attr({ shape: { cx: x, cy: y, r: L.size / 2 }, style: { fill: L.base, stroke: st.t.surface, lineWidth: L.col ? 1.5 : 1, opacity: Math.min(1, L.lineOp + 0.3) * out }, z: L.col ? (L.lit ? 13 : 12) : L.lit ? 12 : 10 });
    const named = L.col || pinned.has(a) || a === hovered;
    const depth = Math.max(0, Math.min(1, (floor + 4 - y) / 16));
    const ns = nameStyle(L);
    r.text.attr({
      style: { text: shownName(a), x, y: y - L.size / 2 - (L.col ? 8 : 6), align: "center", verticalAlign: "bottom", font: `${ns.fontWeight} ${ns.fontSize}px Inter, sans-serif`, fill: ns.color, stroke: ns.textBorderColor, lineWidth: ns.textBorderWidth, opacity: named ? shown * depth : 0 },
      z: L.col ? 15 : 14,
    });
    // (a name at either end stays whole on the canvas)
    if (named) {
      const half = r.text.getBoundingRect().width / 2, W = c.getWidth();
      r.text.attr({ style: { x: Math.max(half + 2, Math.min(W - half - 2, x)) } });
    }
  }
  if (!tlRider) {
    tlRider = new echarts.graphic.Circle({ silent: true, z: 3 });
    zr.add(tlRider);
  }
  tlRider.attr({ shape: { cx: x, cy: laneY(MAX), r: TL_R * 1.4 }, style: { fill: st.t.primary, opacity: pointer ? 1 : shown } });

  // The card: each row between its ranks in the slices either side of `at`, so as the column glides the rows
  // overtake each other; rows leaving the top ranks slide out at the bottom and fade
  const i = Math.max(0, Math.min(n - 1, Math.floor(at))), j = Math.min(n - 1, i + 1), u = Math.max(0, Math.min(1, at - i));
  const hidden = new Set(state.hidden), pins = new Set(state.pinned);
  const list = tip.querySelector(".rank-tip-rows");
  list.style.setProperty("--n", MAX);
  const seen = new Set();
  for (const m of [rows[i], rows[j]])
    for (const [a, e] of m) {
      if (e.r > MAX) break;
      if (hidden.has(a) || seen.has(a)) continue;
      seen.add(a);
      const ei = rows[i].get(a), ej = rows[j].get(a);
      const ri = Math.min(MAX + 1, ei?.r ?? Infinity), rj = Math.min(MAX + 1, ej?.r ?? Infinity);
      const r = ri + (rj - ri) * u, h = (ei?.h ?? 0) + ((ej?.h ?? 0) - (ei?.h ?? 0)) * u;
      let li = rowEls.get(a);
      if (!li) {
        li = document.createElement("div");
        li.className = "rank-tip-row";
        li.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
        li.children[1].textContent = shownName(a);
        rowEls.set(a, li);
      }
      if (li.parentElement !== list) list.append(li);
      const col = colors.get(a);
      if (col) li.style.setProperty("--c", col);
      else li.style.removeProperty("--c");
      li.style.setProperty("--y", r - 1);
      li.style.opacity = Math.max(0, Math.min(1, MAX + 1 - r));
      li.children[0].textContent = Math.round(r) <= MAX ? Math.round(r) : "";
      li.children[2].textContent = fmtH(h);
      li.classList.toggle("lit", a === hovered && !pins.has(a));
      li.classList.toggle("pinned", pins.has(a));
    }
  for (const [a, li] of rowEls) if (!seen.has(a)) { li.remove(); rowEls.delete(a); }
  const head = tip.querySelector(".rank-tip-head");
  head.replaceChildren(labels[Math.round(at)], Object.assign(document.createElement("small"), { textContent: `hours ${unit === "month" ? "over the 3 months around it" : `that ${unit}`}` }));
  if (!pointer) return; // (leaving: the card and column fade where they are)

  // The card beside the column, clear of its names, to its left where there's room
  const ox = el.offsetLeft, oy = el.offsetTop, w = tip.offsetWidth, ht = tip.offsetHeight, W = frame.clientWidth;
  const cx = ox + x;
  const left = cx - slice / 2 - w - 8 >= 0 ? cx - slice / 2 - w - 8 : Math.min(cx + slice / 2 + 8, W - w);
  const top = Math.max(0, Math.min(frame.clientHeight - ht, oy + pointer[1] - ht / 2));
  tip.style.transform = `translate(${left}px, ${top}px)`;
  tip.classList.add("on");
  // The column is at the slice (gliding with the rest), reaching up over #1's name; a line is at the pointer
  const column = tune.rankCursor === 2 || tune.rankCursor === 3, room = column ? rect.y - LANE_TOP : 0; // (the column runs up through the lane)
  frame.dataset.look = tune.rankCursor;
  cursor.style.setProperty("--x", `${column ? cx : ox + pointer[0]}px`);
  cursor.style.setProperty("--slice", `${slice}px`);
  cursor.style.top = `${oy + rect.y - room}px`;
  cursor.style.height = `${rect.height + room}px`;
  cursor.classList.add("on");
}

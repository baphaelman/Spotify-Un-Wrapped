// "Rank race": where each item stood over the period, as a bump chart. The period is cut into months, or into
// 3 months, 6 months, a year or 2 years as Top [Tab] Every [Month] does (agg.monthSpan), at most one slice more than its bars.
// Every item that reached the top `positions` (the slider at its top right) in the period gets a line; the chart's artists keep their colors
// and the rest are gray, behind them. A rank is taken over the months around each slice (1, 3 or 6, the slider
// beside it), so a phase reads as a line rather than dots. Circles sit only where an item is on the chart, and are the data; between them
// a line dives below the floor, the deeper the further down the item really was, and comes back. Every line is
// named at its best point (the chart's and pinned artists; grays aren't named). Hovering marks the slice nearest the
// pointer with a column and reads it in a card beside it; there the circles ride their lines while the rest shrink
// into them, and moving to another slice glides the column, the circles (along the lines, through the floor) and the
// card's rows (overtaking each other like the bars of a race) together, on one tick (see glide).
// New lines draw in along their length at one speed (see drawIn); lines that leave (a new period, a deselected
// artist) dive away and fade before they're dropped.
// Lit looks follow the page: hover (anywhere) and pins.
// A slice is also known by its key, counted from year 0, the same in any period. A pan (state.js) to a period of the
// same slice size slides the chart there rather than redrawing it (see slideStart).
import * as agg from "./aggregate.js";
import { FADE_MS, CHASE_MS, MORPH_MS, EASE_IN_OUT, EASE_OUT, dur, litLook, isLitLook, isPinLook, setOptionFaded, easeOut, easeInOut } from "./motion.js";
import { $, state, putOff, rangePlays, shownName, pan, onPan } from "./state.js";
import { tune, setTune } from "./tune.js";
import { focusArtist } from "./charts.js";
import { tokens, alpha } from "./colors.js";
import { esc, fmtH, MON } from "./format.js";
import { HOUR } from "./aggregate.js";

// Per span (months): what a slice is called, and how the note says the chart steps
const SPANS = {
  1: ["month", "month by month"],
  3: ["quarter", "quarter by quarter"],
  6: ["half-year", "half-year by half-year"],
  12: ["year", "year by year"],
  24: ["two years", "two years at a time"],
};

let c = null;
// How many positions the chart shows: the slider at its top right (to 20; Visual tweaks' tune.rankMax goes to 40,
// the thumb resting at the end). With "Everyone else" off, the chart is only the key's artists, so the positions are
// locked to them (the slider, disabled, glides to that number and back to the reader's own when it's on)
const maxInput = $("rank-max"), otherInput = $("rank-other");
let maxTo = tune.rankMax, maxShown = maxTo, maxGlide = 0, dragAt = -Infinity;
const positions = () => maxTo;
const paintMax = () => {
  maxInput.value = maxShown;
  maxInput.style.setProperty("--p", (+maxInput.value - maxInput.min) / (maxInput.max - maxInput.min));
  $("rank-max-out").textContent = Math.round(maxShown);
};
paintMax();
// The thumb and its number walk to `to` on the graph's tier, a fractional value with the step lifted
function glideMax(to, ms = MORPH_MS) {
  if (to === maxTo) return;
  maxTo = to;
  cancelAnimationFrame(maxGlide);
  const from = maxShown, total = dur(ms), start = performance.now();
  maxInput.step = "any";
  const tick = (now) => {
    const e = total ? easeInOut(Math.max(0, Math.min(1, (now - start) / total))) : 1;
    maxShown = from + (to - from) * e;
    if (e === 1) maxInput.step = 1;
    paintMax();
    if (e < 1) maxGlide = requestAnimationFrame(tick);
  };
  maxGlide = requestAnimationFrame(tick);
}
// (the redraw comes through the card's tune, a frame later; a drag is a moving input, each morph cut short by the next)
maxInput.addEventListener("input", () => {
  cancelAnimationFrame(maxGlide);
  maxShown = maxTo = Math.round(+maxInput.value);
  dragAt = performance.now();
  paintMax();
  setTune("rankMax", maxTo);
});
// How many months each rank is taken over (the slider beside it, 1, 3 or 6): the months around each slice. Slices of
// half a year or more are ranked on their own, so it's disabled for them
const WINDOWS = [1, 3, 6], winInput = $("rank-window");
let months = WINDOWS[+winInput.value];
const paintWindow = () => {
  winInput.style.setProperty("--p", +winInput.value / 2);
  $("rank-window-out").textContent = `${months} mo`;
};
paintWindow();
winInput.addEventListener("input", () => {
  months = WINDOWS[+winInput.value];
  paintWindow();
  paintRankRace();
});
otherInput.addEventListener("change", () => {
  maxInput.disabled = !otherInput.checked;
  paintRankRace();
});
// What the last paint drew: { names, leaving, rows, labels, colors, MAX, t, unit, around: the months ranked over (0 for
// a slice alone), hovered, col, k0: rows[0]'s key, span,
// segs: the periods drawn, [first key, last key] each (two while sliding), view: the keys the axis shows, [lo, hi],
// iv: the slices between labels, slide: whether it's sliding }
let st = null;
let dropTimer = 0; // drops the lines that faded out

function chart(el) {
  if (!c || c.isDisposed() || c.getDom() !== el) {
    c?.dispose();
    c = echarts.init(el, null, { renderer: "canvas" });
    new ResizeObserver(() => {
      if (el.clientWidth === c.getWidth() && el.clientHeight === c.getHeight()) return;
      c.resize();
      if (st && !st.slide) st.iv = labelStep(st.labels, st.span);
      paintTimeline();
    }).observe(el);
    // The lines don't take the pointer: scrub picks who it's on. A click pins them (one that isn't the chart's joins it)
    c.getZr().on("click", (e) => clickAt(e.offsetX, e.offsetY));
    c.getZr().on("mousemove", (e) => scrub(e.offsetX, e.offsetY));
    c.getZr().on("globalout", () => scrub(null));
    // A pinned column's card takes the pointer: its rows light and pin their artist like the lines
    const tip = el.parentElement.querySelector(".rank-tip");
    const rowOf = (e) => e.target.closest?.(".rank-tip-row");
    tip.addEventListener("mouseover", (e) => { const li = rowOf(e); if (li && colPin != null) hover(li._key); });
    tip.addEventListener("mouseleave", () => { if (colPin != null && !pointer) hover(null); });
    tip.addEventListener("click", (e) => { const li = rowOf(e); if (li && colPin != null) state.mixArgs?.[3]?.toggle(li._key); });
  }
  return c;
}

// Hovering a line lights it here and, when it's one of the chart's artists, everywhere
function hover(name) {
  if (!st || st.hovered === name || st.leaving.has(name)) return;
  if (name == null || st.colors.has(name)) focusArtist($("chart-rolling"), name);
  focusRankRace(name);
}

// What slice `k` of `span` months is called
function labelOf(k, span) {
  const m0 = k * span, y = Math.floor(m0 / 12), m = m0 % 12, yy = String(y).slice(2);
  if (span === 1) return `${MON[m]} ${yy}`;
  if (span === 3) return `Q${m / 3 + 1} ${yy}`;
  if (span === 6) return `H${m / 6 + 1} ${yy}`;
  if (span === 12) return String(y);
  return `${y}–${String(y + 1).slice(2)}`;
}

// The period's ranks: for each slice of `span` months (empty ones too), a Map item -> { r: rank, h: the hours it's
// ranked by (over the `months` around the slice: whole slices either side, and half of the next ones when that's an
// even number of slices). who: the item a play counts for (null for none). k0: the first slice's key
function ranksOf(plays, span, months, who = (p) => p.artist) {
  const keyOf = (t) => { const d = new Date(t); return Math.floor((d.getFullYear() * 12 + d.getMonth()) / span); };
  const buckets = new Map();
  for (const p of plays) {
    const k = keyOf(p.t);
    if (!buckets.has(k)) buckets.set(k, new Map());
    const m = buckets.get(k);
    const a = who(p);
    if (a != null) m.set(a, (m.get(a) ?? 0) + p.ms / HOUR);
  }
  const keys = [];
  if (plays.length) for (let k = keyOf(plays[0].t); k <= keyOf(plays.at(-1).t); k++) keys.push(k);
  const ws = Math.max(1, months / span), reach = Math.ceil((ws - 1) / 2);
  const rows = keys.map((k) => {
    const m = new Map();
    for (let d = -reach; d <= reach; d++) {
      const w = Math.min(1, (ws + 1) / 2 - Math.abs(d));
      for (const [a, h] of buckets.get(k + d) ?? []) m.set(a, (m.get(a) ?? 0) + h * w);
    }
    return new Map([...m].sort((a, b) => b[1] - a[1]).map(([a, h], j) => [a, { r: j + 1, h }]));
  });
  return { rows, labels: keys.map((k) => labelOf(k, span)), k0: keys[0] };
}

// The slices between labels: the fewest that keep them apart, counted from year 0 so they stay put as the chart slides
const LABEL_STEPS = { 1: [1, 2, 3, 4, 6, 12, 24, 48], 3: [1, 2, 4, 8, 16], 6: [1, 2, 4, 8], 12: [1, 2, 5, 10, 20], 24: [1, 2, 5, 10] };
const LABEL_FONT = "12px Inter, sans-serif", DATE_FONT = "500 11px Inter, sans-serif";
function labelStep(labels, span) {
  measure ??= document.createElement("canvas").getContext("2d");
  measure.font = LABEL_FONT;
  const w = Math.max(...labels.map((l) => measure.measureText(l).width));
  const slice = (c.getWidth() - PLOT_LEFT - 28) / (labels.length - 1);
  return LABEL_STEPS[span].find((s) => s * slice >= w + 12) ?? LABEL_STEPS[span].at(-1);
}

// ms: how long the lines take to morph (CHASE_MS while the slider is dragged)
export function paintRankRace(ms = performance.now() - dragAt < 120 ? CHASE_MS : MORPH_MS) {
  const el = $("chart-rank");
  if (!state.plays || !state.range || putOff($("rank-card"), () => paintRankRace())) return;
  const t = tokens();
  const plays = rangePlays();
  const span = agg.monthSpan(plays, tune.maxBars + 1);
  // Hidden artists aren't ranked, so the rest close up. With Everyone else off: only the key's shown artists, ranked
  // among themselves
  const hidden = new Set(state.hidden);
  const other = otherInput.checked;
  const keyed = (state.mixArgs?.[0] ?? []).filter((a) => state.colorSlots.has(a) && !hidden.has(a));
  const inKey = new Set(keyed);
  glideMax(other ? tune.rankMax : Math.max(1, keyed.length));
  const { rows, labels, k0 } = ranksOf(plays, span, months, other ? (p) => (hidden.has(p.artist) ? null : p.artist) : (p) => (inKey.has(p.artist) ? p.artist : null));
  const [unit, steps] = SPANS[span];
  winInput.disabled = span >= 6;
  const around = months > span ? months : 0;
  $("rank-note").textContent = (other ? `Where everything that reached the top ${positions()} stood, ${steps}` : `Where the key's ${keyed.length} stood among themselves, ${steps}`) +
    (around ? `, ranked over the ${around} months around each ${unit}` : "") + ". Circles are where it was on the chart.";
  // A pan starting at the same slice size: the chart slides there, from what's on screen (the pan's end draws it as
  // usual). A slide whose pan was taken over by one it can't follow lands at once.
  const follow = pan && !pan.done && !pan.e && slid?.pan !== pan && st && c && !c.isDisposed() && st.span === span && rows.length > 1;
  if (slid && slid.pan !== pan && !follow) slideEnd(false);
  if (rows.length < 2) { scrub(null); dropRiders(); paintTimeline(true); c?.clear(); st = null; return; }
  if (follow) return slideStart(rows, labels, k0);
  if (slid) return;

  const MAX = positions();
  const colors = new Map();
  for (const [name, slot] of state.colorSlots) if (state.chartNames?.includes(name)) colors.set(name, t.series[slot]);
  const names = new Set();
  for (const m of rows) for (const [a, e] of m) if (e.r <= MAX && !hidden.has(a)) names.add(a);
  // Lines drawn before and not now stay a while, diving away as they fade (also any still fading from before)
  const fresh = !c || c.isDisposed() || !st;
  const leaving = new Set(fresh ? [] : [...st.names, ...st.leaving].filter((a) => !names.has(a)));
  const k1 = k0 + rows.length - 1;
  const prev = st;
  st = { names: [...names], leaving, rows, labels, colors, MAX, t, unit, around, hovered: st?.hovered ?? null, col: null, k0, span, segs: [[k0, k1]], view: [k0, k1], iv: 1, slide: false };
  // A new period unpins the column: its slices are other months now
  const period = `${state.range.lo}:${state.range.hi}`;
  const unpinned = period !== pinPeriod && colPin != null;
  pinPeriod = period;
  if (unpinned) colPin = pinTop = null;
  // (the column the pointer is over, set before drawing, so a redraw under the pointer doesn't cut its own morph short)
  if (colPin != null && colPin >= rows.length) colPin = null;
  if ((pointer || colPin != null) && c && !c.isDisposed()) st.col = at = colPin ?? colAt(pointer[0]);
  const cc = chart(el);
  st.iv = labelStep(labels, span);
  el.parentElement.dataset.look = tune.rankCursor;
  clearTimeout(dropTimer);
  const before = new Set(fresh ? [] : [...prev.names, ...prev.leaving]);
  if (fresh) cc.setOption(option(), { notMerge: true });
  else morphPoints(() => setOptionFaded(cc, option(ms), { replaceMerge: ["series"] }, dur(ms), (ms === CHASE_MS ? EASE_OUT : EASE_IN_OUT).echarts), dur(ms));
  drawIn(st.names.filter((a) => !before.has(a)));
  paintTimeline();
  // The card and circles follow at once (a pin's color, new ranks)
  if (pointer) draw();
  // (the card and column fade as when the pointer leaves; the morph above already drops the column's look)
  else if (unpinned) {
    el.parentElement.querySelector(".rank-tip").classList.remove("on", "held");
    el.parentElement.querySelector(".rank-cursor").classList.remove("on", "pinned");
    glide(at, 0);
  }
  if (leaving.size) dropTimer = setTimeout(() => {
    st.leaving = new Set();
    cc.setOption({ series: seriesOf() }, { replaceMerge: ["series"] });
  }, dur(MORPH_MS) + 50);
}

// New lines draw in along their length at one speed over MORPH_MS, their circles and name appearing as the stroke
// reaches them. (ECharts sweeps them in from left to right, under which a climb races and a level stretch crawls.)
// The parts under the floor, unseen, take no time.
const drawing = new Map(); // item -> its draw-in's frame
function drawIn(items) {
  const total = dur(MORPH_MS);
  for (const m of c.getModel().getSeries()) {
    if (!items.includes(m.id)) continue;
    const view = c.getViewOfSeriesModel(m), line = view?._polyline;
    if (!line) continue;
    view._lineGroup?.getClipPath()?.stopAnimation(null, true);
    const { L, V, at } = drawPlan(m.getData().mapArray("y", (y) => y));
    const Lt = L.at(-1), Vt = V.at(-1);
    const data = m.getData();
    data.each((i) => {
      const sym = data.getItemGraphicEl(i);
      if (!sym) return;
      const delay = Vt ? (total * V[at[i]]) / Vt : 0;
      sym.stopAnimation(null, true);
      sym.attr({ scaleX: 0, scaleY: 0 });
      sym.animateTo({ scaleX: 1, scaleY: 1 }, { duration: dur(FADE_MS), delay, easing: EASE_OUT.echarts, setToFinal: true });
      const text = sym.getSymbolPath?.().getTextContent();
      if (text) {
        text.stopAnimation(null, true);
        text.animateFrom({ style: { opacity: 0 } }, { duration: dur(FADE_MS), delay, easing: EASE_OUT.echarts });
      }
    });
    // (how much of the stroke shows once u of the seen length is drawn)
    const percent = (u) => {
      if (!Vt || !Lt) return 1;
      const v = u * Vt;
      let j = 1;
      while (j < V.length - 1 && V[j] < v) j++;
      const f = V[j] > V[j - 1] ? (v - V[j - 1]) / (V[j] - V[j - 1]) : 1;
      return (L[j - 1] + (L[j] - L[j - 1]) * f) / Lt;
    };
    cancelAnimationFrame(drawing.get(m.id));
    line.setStyle({ strokePercent: total ? 0 : 1 });
    if (!total) continue;
    const start = performance.now();
    const tick = (now) => {
      const u = Math.max(0, Math.min(1, (now - start) / total));
      line.setStyle({ strokePercent: u < 1 ? percent(u) : 1 });
      if (u < 1) drawing.set(m.id, requestAnimationFrame(tick));
      else drawing.delete(m.id);
    };
    drawing.set(m.id, requestAnimationFrame(tick));
  }
}
// A line's length as drawn, sampled along its curves (as lineY has them): L, the length to each sample, V, the part of
// it above the floor, and at, each point's sample
function drawPlan(ys) {
  const n = ys.length, top = plotTop(), H = c.getHeight() - PLOT_BOTTOM - top, floor = top + H;
  const [lo, hi] = st.view, per = (c.getWidth() - PLOT_LEFT - 28) / Math.max(1, hi - lo);
  const px = (i) => PLOT_LEFT + (i + st.k0 - lo) * per, py = (v) => top + ((v - 1) / (st.MAX + 0.4 - 1)) * H;
  const L = [0], V = [0], at = [0];
  let x = px(0), y = py(ys[0]);
  for (let i = 0; i + 1 < n; i++) {
    const x0 = px(i), x3 = px(i + 1), y0 = py(ys[i]), y3 = py(ys[i + 1]);
    const x1 = i === 0 ? x0 : x0 + SMOOTH * per, x2 = i + 1 === n - 1 ? x3 : x3 - SMOOTH * per;
    for (let s = 1; s <= 16; s++) {
      const t = s / 16, u = 1 - t;
      const nx = u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3, ny = (u ** 3 + 3 * u * u * t) * y0 + (3 * u * t * t + t ** 3) * y3;
      const d = Math.hypot(nx - x, ny - y);
      L.push(L.at(-1) + d);
      V.push(V.at(-1) + (Math.max(y, ny) <= floor ? d : 0));
      x = nx;
      y = ny;
    }
    at.push(L.length - 1);
  }
  return { L, V, at };
}

const yOf = (m, a, MAX) => {
  const e = m.get(a);
  if (e && e.r <= MAX) return e.r;
  return MAX + tune.rankDive * Math.log2((e ? e.r : m.size + 50) - MAX + 1);
};

// Room above #1 for a name over its circle
const headroom = () => Math.ceil(tune.rankDot / 2 + 8 + tune.rankText + 2 + 4);
// The lane above #1 ("Timeline"), from LANE_TOP down, is as tall whatever the positions: the height it has when
// LANE_RANKS ranks keep REF_RANKS' spacing (at least the room for #1's names and the word). The ranks spread or
// close up to fill the rest.
const REF_RANKS = 18, LANE_RANKS = 14, LANE_TOP = 6, PLOT_TOP = 30, PLOT_BOTTOM = 30, PLOT_LEFT = 64;
function plotTop() {
  const H = $("chart-rank").clientHeight || 472;
  const per = (H - PLOT_TOP - PLOT_BOTTOM) / (REF_RANKS + 0.4 - 1);
  const lane = H - PLOT_TOP - PLOT_BOTTOM - per * (LANE_RANKS + 0.4 - 1);
  return PLOT_TOP + Math.max(lane, headroom() + 20 + TL_LABEL - PLOT_TOP);
}
const TL_LABEL = 14; // room over the timeline for its stops' dates
const laneY = () => (LANE_TOP + TL_LABEL + plotTop() - headroom()) / 2; // (the timeline's height)

// The chart's pinned items that are drawn
const pinnedSet = () => new Set(state.pinned.filter((n) => st.names.includes(n)));

// How much a lit item's circles and line thicken: a hover lightly, a pin more, a hovered pin most
const GROW = { rest: { dot: 1, line: 1 }, hover: { dot: 1.15, line: 1.2 }, pin: { dot: 1.3, line: 1.45 }, pinHover: { dot: 1.45, line: 1.7 } };

// How an item shows, by the page's lit looks: its color, how much it dims, whether it's lit, its line's opacity and
// its circle's size
function lookOf(a, pinned) {
  const col = st.colors.get(a), gone = st.leaving.has(a);
  const look = litLook(pinned, st.hovered, a);
  const lit = isLitLook(look), pin = isPinLook(look);
  // A hover dims the rest a little, a pin by the whole tweak (hover's share is the page's --fade-dim-hover to --fade-dim)
  const k = gone ? 0 : look === "dim" ? tune.rankDim : look === "dimHover" ? 1 - (1 - tune.rankDim) * 0.6 : 1;
  const lineOp = (col ? 1 : tune.rankGrayOpacity) * k;
  const g = GROW[look] ?? GROW.rest;
  return { col, gone, lit, pin, k, base: col ?? st.t.other, lineOp, size: (col ? tune.rankDot : tune.rankGrayDot) * g.dot, width: g.line };
}
const nameStyle = (L) => ({
  fontSize: L.col ? tune.rankText + 2 : tune.rankText, fontWeight: L.col ? 700 : 500,
  color: L.col ? alpha(L.base, Math.min(1, 0.4 + L.k)) : alpha(st.t.muted, tune.rankGrayText * L.k),
  textBorderColor: alpha(st.t.surface, 0.85), textBorderWidth: L.col ? 3 : 2.5,
});

const SMOOTH = 0.5; // the lines' curve rounding (lineY follows it)

// Where each name goes ({ position, align } for its label): over its circle, never along its own line; near either end
// it runs from the circle toward the chart's middle, so it stays whole. One that would run into a name already
// placed (the best ranks go first) goes under its circle instead. Each period drawn (st.segs[s]) is placed as it is
// at rest.
let measure = null;
function nameSpots(items, s) {
  const { MAX, k0, segs } = st, [ka, kb] = segs[s], n = Math.max(2, kb - ka + 1);
  const H = c.getHeight(), top = plotTop(), row = (H - PLOT_BOTTOM - top) / (MAX + 0.4 - 1);
  const slice = (c.getWidth() - PLOT_LEFT - 28) / (n - 1);
  measure ??= document.createElement("canvas").getContext("2d");
  const placed = [], spots = new Map();
  const hits = (b) => placed.some((p) => b.x0 < p.x1 && p.x0 < b.x1 && b.y0 < p.y1 && p.y0 < b.y1);
  for (const { a, L, ys, named } of items.filter((t) => t.named[s] >= 0).sort((p, q) => p.ys[p.named[s]] - q.ys[q.named[s]])) {
    const ns = nameStyle(L), gap = L.size / 2 + (L.col ? 8 : 6), h = ns.fontSize + 2;
    measure.font = `${ns.fontWeight} ${ns.fontSize}px Inter, sans-serif`;
    const w = measure.measureText(shownName(a)).width + ns.textBorderWidth;
    const i = named[s] - (ka - k0); // (the slice within its period)
    const x = PLOT_LEFT + i * slice, y = top + (ys[named[s]] - 1) * row;
    const align = i < n * 0.15 ? "left" : i > n * 0.85 ? "right" : "center";
    const x0 = align === "left" ? x : align === "right" ? x - w : x - w / 2;
    const over = { x0, x1: x0 + w, y0: y - gap - h, y1: y - gap }, under = { x0, x1: x0 + w, y0: y + gap, y1: y + gap + h };
    const [position, box] = hits(over) && !hits(under) ? ["bottom", under] : ["top", over];
    placed.push(box);
    spots.set(a, { position, align });
  }
  return spots;
}

// ms: how long the circles take to grow or shrink (into the lines, while hovering)
function seriesOf(ms = MORPH_MS) {
  const { names, leaving, rows, MAX, col: at, k0, segs } = st;
  const pinned = pinnedSet();
  const items = [...names, ...leaving].map((a) => {
    const L = lookOf(a, pinned);
    const ys = rows.map((m) => yOf(m, a, MAX));
    // The best (lowest) rank in each period, earliest: where the name goes, for the chart's and pinned artists.
    // Hovering, one on the chart in the hovered column is named there instead, over its riding circle
    const named = segs.map(([ka, kb]) => {
      let best = -1;
      if (!L.gone && (L.col || pinned.has(a)) && !(at != null && ys[at] <= MAX))
        for (let i = ka - k0; i <= kb - k0; i++) if (ys[i] <= MAX && (best < 0 || ys[i] < ys[best])) best = i;
      return best;
    });
    return { a, L, ys, named };
  });
  const spots = segs.map((_, s) => nameSpots(items, s));
  return items.map(({ a, L, ys, named }) => {
    const data = ys.map((y, i) => {
      const d = { value: [i, y], symbol: y <= MAX ? "circle" : "none" };
      if (at != null) d.symbolSize = 0;
      const s = named.indexOf(i);
      if (s >= 0) d.label = { show: true, formatter: shownName(a), distance: L.col ? 8 : 6, ...spots[s].get(a), ...nameStyle(L) };
      return d;
    });
    return {
      // (sliding, the plot's edge is clipSeries's, which cuts circles and names rather than dropping them)
      id: a, name: a, type: "line", smooth: SMOOTH, smoothMonotone: "x", clip: !st.slide, z: L.col ? (L.lit ? 6 : 4) : L.lit ? 5 : 2,
      symbol: "circle", symbolSize: L.size, showSymbol: true,
      silent: true,
      data, animationDurationUpdate: dur(ms),
      lineStyle: { width: (L.col ? tune.rankWidth : tune.rankGrayWidth) * L.width, color: L.base, opacity: L.lineOp },
      itemStyle: { color: L.base, opacity: Math.min(1, L.lineOp + (L.gone ? 0 : 0.3)), borderColor: L.pin ? st.t.primary : st.t.surface, borderWidth: L.pin ? 2 : L.col ? 1.5 : 1 },
      emphasis: { disabled: true },
    };
  });
}

// animate: false draws it at once (a slide's start and end): still animated, but in no time, so ECharts keeps where
// each name was (with animation off it forgets, and the next morph fades every name in from nothing)
function option(ms = MORPH_MS, animate = true) {
  const { MAX, t, view, k0 } = st;
  const axis = { axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false }, axisLabel: { color: t.muted } };
  return {
    // (lines appear by drawing in left to right, on the same tier as lines leaving)
    animationDuration: animate ? dur(MORPH_MS) : 0, animationEasing: EASE_IN_OUT.echarts, animationDurationUpdate: animate ? dur(ms) : 0, animationEasingUpdate: (ms === CHASE_MS ? EASE_OUT : EASE_IN_OUT).echarts,
    textStyle: { fontFamily: "inherit", color: t.secondary },
    tooltip: { show: false }, // (the hover draws its own card)
    grid: { top: plotTop(), bottom: PLOT_BOTTOM, left: PLOT_LEFT, right: 28 },
    // (by the slice's place in st.rows, so a period's lines morph point by point into another's; its labels are
    // paintTimeline's, so they slide with it)
    xAxis: { type: "value", min: view[0] - k0, max: view[1] - k0, ...axis, axisLabel: { show: false }, splitLine: { show: false } },
    yAxis: { type: "value", inverse: true, min: 1, max: MAX + 0.4, interval: 1, ...axis, splitLine: { lineStyle: { color: t.grid, opacity: 0.5 } }, axisLabel: { color: t.muted, formatter: (r) => (Number.isInteger(r) && r <= MAX ? "#" + r : "") } },
    series: seriesOf(animate ? ms : 0),
  };
}

// An item lit from anywhere (the key, another graph, a hover here), or null for none
export function focusRankRace(name) {
  if (!st || !c || c.isDisposed()) return;
  if (st.hovered === name) return;
  st.hovered = name;
  if (st.slide) return; // (the slide's end draws it)
  morphPoints(() => setOptionFaded(c, { series: seriesOf(CHASE_MS) }, undefined, dur(FADE_MS)), dur(FADE_MS));
  if (pointer || colPin != null) draw();
}

// ---------- hovering ----------
// The pointer over the plot picks the nearest slice (st.col). In the lane above #1 (the timeline) it lights no one, so the
// column can be swept to watch the race; below, it's always on someone: whoever in the column is nearest it up or
// down. `at` is the slice shown, fractional while gliding to
// it; `shown` is how far the hover's look is in, 0 to 1 (the riders' names; as it leaves, the riders too).
let pointer = null;
let at = 0, shown = 0;
let anim = 0, gliding = false; // the glide's frame
let lastDraw = 0, settle = 0; // the riders' names ease toward being shown or not (see draw)
let riders = null; // item -> { dot, text }: a circle per line, riding it at `at`
let tlRider = null; // the timeline's
const rowEls = new Map(); // item -> its row in the card

const laneFloor = (rect) => rect.y - headroom() - 6; // (the rule under the timeline: #1's names, and a little room over them, count as below)
const inLane = (y, rect) => y < laneFloor(rect);
function scrub(x, y) {
  const rect = x != null && st && !st.slide && c && !c.isDisposed() ? gridRect() : null; // (no hover while sliding)
  if (!rect || x < rect.x - 8 || x > rect.x + rect.width + 8 || y < LANE_TOP || y > rect.y + rect.height) {
    if (c && !c.isDisposed()) c.getZr().setCursorStyle("default");
    if (pointer) leave();
    return;
  }
  c.getZr().setCursorStyle("pointer"); // (everywhere here a click pins: the column on the timeline, an artist below)
  const entering = !pointer;
  pointer = [x, y];
  // A pinned column stays where it is; the pointer still lights whoever in it is nearest
  const k = colPin ?? colAt(x);
  const who = inLane(y, rect) ? null : nearestAt(k, y, rect);
  if (entering && colPin == null) {
    // The circles shrink into the lines while riders take their place in the column (the same size there, so only
    // the names coming in show); the card and column fade in where they are
    st.col = at = k;
    restyle(CHASE_MS);
    glide(k, 1, true);
  } else if (k !== st.col) {
    st.col = k;
    restyle(CHASE_MS);
    glide(k, 1);
  } else draw();
  hover(who);
}

// The series restyled for the hover (circles growing or shrinking over ms)
const restyle = (ms) => morphPoints(() => setOptionFaded(c, { series: seriesOf(ms) }, undefined, dur(ms)), dur(ms));

function leave() {
  pointer = null;
  hover(null);
  if (colPin != null) return draw(); // (a pinned column, its names and card stay)
  const frame = $("chart-rank").parentElement;
  frame.querySelector(".rank-tip").classList.remove("on");
  frame.querySelector(".rank-cursor").classList.remove("on");
  if (!st || !c || c.isDisposed()) return;
  st.col = null;
  restyle(CHASE_MS);
  glide(at, 0);
}

// A click on the timeline pins the column there (a ring marks it on the timeline, a border on the column): it, its
// names and the card stay put, even once the pointer leaves, until the same click unpins it. Below, a click pins the
// lit artist.
let colPin = null, pinTop = null, pinPeriod = null;
function clickAt(x, y) {
  if (!st || !pointer) return;
  const rect = gridRect();
  if (!inLane(y, rect)) {
    // (whoever's nearest, not st.hovered: a pin's re-render can clear the hover, and a second click must unpin)
    const who = nearestAt(colPin ?? colAt(x), y, rect) ?? st.hovered;
    if (who != null) state.mixArgs?.[3]?.toggle(who);
    return;
  }
  const k = colAt(x);
  if (colPin === k) {
    colPin = null;
    return scrub(x, y); // (and it follows the pointer again)
  }
  colPin = k;
  pinTop = null;
  if (k !== st.col) {
    st.col = k;
    restyle(CHASE_MS);
    glide(k, 1);
  } else draw();
}

// ECharts swaps a line's circles' sizes, colors and names at once: grow and shrink the circles and fade their colors
// over ms instead, from what's on screen, fade in the names that appear, and fade out a copy of each that goes, where
// it was
const lookStyle = (el) => ({ fill: el.style.fill, stroke: el.style.stroke, opacity: el.style.opacity ?? 1, lineWidth: el.style.lineWidth });
function morphPoints(apply, ms) {
  const points = () => {
    const out = new Map();
    for (const m of c.getModel()?.getSeries() ?? []) {
      const data = m.getData();
      for (let i = 0; i < data.count(); i++) {
        const el = data.getItemGraphicEl(i)?.childAt?.(0);
        if (el) out.set(`${m.id}:${i}`, el);
      }
    }
    return out;
  };
  const shownText = (el) => { const t = el.getTextContent?.(); return !!t && !t.ignore && !t.invisible; };
  const before = new Map();
  for (const [k, el] of points()) {
    el.stopAnimation("size");
    el.stopAnimation("look");
    const named = shownText(el), t = el.getTextContent();
    // (the name's alignment ECharts keeps among its defaults: without it, the copy would drop by its own height)
    const def = t?._defaultStyle;
    before.set(k, { sx: el.scaleX, sy: el.scaleY, look: lookStyle(el), named, name: named && { style: { ...t.style, align: t.style.align ?? def?.align, verticalAlign: t.style.verticalAlign ?? def?.verticalAlign }, m: t.getComputedTransform()?.slice() } });
  }
  apply();
  if (!ms) return;
  const after = points(), zr = c.getZr();
  for (const [k, b] of before) {
    if (!b.name || (after.has(k) && shownText(after.get(k)))) continue;
    const ghost = new echarts.graphic.Text({ silent: true, z: 20, style: b.name.style });
    if (b.name.m) ghost.setLocalTransform(b.name.m);
    zr.add(ghost);
    ghost.animateTo({ style: { opacity: 0 } }, { duration: ms, easing: EASE_OUT.echarts, done: () => zr.remove(ghost) });
  }
  for (const [k, el] of after) {
    const b = before.get(k);
    if (!b) continue;
    const sx = el.scaleX, sy = el.scaleY;
    if (sx !== b.sx || sy !== b.sy) {
      el.attr({ scaleX: b.sx, scaleY: b.sy });
      el.animateTo({ scaleX: sx, scaleY: sy }, { duration: ms, easing: EASE_OUT.echarts, scope: "size" });
    }
    // (its color and how much it shows fade with the line's, which setOptionFaded fades)
    const look = lookStyle(el);
    if (Object.keys(look).some((p) => look[p] !== b.look[p])) {
      el.setStyle(b.look);
      el.animateTo({ style: look }, { duration: ms, easing: EASE_OUT.echarts, scope: "look" });
    }
    // (a name new to ECharts it fades in itself, from 0: left to it, rather than faded to that 0)
    const t = el.getTextContent();
    if (shownText(el) && !b.named && !t.animators.length) {
      const o = t.style.opacity ?? 1;
      t.setStyle({ opacity: 0 });
      t.animateTo({ style: { opacity: o } }, { duration: ms, easing: EASE_OUT.echarts });
    }
  }
}

// One tick moves everything the hover moves: the column, the riders along their lines, the card and its rows. An
// interruption carries on from where they are.
function glide(to, toShown, jump = false) {
  cancelAnimationFrame(anim);
  const from = jump ? to : at, fromShown = shown, ms = dur(CHASE_MS), start = performance.now();
  gliding = true;
  const tick = (now) => {
    // (a frame's time can be a little before the glide began: never ease outside 0..1, which would put `at` off the chart)
    const e = ms ? easeOut(Math.max(0, Math.min(1, (now - start) / ms))) : 1;
    at = from + (to - from) * e;
    shown = fromShown + (toShown - fromShown) * e;
    draw();
    if (e < 1) anim = requestAnimationFrame(tick);
    else {
      gliding = false;
      if (!shown) dropRiders();
    }
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

// The ring over the pinned column's dot on the timeline (x null for none), fading in and out
let ring = null;
function ringAt(x, y) {
  const zr = c.getZr();
  if (x == null) {
    if (ring) { const r = ring; r.animateTo({ style: { opacity: 0 } }, { duration: dur(FADE_MS), easing: EASE_OUT.echarts, done: () => zr.remove(r) }); }
    ring = null;
    return;
  }
  if (!ring) {
    ring = new echarts.graphic.Circle({ silent: true, z: 4, style: { fill: "none", stroke: st.t.primary, lineWidth: 1.5, opacity: 0 } });
    zr.add(ring);
    ring.animateTo({ style: { opacity: 1 } }, { duration: dur(FADE_MS), easing: EASE_OUT.echarts });
  }
  ring.attr({ shape: { cx: x, cy: y, r: TL_END_R + 3.5 } });
}

function dropRiders() {
  if (riders && c && !c.isDisposed()) for (const { dot, text } of riders.values()) { c.getZr().remove(dot); c.getZr().remove(text); }
  if (tlRider && c && !c.isDisposed()) c.getZr().remove(tlRider);
  riders = tlRider = null;
}

// ---------- the timeline ----------
// The lane above #1: a line with a dot at each slice, bigger at its two ends, dated over the dots the x-axis labels. Hovering, a bright one rides it with the
// column, over the dots, swelling to cover an end's as it gets there (see draw). Drawn again only when its slices or
// place change, the old fading out as the new fades in. A thin rule under it, over #1's names, is where hovering
// starts lighting artists (inLane). The x axis's labels are drawn here too, under the plot, so they slide with it.
const TL_R = 3.5, TL_END_R = 6, TL_RIDER_R = 4.5;
let tl = null; // { key, root, els }: root holds them all; each slice's element knows its key (_k)
// now: at once, no fade (a slide's start and end, which look the same as what they replace)
function paintTimeline(drop = false, now = false) {
  if (!c || c.isDisposed() || st?.slide) return; // (a slide moves its own: placeTimeline)
  const zr = c.getZr();
  const fade = (e, to, done) => e.animateTo({ style: { opacity: to } }, { duration: dur(MORPH_MS), easing: EASE_IN_OUT.echarts, done });
  const old = tl;
  const drop0 = () => { if (!old) return; if (now) zr.remove(old.root); else old.els.forEach((e, i) => fade(e, 0, i ? undefined : () => zr.remove(old.root))); };
  if (drop || !st) {
    drop0();
    tl = null;
    return;
  }
  const rect = gridRect();
  const key = [tune.rankLane, st.MAX, st.k0, st.rows.length, st.iv, rect.x, rect.y, rect.width, rect.height, laneY(), c.getWidth()].join();
  if (old?.key === key) return;
  drop0();
  tl = { key, ...timelineEls(rect) };
  placeTimeline();
  zr.add(tl.root);
  if (!now) for (const e of tl.els) { e.style.opacity = 0; fade(e, 1); }
}

// Where the framed strip starts: a little left of the ranks' labels (the widest's width and 8px past the axis's own
// 8px gap), or further out if the column at the first slice needs the room. It runs to the chart's right edge.
const stripLeft = (rect) => {
  const hug = rect.x - 16 - textWidth(`#${st.MAX}`, "12px Inter, sans-serif"), half = rect.width / Math.max(1, st.view[1] - st.view[0]) / 2;
  return Math.max(0, Math.floor(Math.min(hug, rect.x - half)));
};

// The timeline's elements for st's slices (dots big at each period's ends), with its labels and the x axis's at
// every st.iv'th key, in a group clipped a little past the plot's ends (a label's half, a dot) so they leave it cut
const textWidth = (text, font) => { measure ??= document.createElement("canvas").getContext("2d"); measure.font = font; return measure.measureText(text).width; };
function timelineEls(rect) {
  const { rows, labels, k0, iv, segs, t } = st, y = laneY(), floor = rect.y + rect.height, H = c.getHeight();
  const { Group, Line, Circle, Text, Rect } = echarts.graphic;
  const clipped = (pad) => {
    const g = new Group();
    g.setClipPath(new Rect({ shape: { x: rect.x - pad, y: 0, width: rect.width + 2 * pad, height: H } }));
    return g;
  };
  // The look, by the "The timeline" tweak: 0 dots on a line, 1 the lane shaded, 2 a ruler's ticks, 3 a thick track with
  // holes for dots, 4 dots alone over a dashed rule, 5 the lane framed across the card
  const look = tune.rankLane, ry = Math.round(laneFloor(rect)) + 0.5;
  const ends = new Set(segs.flat());
  const dots = rows.map((_, i) => {
    const end = ends.has(k0 + i);
    if (look === 2) {
      const h = end ? 14 : 8;
      return Object.assign(new Rect({ silent: true, z: 2, shape: { y: y - h / 2, width: end ? 2 : 1.5, height: h, r: 1 }, style: { fill: end ? t.secondary : t.muted } }), { _k: k0 + i });
    }
    const r = look === 3 ? (end ? 3.5 : 2) : end ? TL_END_R : TL_R;
    return Object.assign(new Circle({ silent: true, z: 2, shape: { cy: y, r }, style: { fill: look === 3 ? t.surface : t.muted } }), { _k: k0 + i });
  });
  const texts = [];
  let half = 0;
  rows.forEach((_, i) => {
    if ((k0 + i) % iv) return;
    half = Math.max(half, textWidth(labels[i], LABEL_FONT) / 2, textWidth(labels[i], DATE_FONT) / 2);
    texts.push(
      Object.assign(new Text({ silent: true, z: 2, style: { text: labels[i], y: y - TL_END_R - 3, align: "center", verticalAlign: "bottom", fill: t.muted, font: DATE_FONT } }), { _k: k0 + i, _top: true }),
      Object.assign(new Text({ silent: true, z: 2, style: { text: labels[i], y: floor + 8, align: "center", verticalAlign: "top", fill: t.muted, font: LABEL_FONT } }), { _k: k0 + i }),
    );
  });
  const track = look === 3 ? { stroke: alpha(t.primary, 0.16), lineWidth: 9, lineCap: "round" } : look === 4 ? { stroke: "transparent", lineWidth: 0 } : { stroke: t.axis, lineWidth: look === 2 ? 1 : 1.5 };
  const line = new Line({ silent: true, z: 1, shape: { x1: rect.x, y1: y, x2: rect.x + rect.width, y2: y }, style: track });
  // (the framed strip's is its lower edge)
  const strip = look === 5, sx = stripLeft(rect);
  const rule = new Line({ silent: true, z: 1, shape: { x1: strip ? sx : 8, y1: ry, x2: c.getWidth() - (strip ? 0 : 8), y2: ry },
    style: { stroke: strip ? t.grid : t.axis, lineWidth: 1, lineDash: look === 4 ? [3, 4] : null, opacity: look === 1 ? 0 : 1 } });
  const extra = [];
  // A soft wash over the lane, around the line and its dates
  if (look === 1) extra.push(new Rect({ silent: true, z: 0, shape: { x: rect.x - 12, y: 0, width: rect.width + 24, height: ry - 4, r: 10 }, style: { fill: alpha(t.primary, 0.05) } }));
  // A strip across the card, from the top to the rule, its top corners rounded
  if (strip) extra.push(new Rect({ silent: true, z: 0, shape: { x: sx, y: 0, width: c.getWidth() - sx, height: ry, r: [8, 8, 0, 0] }, style: { fill: alpha(t.primary, 0.03) } }));
  const root = new Group(), dotG = clipped(TL_END_R + 1), textG = clipped(Math.ceil(half) + 1);
  dots.forEach((e) => dotG.add(e));
  texts.forEach((e) => textG.add(e));
  [...extra, line, rule, dotG, textG].forEach((e) => root.add(e));
  return { root, els: [...extra, line, rule, ...dots, ...texts] };
}
// Places the timeline's slices for the keys the axis shows (st.view). Sliding, a label fades as it passes either end,
// gone half a slice past it, so what's past the ends is never seen at rest
function placeTimeline() {
  const rect = gridRect(), [lo, hi] = st.view, per = rect.width / (hi - lo);
  for (const e of tl.els) {
    if (e._k == null) continue;
    const x = rect.x + (e._k - lo) * per;
    if (e.type === "circle") e.attr({ shape: { cx: x } });
    else if (e.type === "rect") e.attr({ shape: { x: x - e.shape.width / 2 } });
    else {
      // (in the framed strip, the dates at its ends stay whole inside it)
      const half = e._top && tune.rankLane === 5 ? e.getBoundingRect().width / 2 + 4 : 0;
      const tx = half ? Math.max(stripLeft(rect) + half, Math.min(c.getWidth() - half, x)) : x;
      e.attr({ style: st.slide ? { x: tx, opacity: Math.max(0, 1 - 2 * Math.max(0, lo - e._k, e._k - hi)) } : { x: tx } });
    }
  }
}

// ---------- sliding with a pan ----------
// A pan (state.js) to a period of the same slice size slides the chart there: the slices on screen and the new
// period's (ranked on its own, so each end looks as it does at rest; where the two overlap, the new one's) are drawn
// once with the lines of both, in the colors already drawn, each period named as at rest; each frame then moves the
// axis. Hover is off meanwhile. At the pan's end the new period alone is drawn at once (the same picture), then
// paintRankRace morphs it as usual: lines that left dive away, names move to their new best points, colors change.
let slid = null; // { pan, from: the view it slid from, to: the new period's view, rows, labels, k0: the new period's }
onPan((p) => {
  if (slid?.pan !== p) return;
  if (p.done) return slideEnd(true);
  if (!st || !c || c.isDisposed()) return;
  // (each end of the axis travels as that end of the pan's range does)
  const u = (a, b, x) => (b !== a ? (x - a) / (b - a) : p.e);
  const { from, to } = slid;
  st.view = [from[0] + (to[0] - from[0]) * u(p.from.lo, p.to.lo, p.at.lo), from[1] + (to[1] - from[1]) * u(p.from.hi, p.to.hi, p.at.hi)];
  moveSeries();
  placeTimeline();
});

// Moves the lines drawn for the keys slid.laid to show st.view: shifted, and stretched by s with their circles and
// names kept round (the line's width stretches with it, unseen within the 3% it's allowed before they're laid out
// again for the view, as at the slide's end)
function moveSeries() {
  const [lo, hi] = st.view, [a, b] = slid.laid, rect = gridRect();
  let s = (b - a) / (hi - lo);
  if (Math.abs(s - 1) > 0.03) {
    transformSeries(1, 0, rect);
    c.setOption({ xAxis: { min: lo - st.k0, max: hi - st.k0 } }, { lazyUpdate: false });
    clipSeries(rect);
    slid.laid = [lo, hi];
    return;
  }
  transformSeries(s, (a - lo) * (rect.width / (hi - lo)), rect);
}
function transformSeries(s, dx, rect) {
  for (const m of c.getModel().getSeries())
    for (const g of c.getViewOfSeriesModel(m)?.group.children() ?? []) {
      g.attr({ x: dx, scaleX: s, originX: rect.x });
      for (const sym of g.isGroup ? g.children() : []) if (sym.isGroup) sym.attr({ scaleX: 1 / s });
    }
}

function slideStart(rows, labels, k0) {
  const k1 = k0 + rows.length - 1, end = st.k0 + st.rows.length - 1;
  const lo = Math.min(k0, st.k0), hi = Math.max(k1, end);
  const all = [], allLabels = [];
  for (let k = lo; k <= hi; k++) {
    all.push(k >= k0 && k <= k1 ? rows[k - k0] : k >= st.k0 && k <= end ? st.rows[k - st.k0] : new Map());
    allLabels.push(labelOf(k, st.span));
  }
  const hidden = new Set(state.hidden), names = new Set(st.names);
  for (const m of rows) for (const [a, e] of m) if (e.r <= st.MAX && !hidden.has(a)) names.add(a);
  // The hover goes (a new period unpins the column too)
  cancelAnimationFrame(anim);
  gliding = false;
  shown = 0;
  const pointed = pointer;
  pointer = colPin = pinTop = null;
  ringAt(null);
  dropRiders();
  const frame = $("chart-rank").parentElement;
  frame.querySelector(".rank-tip").classList.remove("on", "held");
  frame.querySelector(".rank-cursor").classList.remove("on", "pinned");
  clearTimeout(dropTimer);
  slid = { pan, from: [...st.view], laid: [...st.view], to: [k0, k1], rows, labels, k0 };
  st = { ...st, rows: all, labels: allLabels, k0: lo, names: [...names], leaving: new Set(), col: null, slide: true,
    segs: [...st.segs.filter(([a, b]) => b < k0 || a > k1), [k0, k1]] };
  if (pointed) hover(null); // (here it only takes note: the slide's end draws it)
  c.setOption(option(MORPH_MS, false), { replaceMerge: ["series"] });
  clipSeries(gridRect());
  if (tl) c.getZr().remove(tl.root);
  tl = { key: null, ...timelineEls(gridRect()) };
  placeTimeline();
  c.getZr().add(tl.root);
}

// Sliding, each line's group is clipped a circle's width past the plot's ends (none to clear it). ECharts' own clip
// of the line, which would move with it (moveSeries), goes; each layout puts it back.
function clipSeries(rect) {
  const pad = Math.max(tune.rankDot, tune.rankGrayDot) * 0.625 + 1.5; // (a lit circle's radius and its border)
  for (const m of c.getModel().getSeries()) {
    const g = c.getViewOfSeriesModel(m)?.group;
    if (!g) continue;
    if (!rect) { g.removeClipPath(); continue; }
    g.setClipPath(new echarts.graphic.Rect({ shape: { x: rect.x - pad, y: 0, width: rect.width + 2 * pad, height: rect.y + rect.height } }));
    for (const part of g.children()) part.removeClipPath();
  }
}

// The new period alone, at once; paint: then morph it as usual
function slideEnd(paint) {
  const { rows, labels, k0 } = slid;
  slid = null;
  if (!st || !c || c.isDisposed()) return;
  const k1 = k0 + rows.length - 1;
  st = { ...st, rows, labels, k0, segs: [[k0, k1]], view: [k0, k1], slide: false };
  transformSeries(1, 0, gridRect());
  clipSeries(null);
  c.setOption(option(MORPH_MS, false), { replaceMerge: ["series"] });
  paintTimeline(false, true);
  if (paint) paintRankRace();
}

// Draws the hover at `at` and `shown`
function draw() {
  if (!st || !c || c.isDisposed()) return;
  const el = $("chart-rank"), frame = el.parentElement, tip = frame.querySelector(".rank-tip"), cursor = frame.querySelector(".rank-cursor");
  const rect = gridRect(), { rows, labels, colors, MAX, unit, around, hovered, names } = st;
  const n = rows.length, slice = rect.width / (n - 1), x = rect.x + at * slice;
  const pinned = pinnedSet();
  const floor = rect.y + rect.height;
  const now = performance.now(), fade = dur(FADE_MS);
  const ease = fade ? 1 - Math.exp(-Math.min(now - lastDraw, 34) / (fade / 3)) : 1;
  lastDraw = now;
  let unsettled = false;

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
    const out = pointer || colPin != null ? 1 : shown; // (leaving, they fade with the rest)
    r.dot.attr({ shape: { cx: x, cy: y, r: L.size / 2 }, style: { fill: L.base, stroke: L.pin ? st.t.primary : st.t.surface, lineWidth: L.pin ? 2 : L.col ? 1.5 : 1, opacity: Math.min(1, L.lineOp + 0.3) * out }, z: L.col ? (L.lit ? 13 : 12) : L.lit ? 12 : 10 });
    const named = L.col || pinned.has(a) || a === hovered;
    // (a name eases in or out over FADE_MS rather than switching, e.g. a gray one as it's lit)
    r.nm = r.nm == null ? +named : r.nm + (+named - r.nm) * ease;
    if (Math.abs(+named - r.nm) < 0.01) r.nm = +named;
    else unsettled = true;
    const depth = Math.max(0, Math.min(1, (floor + 4 - y) / 16));
    const ns = nameStyle(L);
    r.text.attr({
      style: { text: shownName(a), x, y: y - L.size / 2 - (L.col ? 8 : 6), align: "center", verticalAlign: "bottom", font: `${ns.fontWeight} ${ns.fontSize}px Inter, sans-serif`, fill: ns.color, stroke: ns.textBorderColor, lineWidth: ns.textBorderWidth, opacity: r.nm * shown * depth },
      z: L.col ? 15 : 14,
    });
    // (a name at either end stays whole inside the chart and the framed strip's left edge, as if aligned to it; measured
    // rather than read from the text, whose bounds can lag its new style)
    {
      const half = (textWidth(shownName(a), r.text.style.font) + ns.textBorderWidth) / 2 + 2, W = c.getWidth();
      const lo = tune.rankLane === 5 ? stripLeft(rect) : 0;
      r.text.attr({ style: { x: Math.max(lo + half, Math.min(W - half, x)) } });
    }
  }
  if (!tlRider) {
    tlRider = new echarts.graphic.Circle({ silent: true, z: 3 });
    zr.add(tlRider);
  }
  // (within a slice of either end it swells to cover the end's bigger dot, so the two merge)
  const toEnd = Math.max(0, 1 - Math.min(at, n - 1 - at));
  tlRider.attr({ shape: { cx: x, cy: laneY(), r: TL_RIDER_R + (TL_END_R + 0.5 - TL_RIDER_R) * toEnd }, style: { fill: st.t.primary, opacity: pointer || colPin != null ? 1 : shown } });
  ringAt(colPin == null ? null : rect.x + colPin * slice, laneY());
  if (unsettled && !gliding && !settle) settle = requestAnimationFrame(() => { settle = 0; draw(); });

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
        li._key = a;
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
  head.replaceChildren(labels[Math.round(at)], Object.assign(document.createElement("small"), { textContent: `hours ${around ? `over the ${around} months around it` : `that ${unit}`}` }));
  if (!pointer && colPin == null) return; // (leaving: the card and column fade where they are)

  // The card beside the column, clear of its names, to its left where there's room
  const ox = el.offsetLeft, oy = el.offsetTop, w = tip.offsetWidth, ht = tip.offsetHeight, W = frame.clientWidth;
  const cx = ox + x;
  const left = cx - slice / 2 - w - 8 >= 0 ? cx - slice / 2 - w - 8 : Math.min(cx + slice / 2 + 8, W - w);
  // (beside the pointer, or where it was when the column was pinned; always under the timeline's rule, so its stops
  // and dates stay in sight on either side of the column)
  const under = oy + laneFloor(rect) + 6;
  let top = Math.max(under, Math.min(frame.clientHeight - ht, oy + (pointer?.[1] ?? 0) - ht / 2));
  if (colPin != null) top = pinTop ??= pointer ? top : under;
  tip.style.transform = `translate(${left}px, ${top}px)`;
  tip.classList.add("on");
  tip.classList.toggle("held", colPin != null);
  // The column is at the slice (gliding with the rest), reaching up over #1's name; a line is at the pointer
  // (a column stays inside the chart, and inside the framed strip: at either end it's cut to fit, and as it nears a
  // side its top rises to the strip's, so touching one it touches both)
  const strip = tune.rankLane === 5, lo = ox + (strip ? stripLeft(rect) : 0), hi = ox + c.getWidth();
  const a = Math.max(cx - slice / 2, lo), b = Math.min(cx + slice / 2, hi);
  const gap = Math.max(0, Math.min(cx - slice / 2 - lo, hi - cx - slice / 2));
  const inset = strip ? LANE_TOP * Math.min(1, gap / LANE_TOP) : LANE_TOP;
  const column = tune.rankCursor === 2 || tune.rankCursor === 3, room = column ? rect.y - inset : 0; // (the column runs up through the lane)
  frame.dataset.look = tune.rankCursor;
  cursor.style.setProperty("--x", `${column ? (a + b) / 2 : !pointer || colPin != null ? cx : ox + pointer[0]}px`);
  cursor.classList.toggle("pinned", colPin != null);
  cursor.style.setProperty("--slice", `${b - a}px`);
  cursor.style.top = `${oy + rect.y - room}px`;
  cursor.style.height = `${rect.height + room}px`;
  cursor.classList.add("on");
}

// "Rank race": where each item stood over the period, as a bump chart. The period is cut into months, or into
// 3 months, 6 months, a year or 2 years as Hours per month does (agg.monthSpan), at most one slice more than its bars.
// Every item that reached the top `tune.rankMax` in the period gets a line; the chart's artists keep their colors
// and the rest are gray, behind them. By the month, a rank is taken over the months around each one, so a phase
// reads as a line rather than dots. Circles sit only where an item is on the chart, and are the data; between them
// a line dives below the floor, the deeper the further down the item really was, and comes back. Every line is
// named at its best point (grays too, over whatever is there). Hovering reads the whole slice, beside the pointer.
// Lines that leave (a new period, a deselected artist) dive away and fade before they're dropped.
// Lit looks follow the page: hover (anywhere) and pins.
import * as agg from "./aggregate.js";
import { FADE_MS, MORPH_MS, EASE_IN_OUT, dur, litLook, isLitLook, setOptionFaded } from "./motion.js";
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
    new ResizeObserver(() => (el.clientWidth !== c.getWidth() || el.clientHeight !== c.getHeight()) && c.resize()).observe(el);
    c.on("mouseover", { seriesType: "line" }, (e) => hover(e.seriesName));
    c.on("mouseout", { seriesType: "line" }, () => hover(null));
    c.on("globalout", () => hover(null));
    c.on("click", { seriesType: "line" }, (e) => {
      if (st.colors.has(e.seriesName)) mixArgs?.[3]?.toggle(e.seriesName);
    });
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
    const m0 = k * span, y = Math.floor(m0 / 12), m = m0 % 12, yy = `’${String(y).slice(2)}`;
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
  if (rows.length < 2) { c?.clear(); st = null; return; }

  const MAX = tune.rankMax;
  const hidden = new Set(state.hidden);
  const colors = new Map();
  for (const [name, slot] of state.colorSlots) if (state.chartNames?.includes(name)) colors.set(name, t.series(slot));
  const names = new Set();
  for (const m of rows) for (const [a, e] of m) if (e.r <= MAX && !hidden.has(a)) names.add(a);
  // Lines drawn before and not now stay a while, diving away as they fade (also any still fading from before)
  const fresh = !c || c.isDisposed() || !st;
  const leaving = new Set(fresh ? [] : [...st.names, ...st.leaving].filter((a) => !names.has(a)));
  st = { names: [...names], leaving, rows, labels, colors, MAX, t, unit, hovered: st?.hovered ?? null };
  const cc = chart(el);
  clearTimeout(dropTimer);
  if (fresh) cc.setOption(option(), { notMerge: true });
  else setOptionFaded(cc, option(), { replaceMerge: ["series"] }, dur(MORPH_MS));
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

// The chart's pinned items that are drawn
const pinnedSet = () => new Set(mixArgs?.[3] ? [...st.colors.keys()].filter((n) => mixArgs[3].has(n)) : []);

function seriesOf() {
  const { names, leaving, rows, colors, MAX, t, hovered } = st;
  const pinned = pinnedSet();
  const n = rows.length;
  return [...names, ...leaving].map((a) => {
    const col = colors.get(a);
    const gone = leaving.has(a);
    const look = litLook(pinned, hovered, a);
    const lit = isLitLook(look), dimmed = look === "dim" || look === "dimHover";
    const k = gone ? 0 : dimmed ? tune.rankDim : 1;
    const base = col ?? t.other;
    const lineOp = (col ? 1 : tune.rankGrayOpacity) * k;
    const ys = rows.map((m) => yOf(m, a, MAX));
    // The best (lowest) rank, earliest: where the name goes
    let best = -1;
    if (!gone) ys.forEach((y, i) => { if (y <= MAX && (best < 0 || y < ys[best])) best = i; });
    const data = ys.map((y, i) => {
      const d = { value: y, symbol: y <= MAX ? "circle" : "none" };
      if (i === best) {
        d.label = {
          show: true, formatter: shownName(a), position: i < n * 0.15 ? "right" : i > n * 0.85 ? "left" : "top", distance: col ? 8 : 6,
          fontSize: col ? tune.rankText + 2 : tune.rankText, fontWeight: col ? 700 : 500,
          color: col ? alpha(base, Math.min(1, 0.4 + k)) : alpha(t.muted, tune.rankGrayText * k),
          textBorderColor: alpha(t.surface, 0.85), textBorderWidth: col ? 3 : 2.5,
        };
      }
      return d;
    });
    const w = (col ? tune.rankWidth : tune.rankGrayWidth) * (lit ? 1.4 : 1);
    return {
      id: a, name: a, type: "line", smooth: 0.5, smoothMonotone: "x", clip: true, z: col ? (lit ? 6 : 4) : lit ? 5 : 2,
      symbol: "circle", symbolSize: (col ? tune.rankDot : tune.rankGrayDot) * (lit ? 1.25 : 1), showSymbol: true,
      triggerLineEvent: true, silent: gone,
      data, animationDurationUpdate: dur(MORPH_MS),
      lineStyle: { width: w, color: base, opacity: lineOp },
      itemStyle: { color: base, opacity: Math.min(1, lineOp + (gone ? 0 : 0.3)), borderColor: t.surface, borderWidth: col ? 1.5 : 1 },
      emphasis: { disabled: true },
    };
  });
}

// Every item on the chart in the hovered slice, by rank: the chart's artists in their colors, pinned ones marked
function sliceTip(params) {
  const i = params[0]?.dataIndex;
  if (!st || i == null) return "";
  const { rows, labels, colors, MAX, t, unit, hovered } = st;
  const pinned = pinnedSet(), hidden = new Set(state.hidden);
  const lines = [];
  for (const [a, e] of rows[i]) {
    if (e.r > MAX) break;
    if (hidden.has(a)) continue;
    const col = colors.get(a);
    const mark = pinned.has(a) ? `background:${alpha(col, 0.22)};box-shadow:inset 0 0 0 1px ${col};` : a === hovered && col ? `background:${alpha(col, 0.12)};` : "";
    lines.push(`<div style="display:flex;gap:8px;padding:0 4px;border-radius:3px;${mark}">` +
      `<span style="width:2.5ch;text-align:right;color:${t.muted}">${e.r}</span>` +
      `<span style="flex:1;${col ? `color:${col};font-weight:600` : ""}">${esc(shownName(a))}</span>` +
      `<span style="color:${t.muted}">${fmtH(e.h)}</span></div>`);
  }
  return `<div style="margin-bottom:4px"><b>${labels[i]}</b> <span style="color:${t.muted}">· hours ${unit === "month" ? "over the 3 months around it" : `that ${unit}`}</span></div>` + lines.join("");
}

// Beside the pointer, to its left where there's room
function tipAt(point, _p, _dom, _rect, size) {
  const [w, h] = size.contentSize, [W, H] = size.viewSize, gap = 16;
  const x = point[0] - w - gap >= 0 ? point[0] - w - gap : Math.min(point[0] + gap, W - w);
  return [x, Math.max(0, Math.min(H - h, point[1] - h / 2))];
}

function option() {
  const { labels, MAX, t } = st;
  const axis = { axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false }, axisLabel: { color: t.muted } };
  return {
    // (lines appear by drawing in left to right, on the same tier as lines leaving)
    animationDuration: dur(MORPH_MS), animationEasing: EASE_IN_OUT.echarts, animationDurationUpdate: dur(MORPH_MS), animationEasingUpdate: EASE_IN_OUT.echarts,
    textStyle: { fontFamily: "inherit", color: t.secondary },
    tooltip: {
      trigger: "axis", position: tipAt, formatter: sliceTip, transitionDuration: 0,
      axisPointer: { type: "line", lineStyle: { color: t.axis }, animation: false },
      backgroundColor: t.surface, borderColor: t.axis, textStyle: { color: t.primary, fontSize: 12 }, extraCssText: "min-width:200px",
    },
    grid: { top: 30, bottom: 30, left: 44, right: 28 }, // (room above #1 for its names)
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
  setOptionFaded(c, { series: seriesOf() }, undefined, dur(FADE_MS));
}

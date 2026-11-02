// "Rank race": where each item stood, month by month (quarter by quarter over long periods), as a bump chart.
// Every item that reached the top `tune.rankMax` in the period gets a line; the chart's artists keep their colors
// and the rest are gray, behind them. A rank is taken over the months around each one, so a phase reads as a line
// rather than dots. Circles sit only where an item is on the chart, and are the data; between them a line dives
// below the floor, the deeper the further down the item really was, and comes back. Every line is named at its best
// point (grays too, over whatever is there). Lit looks follow the page: hover (anywhere) and pins.
import * as agg from "./aggregate.js";
import { FADE_MS, MORPH_MS, ENTER_MS, EASE_IN_OUT, dur, litLook, isLitLook } from "./motion.js";
import { setOptionFaded } from "./motion.js";
import { $, state, putOff, rangePlays, shownName } from "./state.js";
import { tune } from "./tune.js";
import { focusArtist } from "./charts.js";
import { mixArgs } from "./rollingview.js";

const HOUR = 3_600_000;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const fmtH = (h) => (h >= 10 ? Math.round(h) + " h" : h >= 1 ? h.toFixed(1) + " h" : Math.max(1, Math.round(h * 60)) + " min");

function alpha(hex, a) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

let c = null;
let st = null; // what the last paint drew: { names, rows, keys, label, colors, MAX, hovered }

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
    c.on("globalout", () => hover(null));
    c.on("click", { seriesType: "line" }, (e) => {
      if (st.colors.has(e.seriesName)) mixArgs?.[3]?.toggle(e.seriesName);
    });
  }
  return c;
}

// Hovering a line lights it here and, when it's one of the chart's artists, everywhere
function hover(name) {
  if (!st || st.hovered === name) return;
  if (name == null || st.colors.has(name)) focusArtist($("chart-rolling"), name);
  focusRankRace(name);
}

// The month-by-month ranks of the period: for each bucket, a Map item -> { r: rank, h: hours that bucket }
function ranksOf(plays, lo, hi) {
  const quarters = hi - lo > 1100;
  const keyOf = (t) => { const d = new Date(t); return d.getFullYear() * 12 + (quarters ? d.getMonth() - (d.getMonth() % 3) : d.getMonth()); };
  const buckets = new Map();
  for (const p of plays) {
    const k = keyOf(p.t);
    if (!buckets.has(k)) buckets.set(k, new Map());
    const m = buckets.get(k);
    m.set(p.artist, (m.get(p.artist) ?? 0) + p.ms / HOUR);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const reach = quarters ? 0 : 1;
  const rows = keys.map((k, i) => {
    const m = new Map();
    for (const kk of keys.slice(Math.max(0, i - reach), i + reach + 1))
      for (const [a, h] of buckets.get(kk)) m.set(a, (m.get(a) ?? 0) + h);
    return new Map([...m].sort((a, b) => b[1] - a[1]).map(([a, h], j) => [a, { r: j + 1, h: buckets.get(k).get(a) ?? 0 }]));
  });
  const label = (k) => { const y = String(Math.floor(k / 12)).slice(2), m = k % 12; return quarters ? `Q${m / 3 + 1} ’${y}` : `${MON[m]} ’${y}`; };
  return { keys, rows, quarters, labels: keys.map(label) };
}

export function paintRankRace() {
  const el = $("chart-rank");
  if (!state.plays || !state.range || putOff($("rank-card"), () => paintRankRace())) return;
  const t = tokens();
  const { lo, hi } = state.range;
  const { keys, rows, quarters, labels } = ranksOf(rangePlays(), lo, hi);
  $("rank-note").textContent = `Where everything that reached the top ${tune.rankMax} stood, ${quarters ? "quarter by quarter" : "month by month"}, ranked over the ${quarters ? "quarter" : "months around each month"}. Circles are where it was on the chart.`;
  if (keys.length < 2) { c?.clear(); st = null; el.classList.add("empty"); return; }
  el.classList.remove("empty");

  const MAX = tune.rankMax;
  const hidden = new Set(state.hidden);
  const colors = new Map();
  for (const [name, slot] of state.colorSlots) if (state.chartNames?.includes(name)) colors.set(name, t.series(slot));
  const names = new Set();
  for (const m of rows) for (const [a, e] of m) if (e.r <= MAX && !hidden.has(a)) names.add(a);
  // Pinned: those pinned that are drawn
  st = { unit: quarters ? "quarter" : "month", names: [...names], rows, keys, labels, colors, MAX, t, hovered: st?.hovered ?? null, fresh: !c || c.isDisposed() };
  const fresh = st.fresh;
  const cc = chart(el);

  cc.setOption(option(), { replaceMerge: ["series"], notMerge: fresh });
}

const yOf = (m, a, MAX) => {
  const e = m.get(a);
  if (e && e.r <= MAX) return e.r;
  return MAX + tune.rankDive * Math.log2((e ? e.r : m.size + 50) - MAX + 1);
};

// The chart's pinned items that are drawn
const pinnedSet = () => new Set(mixArgs?.[3] ? [...st.colors.keys()].filter((n) => mixArgs[3].has(n)) : []);

function seriesOf() {
  const { names, rows, labels, colors, MAX, t, hovered } = st;
  const pinned = pinnedSet();
  const n = rows.length;
  return names.map((a) => {
    const col = colors.get(a);
    const look = litLook(pinned, hovered, a);
    const lit = isLitLook(look), dimmed = look === "dim" || look === "dimHover";
    const k = dimmed ? tune.rankDim : 1;
    const base = col ?? t.other;
    const lineOp = (col ? 1 : tune.rankGrayOpacity) * k;
    const ys = rows.map((m) => yOf(m, a, MAX));
    // The best (lowest) rank, earliest: where the name goes
    let best = -1;
    ys.forEach((y, i) => { if (y <= MAX && (best < 0 || y < ys[best])) best = i; });
    const data = ys.map((y, i) => {
      const on = y <= MAX;
      const d = { value: y, symbol: on ? "circle" : "none" };
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
      data, animationDurationUpdate: dur(MORPH_MS),
      lineStyle: { width: w, color: base, opacity: lineOp },
      itemStyle: { color: base, opacity: Math.min(1, lineOp + 0.3), borderColor: t.surface, borderWidth: col ? 1.5 : 1 },
      emphasis: { disabled: true },
      tooltip: { show: true },
    };
  });
}

function option() {
  const { rows, labels, MAX, t } = st;
  const axis = { axisLine: { lineStyle: { color: t.axis } }, axisTick: { show: false }, axisLabel: { color: t.muted } };
  return {
    animationDuration: dur(ENTER_MS), animationEasing: "cubicOut", animationDurationUpdate: dur(MORPH_MS), animationEasingUpdate: EASE_IN_OUT.echarts,
    textStyle: { fontFamily: "inherit", color: t.secondary },
    tooltip: {
      trigger: "item", confine: true, backgroundColor: t.surface, borderColor: t.axis, textStyle: { color: t.primary, fontSize: 12 },
      formatter: ({ seriesName, dataIndex }) => {
        const e = st.rows[dataIndex].get(seriesName);
        return `<b>${esc(shownName(seriesName))}</b><br>` + (e && e.r <= st.MAX ? `#${e.r} around ${st.labels[dataIndex]} · ${fmtH(e.h)} that ${st.unit}` : e ? `#${e.r} around ${st.labels[dataIndex]}` : `Not played around ${st.labels[dataIndex]}`);
      },
    },
    grid: { top: 16, bottom: 30, left: 44, right: 28 },
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

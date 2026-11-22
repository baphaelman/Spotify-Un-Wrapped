// The gallery's thumbnails (gallery.js): each graph's own small drawing, made for its tile rather than shrunk from the
// card: no axes, labels only where they fit, everything thickened to fill the frame. They draw from one digest of the
// period's plays, worked out in a single pass per paint, and paint together, coalesced to one a frame. Thumbnails
// get one look and one tier (CHASE_MS, cut short by the next paint): small enough not to need each graph's motion.
//
// THUMBS: card id -> (digest, tokens) => ECharts option. A contributed graph adds its own entry here.

import { state, shownPlays, OTHER } from "./state.js";
import { chart } from "./charts.js";
import { tokens, alpha, mix } from "./colors.js";
import { DAY, HOUR, isSkip } from "./aggregate.js";
import { CHASE_MS, ENTER_MS, dur } from "./motion.js";

const BUCKETS = 40; // time slices across the period
const RASTER_MAX = 1800; // dots in Every play's thumbnail
const STILL = new Set(["clock-card", "raster-card", "calendar-card"]);

// ---------- The digest: one pass over the period's plays ----------
let firstMemo = null; // when each item was first played, over all the loaded plays (Discovery)
function firstDays(off) {
  if (firstMemo?.plays !== state.plays) {
    const m = new Map();
    for (const p of state.plays) if (!m.has(p.artist)) m.set(p.artist, Math.floor((p.t - off) / DAY));
    firstMemo = { plays: state.plays, m };
  }
  return firstMemo.m;
}

let memo = null;
function digest() {
  const artists = (state.mixArgs?.[0] ?? []).filter((n) => n !== OTHER);
  const { lo, hi } = state.range;
  const key = [state.plays?.length, lo, hi, state.dim, state.hidden.join("\u0001"), artists.join("\u0001")].join("|");
  if (memo?.key === key) return memo;
  const plays = shownPlays();
  // local days and hours without a Date per play: the zone's offset, taken once (a DST hour off is fine at this size)
  const off = new Date(plays[0]?.t ?? 0).getTimezoneOffset() * 60000 * -1;
  const days = hi - lo + 1;
  const per = Math.max(1, Math.ceil(days / BUCKETS));
  const nb = Math.ceil(days / per);
  const idx = new Map(artists.map((n, i) => [n, i]));
  const k = artists.length;
  const series = Array.from({ length: k + 1 }, () => new Float64Array(nb)); // per artist (and the rest, last), hours per slice
  const total = new Map(); // every item's hours
  const parts = artists.map(() => new Map()); // each chart artist's albums, hours
  const skip = artists.map(() => [0, 0]); // played through, skipped (plays)
  const clock = new Float64Array(168);
  const daily = new Float64Array(days);
  const raster = [];
  const every = Math.max(1, Math.ceil(plays.length / RASTER_MAX));
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const local = p.t + off;
    const d = Math.floor(local / DAY) - lo;
    if (d < 0 || d >= days) continue;
    const h = p.ms / HOUR;
    const a = idx.get(p.artist) ?? k;
    series[a][Math.floor(d / per)] += h;
    total.set(p.artist, (total.get(p.artist) ?? 0) + h);
    daily[d] += h;
    const hour = Math.floor((local % DAY) / HOUR);
    clock[((d + lo + 3) % 7) * 24 + hour] += h; // day 0 (1 Jan 1970) was a Thursday; Monday first
    if (a < k) {
      const part = state.dim === "artist" ? p.album : p.track;
      if (part) parts[a].set(part, (parts[a].get(part) ?? 0) + h);
      skip[a][isSkip(p) ? 1 : 0] += p.w ?? 1;
    }
    if (i % every === 0) raster.push([d, hour + (local % HOUR) / HOUR, a]);
  }
  const first = firstDays(off);
  const found = new Float64Array(nb);
  for (const [n, f] of first) if (f >= lo && f <= hi && total.has(n)) found[Math.floor((f - lo) / per)]++;
  memo = { key, artists, k, nb, per, lo, days, series, total, parts, skip, clock, daily, raster, found };
  return memo;
}

// ---------- Drawing ----------
const grid0 = { left: 0, right: 0, top: 0, bottom: 0 };
const hide = { show: false };
const axis = (type, o = {}) => ({ type, show: false, ...o });
const colorOf = (t, n) => {
  const s = state.colorSlots?.get(n);
  return s === undefined ? t.other : t.series[s];
};
const r1 = (v) => Math.round(v * 100) / 100;
// Rolling sum over a few slices, so ranks and shares don't flicker slice to slice
const smooth = (a, w = 2) => Array.from(a, (_, i) => {
  let s = 0;
  for (let j = Math.max(0, i - w); j <= Math.min(a.length - 1, i + w); j++) s += a[j];
  return s;
});

export const THUMBS = {
  // The mix bar, thickened to the whole frame: one band per artist, named where it's wide enough
  "mix-card": (d, t, box) => {
    const hrs = d.artists.map((_, i) => d.series[i].reduce((s, v) => s + v, 0));
    const sum = hrs.reduce((s, v) => s + v, 0) || 1;
    return {
      grid: grid0, xAxis: axis("value", { max: 1 }), yAxis: axis("category", { data: [""] }),
      series: d.artists.map((n, i) => {
        const room = (hrs[i] / sum) * box.w - 10; // the name fits its band or isn't shown
        return {
          type: "bar", stack: "a", barWidth: "100%", id: n, name: n, data: [r1(hrs[i] / sum * 100) / 100],
          itemStyle: { color: colorOf(t, n), borderColor: t.surface, borderWidth: 1.5 },
          label: { show: room > 26, position: "insideTopLeft", color: t.surface, fontSize: 11, fontWeight: 600, formatter: n, width: Math.max(0, room), overflow: "truncate" },
        };
      }),
    };
  },
  // Inside your top: the chart's artists, their albums around them
  "sunburst-card": (d, t) => ({
    series: [{
      type: "sunburst", radius: ["14%", "98%"], center: ["50%", "50%"], sort: null, label: hide, nodeClick: false,
      itemStyle: { borderColor: t.surface, borderWidth: 1 },
      levels: [{}, { itemStyle: { opacity: 1 } }, { itemStyle: { opacity: 0.6 } }],
      data: d.artists.map((n, i) => {
        const kids = [...d.parts[i]].sort((a, b) => b[1] - a[1]).slice(0, 6);
        return { name: n, value: r1(d.total.get(n) ?? 0), itemStyle: { color: colorOf(t, n) }, children: kids.map(([p, h]) => ({ name: p, value: r1(h), itemStyle: { color: colorOf(t, n) } })) };
      }),
    }],
  }),
  // All your …: the top of the list, as thick bars with names in them
  "ranking-card": (d, t) => {
    const top = [...d.total].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return {
      grid: grid0, xAxis: axis("value", { max: top[0]?.[1] || 1 }), yAxis: axis("category", { data: top.map((x) => x[0]), inverse: true }),
      series: [{
        type: "bar", barWidth: "78%", data: top.map(([n, h]) => ({ value: r1(h), itemStyle: { color: alpha(colorOf(t, n), 0.85), borderRadius: 2 } })),
        label: { show: true, position: "insideLeft", color: t.primary, fontSize: 10, formatter: (p) => top[p.dataIndex][0], overflow: "truncate", width: 200 },
      }],
    };
  },
  // Top … View: each artist's share among the chart's artists, stacked to the top (the rest left out, as the card does)
  "rolling-card": (d, t) => {
    const sm = d.artists.map((_, i) => smooth(d.series[i]));
    const tot = Array.from({ length: d.nb }, (_, j) => sm.reduce((s, a) => s + a[j], 0) || 1);
    return {
      grid: grid0, xAxis: axis("category", { boundaryGap: false, data: [...Array(d.nb).keys()] }), yAxis: axis("value", { max: 1 }),
      series: d.artists.map((n, i) => ({
        type: "line", stack: "a", id: n, symbol: "none", smooth: 0.4, lineStyle: { width: 0 },
        areaStyle: { color: colorOf(t, n), opacity: 0.9 }, data: sm[i].map((v, j) => r1(v / tot[j] * 100) / 100),
      })),
    };
  },
  // … over time: each artist's running total
  "race-card": (d, t) => ({
    grid: { left: 2, right: 2, top: 4, bottom: 2 }, xAxis: axis("category", { boundaryGap: false, data: [...Array(d.nb).keys()] }), yAxis: axis("value"),
    series: d.artists.map((n, i) => {
      let s = 0;
      return { type: "line", id: n, symbol: "none", smooth: 0.3, lineStyle: { width: 2, color: colorOf(t, n) }, data: Array.from(d.series[i], (v) => r1((s += v))) };
    }),
  }),
  // Rank race: where each artist stood among the chart's artists, slice by slice
  "rank-card": (d, t) => {
    const sm = d.artists.map((_, i) => smooth(d.series[i], 3));
    const ranks = d.artists.map(() => []);
    for (let j = 0; j < d.nb; j++) {
      const order = d.artists.map((_, i) => i).sort((a, b) => sm[b][j] - sm[a][j]);
      order.forEach((i, r) => ranks[i].push(sm[i][j] > 0 ? r + 1 : null));
    }
    return {
      grid: { left: 4, right: 4, top: 6, bottom: 6 }, xAxis: axis("category", { boundaryGap: false, data: [...Array(d.nb).keys()] }),
      yAxis: axis("value", { inverse: true, min: 1, max: Math.max(1, d.k) }),
      series: d.artists.map((n, i) => ({ type: "line", id: n, symbol: "none", smooth: 0.5, connectNulls: false, lineStyle: { width: 2.5, color: colorOf(t, n) }, data: ranks[i] })),
    };
  },
  // … Every Month: stacked bars, a dozen at most
  "monthly-card": (d, t) => {
    const bars = Math.min(12, d.nb), per = Math.ceil(d.nb / bars);
    const fold = (a) => Array.from({ length: bars }, (_, b) => r1(a.slice(b * per, (b + 1) * per).reduce((s, v) => s + v, 0)));
    return {
      grid: grid0, xAxis: axis("category", { data: [...Array(bars).keys()] }), yAxis: axis("value"),
      series: d.artists.map((n, i) => ({
        type: "bar", stack: "a", id: n, barCategoryGap: "14%", data: fold(Array.from(d.series[i])), itemStyle: { color: colorOf(t, n) },
      })),
    };
  },
  // Discovery: new … found per slice
  "discovery-card": (d, t) => ({
    grid: grid0, xAxis: axis("category", { data: [...Array(d.nb).keys()] }), yAxis: axis("value"),
    series: [{ type: "bar", barCategoryGap: "12%", data: Array.from(d.found), itemStyle: { color: mix(t.other, t.primary, 0.25), borderRadius: [2, 2, 0, 0] } }],
  }),
  // Hours per week: the chart's artists' hours themselves, stacked
  "hours-card": (d, t) => ({
    grid: grid0, xAxis: axis("category", { boundaryGap: false, data: [...Array(d.nb).keys()] }), yAxis: axis("value"),
    series: d.artists.map((n, i) => ({
      type: "line", stack: "a", id: n, symbol: "none", smooth: 0.4, lineStyle: { width: 0 },
      areaStyle: { color: colorOf(t, n), opacity: 0.9 }, data: Array.from(smooth(d.series[i], 1), r1),
    })),
  }),
  // When you listened: the week, hour by hour
  "clock-card": (d, t) => {
    const max = Math.max(...d.clock) || 1;
    const cells = [];
    for (let day = 0; day < 7; day++) for (let h = 0; h < 24; h++) cells.push([h, day, r1(d.clock[day * 24 + h])]);
    return {
      grid: grid0, xAxis: axis("category", { data: [...Array(24).keys()] }), yAxis: axis("category", { data: [...Array(7).keys()], inverse: true }),
      visualMap: { show: false, min: 0, max, inRange: { color: t.seq } },
      series: [{ type: "heatmap", data: cells, itemStyle: { borderColor: t.surface, borderWidth: 1 } }],
    };
  },
  // Every play: a dot per play (a sample of them), by day and time of day
  // (a series per artist: ECharts' large mode, quick with many dots, takes one color per series)
  "raster-card": (d, t) => ({
    grid: grid0, xAxis: axis("value", { min: 0, max: d.days }), yAxis: axis("value", { min: 0, max: 24, inverse: true }),
    series: [...d.artists, OTHER].map((n, a) => ({
      type: "scatter", id: n, symbolSize: 2.5, large: true, largeThreshold: 200, z: a < d.k ? 2 : 1,
      itemStyle: { color: a < d.k ? colorOf(t, n) : alpha(t.other, 0.5) },
      data: d.raster.filter((p) => p[2] === a).map((p) => [p[0], p[1]]),
    })),
  }),
  // Every day: a square per day, a column per week
  "calendar-card": (d, t) => {
    const startDow = (d.lo + 3) % 7, weeks = Math.ceil((d.days + startDow) / 7);
    const max = Math.max(...d.daily) || 1;
    return {
      grid: grid0, xAxis: axis("category", { data: [...Array(weeks).keys()] }), yAxis: axis("category", { data: [...Array(7).keys()], inverse: true }),
      visualMap: { show: false, min: 0, max: max * 0.7, inRange: { color: t.seq } },
      series: [{ type: "heatmap", itemStyle: { borderColor: t.surface, borderWidth: weeks > 80 ? 0 : 1 },
        data: Array.from(d.daily, (h, i) => [Math.floor((i + startDow) / 7), (i + startDow) % 7, r1(h)]) }],
    };
  },
  // Skips and picks: each artist's plays, played through and skipped
  "skips-card": (d, t) => ({
    grid: grid0, xAxis: axis("value"), yAxis: axis("category", { data: d.artists, inverse: true }),
    series: [0, 1].map((s) => ({
      type: "bar", stack: "a", barWidth: "72%",
      data: d.artists.map((n, i) => ({ value: d.skip[i][s], itemStyle: { color: s ? alpha(colorOf(t, n), 0.45) : colorOf(t, n) } })),
    })),
  }),
};

// ---------- Painting ----------
// els: card id -> thumbnail element. Thumbnails off screen (or out of the open view) wait, and paint as they return.
const els = new Map();
const near = new Set();
const owed = new Set();
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      near.add(e.target);
      if (owed.has(e.target)) paintThumbs();
    } else near.delete(e.target);
  }
}, { rootMargin: "25% 0px" });
export function addThumb(id, el) {
  els.set(id, el);
  seen.observe(el);
}

let frame = 0;
export function paintThumbs() {
  if (!frame) frame = requestAnimationFrame(paint);
}
function paint() {
  frame = 0;
  if (!state.plays || !state.range || !state.mixArgs) return;
  const t = tokens();
  let d = null;
  for (const [id, el] of els) {
    if (!near.has(el) || !el.offsetParent) {
      owed.add(el);
      continue;
    }
    owed.delete(el);
    d ??= digest();
    const c = chart(el);
    const first = !c.getOption()?.series?.length;
    c.setOption({
      // (heatmaps and dots don't tween in ECharts, so those draw once a paint rather than every frame for nothing)
      animation: !STILL.has(id), animationDuration: dur(ENTER_MS), animationEasing: "cubicOut",
      animationDurationUpdate: dur(CHASE_MS), animationEasingUpdate: "cubicOut",
      tooltip: hide, silent: true, ...THUMBS[id](d, t, { w: el.clientWidth, h: el.clientHeight }),
    }, { replaceMerge: first ? [] : ["series"] });
  }
}

// The gallery's thumbnails (gallery.js): each graph's own small drawing, made for its tile rather than shrunk from the
// card. They keep the card's look (tinted bands under 1px lines in the artist's color, the gray of everyone else, a
// baseline) and drop what doesn't fit 96px: axes' labels, names except where there's room, the controls. They draw
// from one digest of the period's plays, worked out in a single pass per paint, and paint together, coalesced to one
// a frame. Thumbnails get one look and one tier (CHASE_MS, cut short by the next paint).
//
// THUMBS: card id -> (digest, tokens, box) => ECharts option. A contributed graph adds its own entry here.

import { state, shownPlays, OTHER } from "./state.js";
import { chart } from "./charts.js";
import { tokens, alpha, mix } from "./colors.js";
import { DAY, HOUR, isSkip, isPick } from "./aggregate.js";
import { CHASE_MS, ENTER_MS, dur } from "./motion.js";
import { fmtH } from "./format.js";

const BUCKETS = 40; // time slices across the period
const RASTER_MAX = 1800; // marks in Every play's thumbnail
const FOUND_MAX = 500; // dots in Discovery's
const STILL = new Set(["raster-card", "calendar-card"]);

// ---------- The digest: one pass over the period's plays ----------
let firstMemo = null; // when each item was first played, over all the loaded plays (Discovery)
function firstDays(off) {
  if (firstMemo?.plays !== state.plays) {
    const m = new Map();
    for (const p of state.plays) if (!m.has(p.artist)) m.set(p.artist, Math.floor((p.t + off) / DAY));
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
  const k = artists.length, K = k + 1; // the chart's artists, then everyone else
  const series = Array.from({ length: K }, () => new Float64Array(nb)); // hours per slice
  const total = new Map(); // every item's hours
  const parts = artists.map(() => new Map()); // each chart artist's albums (or songs), hours
  const skip = artists.map(() => [0, 0, 0]); // picked, played through, skipped (plays)
  const hours = new Float64Array(K * 24); // by hour of day
  const daily = new Float64Array(days * K); // by day
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
    daily[d * K + a] += h;
    const hour = Math.floor((local % DAY) / HOUR);
    hours[a * 24 + hour] += h;
    if (a < k) {
      const part = state.dim === "artist" ? p.album : p.track;
      if (part) parts[a].set(part, (parts[a].get(part) ?? 0) + h);
      skip[a][isSkip(p) ? 2 : isPick(p) ? 0 : 1] += p.w ?? 1;
    }
    if (i % every === 0) raster.push([d, hour + (local % HOUR) / HOUR, a]);
  }
  // Discovery: everything first heard in the period, by when and how much since (a sample past FOUND_MAX)
  const found = [];
  for (const [n, f] of firstDays(off)) if (f >= lo && f <= hi && total.has(n)) found.push([f - lo, total.get(n), idx.get(n) ?? k]);
  const step = Math.max(1, Math.ceil(found.length / FOUND_MAX));
  const foundShown = found.filter((x, i) => x[2] < k || i % step === 0);
  memo = { key, artists, k, K, nb, per, lo, days, series, total, parts, skip, hours, daily, raster, found: foundShown };
  return memo;
}

// ---------- Drawing ----------
const hide = { show: false };
const axis = (type, o = {}) => ({ type, show: false, ...o });
// A time axis drawn as the cards draw theirs, as a baseline only
const base = (t, type, o = {}) => ({
  type, axisLine: { show: true, lineStyle: { color: t.axis } }, axisTick: hide, axisLabel: hide, splitLine: hide, ...o,
});
// Faint guides across, as the cards' value axes have, without their labels
const guides = (t, o = {}) => ({ type: "value", axisLine: hide, axisTick: hide, axisLabel: hide, splitLine: { lineStyle: { color: t.grid } }, ...o });
const colorOf = (t, n) => {
  const s = state.colorSlots?.get(n);
  return s === undefined ? t.other : t.series[s];
};
const colorAt = (t, d, a) => (a < d.k ? colorOf(t, d.artists[a]) : t.other);
const band = (t, col) => mix(t.surface, col, t.shade.rest); // the rolling chart's bands at rest
const r1 = (v) => Math.round(v * 100) / 100;
const keys = (n) => [...Array(n).keys()];
// Rolling sum over a few slices (wrapping round for the hours of a day), so shares don't flicker slice to slice
const smooth = (a, w = 2, wrap = false) => Array.from(a, (_, i) => {
  let s = 0;
  for (let j = i - w; j <= i + w; j++) s += wrap ? a[(j + a.length) % a.length] : a[Math.min(a.length - 1, Math.max(0, j))];
  return s;
});
// Stacked shares among the chart's artists, each a tinted band under a line in its color
function shareBands(t, d, rows) {
  const tot = rows[0].map((_, j) => rows.reduce((s, r) => s + r[j], 0) || 1);
  return d.artists.map((n, i) => ({
    type: "line", stack: "a", id: n, symbol: "none", smooth: 0.3,
    lineStyle: { width: 1, color: colorOf(t, n) }, areaStyle: { color: band(t, colorOf(t, n)), opacity: 1 },
    data: rows[i].map((v, j) => r1(v / tot[j])),
  }));
}

export const THUMBS = {
  // The mix bar: each artist's tinted block with its share in its color and its hours under
  "mix-card": (d, t, box) => {
    const hrs = d.artists.map((_, i) => d.series[i].reduce((s, v) => s + v, 0));
    const sum = hrs.reduce((s, v) => s + v, 0) || 1;
    return {
      grid: { left: 0, right: 0, top: 18, bottom: 18 }, xAxis: axis("value", { max: 1 }), yAxis: axis("category", { data: [""] }),
      series: d.artists.map((n, i) => {
        const col = colorOf(t, n);
        return {
          type: "bar", stack: "a", barWidth: "100%", id: n, name: n, data: [r1(hrs[i] / sum)],
          itemStyle: { color: band(t, col), borderColor: t.surface, borderWidth: 1, borderRadius: 3 },
          label: {
            show: (hrs[i] / sum) * box.w > 30, position: "inside", lineHeight: 14,
            formatter: `{p|${Math.round((hrs[i] / sum) * 100)}%}\n{h|${fmtH(hrs[i])}}`,
            rich: { p: { color: col, fontSize: 11, fontWeight: 600 }, h: { color: t.muted, fontSize: 9 } },
          },
        };
      }),
    };
  },
  // Inside your top: the chart's artists, their albums (or songs) around them
  "sunburst-card": (d, t) => ({
    series: [{
      type: "sunburst", radius: ["18%", "98%"], center: ["50%", "50%"], sort: null, label: hide, nodeClick: false,
      itemStyle: { borderColor: t.surface, borderWidth: 1 },
      data: d.artists.map((n, i) => {
        const col = colorOf(t, n);
        const kids = [...d.parts[i]].sort((a, b) => b[1] - a[1]).slice(0, 6);
        return {
          name: n, value: r1(d.total.get(n) ?? 0), itemStyle: { color: mix(t.surface, col, 0.3) },
          children: kids.map(([p, h]) => ({ name: p, value: r1(h), itemStyle: { color: mix(t.surface, col, 0.16) } })),
        };
      }),
    }],
  }),
  // All your …: the top of the list, a name over a thin line as long as its hours
  "ranking-card": (d, t) => {
    const top = [...d.total].sort((a, b) => b[1] - a[1]).slice(0, 5);
    return {
      grid: { left: 0, right: 34, top: 12, bottom: 2 }, xAxis: axis("value", { max: top[0]?.[1] || 1 }),
      yAxis: axis("category", { data: top.map((x) => x[0]), inverse: true }),
      series: [{
        type: "bar", barWidth: 1.5, data: top.map(([n, h]) => ({ value: r1(h), itemStyle: { color: colorOf(t, n) } })),
        label: { show: true, position: [0, -12], color: t.primary, fontSize: 10, formatter: (p) => top[p.dataIndex][0], width: 220, overflow: "truncate" },
      }, {
        // the hours, at the right as the card has them
        type: "bar", barWidth: 1, barGap: "-100%", silent: true, z: 0, itemStyle: { color: "transparent" }, data: top.map(() => top[0][1]),
        label: { show: true, position: "right", distance: 6, color: t.muted, fontSize: 9, formatter: (p) => fmtH(top[p.dataIndex][1]) },
      }],
    };
  },
  // Top … View: each artist's share among the chart's artists, stacked (the rest left out, as the card does)
  "rolling-card": (d, t) => ({
    grid: { left: 0, right: 0, top: 1, bottom: 1 }, xAxis: base(t, "category", { boundaryGap: false, data: keys(d.nb) }),
    yAxis: guides(t, { max: 1, interval: 0.25 }),
    series: shareBands(t, d, d.artists.map((_, i) => smooth(d.series[i]))),
  }),
  // … over time: the race's last frame, a tinted bar per artist with its name
  "race-card": (d, t) => {
    const rows = d.artists.map((n, i) => [n, d.series[i].reduce((s, v) => s + v, 0)]).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return {
      grid: { left: 0, right: 34, top: 2, bottom: 2 }, xAxis: axis("value", { max: rows[0]?.[1] || 1 }),
      yAxis: axis("category", { data: rows.map((x) => x[0]), inverse: true }),
      series: [{
        type: "bar", barWidth: "62%",
        data: rows.map(([n, h]) => ({ value: r1(h), itemStyle: { color: band(t, colorOf(t, n)), borderColor: colorOf(t, n), borderWidth: 1, borderRadius: 2 } })),
        label: { show: true, position: "insideLeft", distance: 6, color: t.primary, fontSize: 9, formatter: (p) => rows[p.dataIndex][0], width: 200, overflow: "truncate" },
      }, {
        type: "bar", barWidth: 1, barGap: "-100%", silent: true, z: 0, itemStyle: { color: "transparent" }, data: rows.map(() => rows[0][1]),
        label: { show: true, position: "right", distance: 6, color: t.muted, fontSize: 9, formatter: (p) => fmtH(rows[p.dataIndex][1]) },
      }],
    };
  },
  // Rank race: where each artist stood among the chart's artists, slice by slice, over a guide per place
  "rank-card": (d, t) => {
    const sm = d.artists.map((_, i) => smooth(d.series[i], 3));
    const ranks = d.artists.map(() => []);
    for (let j = 0; j < d.nb; j++) {
      const order = d.artists.map((_, i) => i).sort((a, b) => sm[b][j] - sm[a][j]);
      order.forEach((i, r) => ranks[i].push(sm[i][j] > 0 ? r + 1 : null));
    }
    return {
      grid: { left: 2, right: 2, top: 5, bottom: 5 }, xAxis: axis("category", { boundaryGap: false, data: keys(d.nb) }),
      yAxis: guides(t, { inverse: true, min: 1, max: Math.max(1, d.k), interval: 1 }),
      series: d.artists.map((n, i) => ({ type: "line", id: n, symbol: "none", smooth: 0.5, connectNulls: false, lineStyle: { width: 1.5, color: colorOf(t, n) }, data: ranks[i] })),
    };
  },
  // … Every Month: everyone else's gray at the bottom, the chart's artists tinted above, a dozen bars at most
  "monthly-card": (d, t) => {
    const bars = Math.min(12, d.nb), per = Math.ceil(d.nb / bars);
    const fold = (a) => keys(bars).map((b) => r1(a.slice(b * per, (b + 1) * per).reduce((s, v) => s + v, 0)));
    const order = [d.k, ...keys(d.k)];
    return {
      grid: { left: 0, right: 0, top: 2, bottom: 1 }, xAxis: base(t, "category", { data: keys(bars) }), yAxis: guides(t, { splitNumber: 3 }),
      series: order.map((a, j) => ({
        type: "bar", stack: "a", id: a < d.k ? d.artists[a] : OTHER, barCategoryGap: "30%", data: fold(Array.from(d.series[a])),
        itemStyle: { color: mix(t.surface, colorAt(t, d, a), 0.25), borderColor: t.surface, borderWidth: 1, borderRadius: j === order.length - 1 ? [1.5, 1.5, 0, 0] : 0 },
      })),
    };
  },
  // Discovery: everything first heard in the period, a dot by when and (on a log scale) how much since
  "discovery-card": (d, t) => ({
    grid: { left: 3, right: 3, top: 4, bottom: 1 }, xAxis: base(t, "value", { min: 0, max: d.days }),
    yAxis: { ...guides(t), type: "log", min: 1 / 60, splitLine: hide },
    series: [0, 1].map((mine) => ({
      type: "scatter", symbolSize: mine ? 4.5 : 2.5, z: mine ? 2 : 1,
      itemStyle: mine ? {} : { color: alpha(t.other, 0.55) },
      data: d.found.filter((x) => (x[2] < d.k) === !!mine).map(([day, h, a]) => ({
        value: [day, Math.max(h, 1 / 60)], ...(mine ? { itemStyle: { color: colorAt(t, d, a) } } : {}),
      })),
    })),
  }),
  // Hours per week: a ridge per artist, its hours rising from its own baseline, each over the next
  "hours-card": (d, t) => {
    const sm = d.artists.map((_, i) => smooth(d.series[i], 1));
    const max = Math.max(1e-9, ...sm.flat());
    const rise = 3; // the tallest peak, in rows
    return {
      grid: { left: 0, right: 0, top: 2, bottom: 2 }, xAxis: base(t, "category", { boundaryGap: false, data: keys(d.nb) }),
      yAxis: axis("value", { min: 0, max: Math.max(1, d.k - 1) + rise }),
      series: d.artists.map((n, i) => {
        const y0 = d.k - 1 - i;
        return {
          type: "line", id: n, symbol: "none", smooth: 0.4, lineStyle: { width: 1, color: colorOf(t, n) },
          areaStyle: { color: band(t, colorOf(t, n)), opacity: 1, origin: y0 },
          data: sm[i].map((v) => r1(y0 + (v / max) * rise)),
        };
      }),
    };
  },
  // When you listened: through the day, each artist's share of the hour, as the card stacks it
  "clock-card": (d, t) => {
    const rows = d.artists.map((_, i) => {
      const r = smooth(d.hours.subarray(i * 24, i * 24 + 24), 1, true);
      return [...r, r[0]]; // midnight again at the right
    });
    return {
      grid: { left: 0, right: 0, top: 1, bottom: 1 }, xAxis: base(t, "category", { boundaryGap: false, data: keys(25) }),
      yAxis: guides(t, { max: 1, interval: 0.25 }), series: shareBands(t, d, rows),
    };
  },
  // Every play: a mark per play (a sample of them), by day and time of day
  // (a series per artist: ECharts' large mode, quick with many marks, takes one color per series)
  "raster-card": (d, t) => ({
    grid: { left: 0, right: 0, top: 2, bottom: 2 }, xAxis: axis("value", { min: 0, max: d.days }), yAxis: axis("value", { min: 0, max: 24, inverse: true }),
    series: keys(d.K).map((a) => ({
      type: "scatter", id: a < d.k ? d.artists[a] : OTHER, symbol: "rect", symbolSize: [1.5, 3], large: true, largeThreshold: 200, z: a < d.k ? 2 : 1,
      itemStyle: { color: a < d.k ? alpha(colorAt(t, d, a), 0.85) : alpha(t.other, 0.4) },
      data: d.raster.filter((p) => p[2] === a).map((p) => [p[0], p[1]]),
    })),
  }),
  // Every day: a square per day, a column per week, tinted by the day's top artist and darker the more you listened
  "calendar-card": (d, t) => {
    const startDow = (d.lo + 3) % 7, weeks = Math.ceil((d.days + startDow) / 7);
    const sums = keys(d.days).map((i) => {
      let s = 0, top = d.k, best = 0;
      for (let a = 0; a < d.K; a++) {
        const h = d.daily[i * d.K + a];
        s += h;
        if (h > best) (best = h), (top = a);
      }
      return [s, top];
    });
    const full = Math.max(1e-9, ...sums.map((x) => x[0])) * 0.7;
    const empty = mix(t.surface, t.other, 0.08);
    return {
      grid: { left: 0, right: 0, top: 0, bottom: 0 }, xAxis: axis("category", { data: keys(weeks) }), yAxis: axis("category", { data: keys(7), inverse: true }),
      series: [{
        type: "heatmap", itemStyle: { borderColor: t.surface, borderWidth: weeks > 80 ? 0 : 1.5, borderRadius: 1 },
        data: sums.map(([h, a], i) => ({
          value: [Math.floor((i + startDow) / 7), (i + startDow) % 7, r1(h)],
          itemStyle: { color: h > 0 ? mix(t.surface, colorAt(t, d, a), 0.2 + 0.7 * Math.min(1, h / full)) : empty },
        })),
      }],
    };
  },
  // Skips and picks: each artist's plays, picked, played through and skipped, in shades of its color
  "skips-card": (d, t) => ({
    grid: { left: 0, right: 0, top: 2, bottom: 2 }, xAxis: axis("value", { max: 1 }), yAxis: axis("category", { data: d.artists, inverse: true }),
    series: [1, 0.3, 0.75].map((shade, s) => ({
      type: "bar", stack: "a", barWidth: "58%",
      data: d.artists.map((n, i) => {
        const n3 = d.skip[i][0] + d.skip[i][1] + d.skip[i][2] || 1;
        const radius = s === 0 ? [2, 0, 0, 2] : s === 2 ? [0, 2, 2, 0] : 0;
        return { value: r1(d.skip[i][s] / n3), itemStyle: { color: mix(t.surface, colorOf(t, n), shade), borderRadius: radius } };
      }),
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

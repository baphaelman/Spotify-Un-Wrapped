// The gallery's thumbnails (gallery.js): each graph's own small drawing, made for its tile rather than shrunk from the
// card. They keep the card's look (tinted bands under 1px lines in the artist's color, the gray of everyone else, a
// baseline) and drop what doesn't fit 96px: axes' labels, names except where there's room, the controls. They draw
// from one digest of the period's plays, worked out in a single pass per paint, and paint together, coalesced to one
// a frame. Thumbnails get one look and one tier (CHASE_MS, cut short by the next paint).
//
// THUMBS: card id -> (digest, tokens, box) => ECharts option. A contributed graph adds its own entry here.

import { state, shownPlays, OTHER, WINDOWS } from "./state.js";
import { coverFor, knownCover } from "./covers.js";
import { chart } from "./charts.js";
import { tokens, alpha, mix } from "./colors.js";
import { DAY, HOUR, isSkip, isPick, monthSpan } from "./aggregate.js";
import { tune } from "./tune.js";
import { CHASE_MS, ENTER_MS, EASE_OUT, dur } from "./motion.js";
import { fmtH } from "./format.js";

const BUCKETS = 40; // time slices across the period
const POINTS = 160; // places along the period the Top … View thumbnail is worked out at
const FACE = 26; // the mix thumbnail's pictures
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
  const key = [state.plays?.length, lo, hi, state.dim, tune.maxBars, state.hidden.join("\u0001"), artists.join("\u0001")].join("|");
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
  // Calendar months (in the card's blocks of `span`), each with its hours and its top item of all, as the card has them
  const span = monthSpan(plays, tune.maxBars);
  const monthKey = (i) => {
    const dt = new Date((lo + i) * DAY); // (a local day's UTC fields are its local date)
    return Math.floor((dt.getUTCFullYear() * 12 + dt.getUTCMonth()) / span);
  };
  const m0 = monthKey(0);
  const monthOf = Int32Array.from({ length: days }, (_, i) => monthKey(i) - m0);
  const months = Array.from({ length: monthOf[days - 1] + 1 }, () => ({ hours: 0, each: new Map() }));
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
    const mo = months[monthOf[d]];
    mo.hours += h;
    mo.each.set(p.artist, (mo.each.get(p.artist) ?? 0) + h);
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
  // (and of the chart's artists alone, for a card showing them without everyone else)
  for (const mo of months) {
    let top = "", topH = 0, own = 0, mine = "", mineH = 0;
    for (const [n, h] of mo.each) {
      if (h > topH) (top = n), (topH = h);
      if (!idx.has(n)) continue;
      own += h;
      if (h > mineH) (mine = n), (mineH = h);
    }
    Object.assign(mo, { top, topH, own, mine, mineH, each: null });
  }
  memo = { key, artists, k, K, nb, per, lo, days, series, total, parts, skip, hours, daily, raster, found: foundShown, months };
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
// Whether a card shows everyone else (its own "Everyone else" toggle). A thumbnail follows its card's choice, so the
// tile shows what opening it shows (and a flight's arrival starts from matching shapes).
const otherOn = (id) => document.querySelector(`#${id} .other-toggle input`)?.checked ?? true;
// The mix bar's blocks: the chart's artists, and everyone else when the card shows it (so the shares are the card's)
const mixRows = (d) => {
  const rows = d.artists.map((n, i) => [n, d.series[i].reduce((s, v) => s + v, 0)]);
  if (otherOn("mix-card")) rows.push([OTHER, d.series[d.k].reduce((s, v) => s + v, 0)]);
  return rows;
};
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

// A month's top item: strong in its color when it's one of the chart's, a mid gray when it isn't
const crown = (t, n) => (state.colorSlots?.has(n) ? mix(t.surface, colorOf(t, n), 0.85) : mix(t.surface, t.other, 0.6));

// How well each thumbnail looks stretched to a column and a half (0 to 1): a section that must stretch some tiles to
// fill its rows stretches its best (gallery.js pack). Placeholders until the thumbnails are settled; score them then.
export const STRETCH = {
  // (grouped as the per-graph sessions are, a comment between groups, so re-scoring one group never touches another's
  // lines: git merges them cleanly)
  // over time, the rolling chart's
  "rolling-card": 0.9, "hours-card": 0.65,
  // over time, ECharts
  "rank-card": 0.6, "discovery-card": 0.5, "clock-card": 0.7,
  // rows
  "race-card": 0.55, "ranking-card": 0.2, "skips-card": 0.3,
  // your top
  "mix-card": 0.4, "sunburst-card": 0.1,
  // every.js
  "raster-card": 0.8, "calendar-card": 0.85,
  // done
  "monthly-card": 0.45,
};

export const THUMBS = {
  // The mix bar: each artist's tinted block with its share in its color and its hours under, their pictures above (faces)
  "mix-card": (d, t, box) => {
    const rows = mixRows(d), hrs = rows.map((r) => r[1]);
    const sum = hrs.reduce((s, v) => s + v, 0) || 1;
    return {
      grid: { left: 0, right: 0, top: FACE + 8, bottom: 0 }, xAxis: axis("value", { max: 1 }), yAxis: axis("category", { data: [""] }),
      series: rows.map(([n], i) => {
        const col = n === OTHER ? t.other : colorOf(t, n);
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
          name: n, value: r1(d.total.get(n) ?? 0), itemStyle: { color: mix(t.surface, col, 0.7) },
          children: kids.map(([p, h]) => ({ name: p, value: r1(h), itemStyle: { color: mix(t.surface, col, 0.4) } })),
        };
      }),
    }],
  }),
  // All your …: the list, a name over a thin line as long as its hours
  // (rows keep their height and run on past the bottom, faded out there, as the card's list goes on)
  "ranking-card": (d, t, box) => {
    const ROW = 19, TOP = 12;
    const n = Math.ceil((box.h - TOP) / ROW) + 1;
    const top = [...d.total].sort((a, b) => b[1] - a[1]).slice(0, n);
    return {
      grid: { left: 0, right: 34, top: TOP, bottom: box.h - TOP - n * ROW }, xAxis: axis("value", { max: top[0]?.[1] || 1 }),
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
  // (over the card's own window, its days per slice, summed from the days at up to POINTS places)
  "rolling-card": (d, t) => {
    const W = Math.min(d.days, WINDOWS[document.getElementById("window")?.value] ?? 45);
    const n = Math.min(POINTS, d.days - W + 1);
    const at = keys(n).map((j) => W - 1 + Math.round((j * (d.days - W)) / Math.max(1, n - 1)));
    const rows = d.artists.map((_, a) => {
      const sum = new Float64Array(d.days + 1); // running total, so each window is one subtraction
      for (let i = 0; i < d.days; i++) sum[i + 1] = sum[i] + d.daily[i * d.K + a];
      return at.map((x) => sum[x + 1] - sum[x + 1 - W]);
    });
    return {
      grid: { left: 0, right: 0, top: 1, bottom: 1 }, xAxis: base(t, "category", { boundaryGap: false, data: keys(n) }),
      yAxis: guides(t, { max: 1, interval: 0.25 }), series: shareBands(t, d, rows),
    };
  },
  // … over time: the race run out, each artist's hours since the period began piling up, named where it ends
  // (the card plays this out as bars; drawn as lines it reads as time, unlike the lists beside it)
  "race-card": (d, t) => ({
    grid: { left: 0, right: 74, top: 4, bottom: 1 }, xAxis: base(t, "category", { boundaryGap: false, data: keys(d.nb + 1) }),
    yAxis: guides(t, { splitNumber: 3 }), animationDurationUpdate: dur(CHASE_MS),
    series: d.artists.map((n, i) => {
      let run = 0;
      return {
        type: "line", id: n, symbol: "none", lineStyle: { width: 1.25, color: colorOf(t, n) },
        data: [0, ...Array.from(d.series[i], (v) => r1((run += v)))],
        endLabel: { show: true, color: colorOf(t, n), fontSize: 9, distance: 4, formatter: n, width: 68, overflow: "truncate" },
        labelLayout: { moveOverlap: "shiftY" },
      };
    }),
  }),
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
      series: d.artists.map((n, i) => ({ type: "line", id: n, symbol: "none", smooth: 0.5, connectNulls: false, lineStyle: { width: 1, color: colorOf(t, n) }, data: ranks[i] })),
    };
  },
  // … Every Month: the card's bars pared down, each month's hours with its top item on top in its color (gray when
  // it isn't one of the chart's), the rest one quiet gray. Without everyone else, as the card has it, a month is
  // only the chart's artists, the biggest of them on top.
  "monthly-card": (d, t) => {
    const all = otherOn("monthly-card");
    const bar = (m) => (all ? [m.hours, m.top, m.topH] : [m.own, m.mine, m.mineH]);
    return {
      grid: { left: 0, right: 0, top: 2, bottom: 1 }, xAxis: base(t, "category", { data: keys(d.months.length) }), yAxis: guides(t, { splitNumber: 3 }),
      series: [
        { type: "bar", stack: "a", id: "rest", barCategoryGap: "26%", itemStyle: { color: mix(t.surface, t.other, 0.28) }, data: d.months.map((m) => r1(bar(m)[0] - bar(m)[2])) },
        { type: "bar", stack: "a", id: "top", data: d.months.map((m) => ({ value: r1(bar(m)[2]), itemStyle: { color: crown(t, bar(m)[1]), borderRadius: [2, 2, 0, 0] } })) },
      ],
    };
  },
  // Discovery: everything first heard in the period, a dot by when and (on a log scale) how much since
  "discovery-card": (d, t) => ({
    grid: { left: 3, right: 3, top: 4, bottom: 1 }, xAxis: base(t, "value", { min: 0, max: d.days }),
    yAxis: { ...guides(t), type: "log", min: 1 / 60, splitLine: hide },
    series: [0, 1].map((mine) => ({
      type: "scatter", symbolSize: mine ? 7 : 3.5, z: mine ? 2 : 1,
      itemStyle: mine ? { borderColor: t.surface, borderWidth: 1 } : { color: alpha(t.other, 0.75) },
      data: d.found.filter((x) => (x[2] < d.k) === !!mine).map(([day, h, a]) => ({
        value: [day, Math.max(h, 1 / 60)], ...(mine ? { itemStyle: { color: colorAt(t, d, a) } } : {}),
      })),
    })),
  }),
  // Hours per week: a ridge per artist, its hours rising from its own baseline, each over the next
  "hours-card": (d, t) => {
    const sm = d.artists.map((_, i) => smooth(d.series[i], 1));
    const rise = 1.6; // each artist's peak, in rows
    return {
      grid: { left: 0, right: 0, top: 2, bottom: 2 }, xAxis: base(t, "category", { boundaryGap: false, data: keys(d.nb) }),
      yAxis: axis("value", { min: 0, max: Math.max(1, d.k - 1) + rise }),
      series: d.artists.map((n, i) => {
        const y0 = d.k - 1 - i;
        return {
          type: "line", id: n, symbol: "none", smooth: 0.4, lineStyle: { width: 1, color: colorOf(t, n) },
          areaStyle: { color: band(t, colorOf(t, n)), opacity: 1, origin: y0 },
          data: sm[i].map((v, _, a) => r1(y0 + (v / (Math.max(...a) || 1)) * rise)),
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
  // Every day: a square per day, a column per week, tinted by the day's top artist of the chart's and darker the more you listened
  "calendar-card": (d, t) => {
    const startDow = (d.lo + 3) % 7, weeks = Math.ceil((d.days + startDow) / 7);
    const sums = keys(d.days).map((i) => {
      let s = 0, top = d.k, best = 0;
      for (let a = 0; a < d.K; a++) {
        const h = d.daily[i * d.K + a];
        s += h;
        if (a < d.k && h > best) (best = h), (top = a); // (the day's top among the chart's artists: everyone else, all of them together, would win most days)
      }
      return [s, top];
    });
    const heard = sums.map((x) => x[0]).filter((h) => h > 0).sort((a, b) => a - b);
    const full = heard[Math.floor(heard.length * 0.9)] || 1e-9; // (the 90th percentile day is full strength)
    const empty = mix(t.surface, t.other, 0.08);
    return {
      grid: { left: 0, right: 0, top: 0, bottom: 0 }, xAxis: axis("category", { data: keys(weeks) }), yAxis: axis("category", { data: keys(7), inverse: true }),
      series: [{
        type: "heatmap", itemStyle: { borderColor: t.surface, borderWidth: weeks > 80 ? 0 : 1.5, borderRadius: 1 },
        data: sums.map(([h, a], i) => ({
          value: [Math.floor((i + startDow) / 7), (i + startDow) % 7, r1(h)],
          itemStyle: { color: h > 0 ? mix(t.surface, colorAt(t, d, a), 0.25 + 0.65 * Math.sqrt(Math.min(1, h / full))) : empty },
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

// The mix thumbnail's pictures, a row of round faces centered over the artists' blocks (where a block is wide enough).
// Only pictures the mix card asks for anyway (coverFor shares its asks), so the thumbnail costs no Spotify calls.
function faces(el, d, t, box) {
  let row = el.querySelector(".thumb-faces");
  if (!row) {
    row = document.createElement("div");
    row.className = "thumb-faces";
    row.faces = new Map();
    el.append(row);
  }
  row.classList.toggle("square", state.dim !== "artist"); // albums' and songs' covers are square
  const rows = mixRows(d), hrs = rows.map((r) => r[1]);
  const sum = hrs.reduce((s, v) => s + v, 0) || 1;
  let x = 0;
  rows.forEach(([n], i) => {
    const w = (hrs[i] / sum) * box.w;
    let f = row.faces.get(n);
    if (!f) {
      f = document.createElement("div");
      f.className = "thumb-face";
      f.style.left = `${x + w / 2}px`;
      row.faces.set(n, f);
      row.append(f);
    }
    clearTimeout(f.gone);
    f.style.left = `${x + w / 2}px`;
    f.style.opacity = w >= FACE + 4 && n !== OTHER ? 1 : 0;
    f.style.background = mix(t.surface, colorOf(t, n), 0.3);
    x += w;
    const item = state.dim === "genre" ? null : state.covers?.get(n);
    const url = item ? knownCover(item) : "";
    if (url === undefined) coverFor(item).then((u) => u && paintThumbs());
    else if (url && f.url !== url) {
      f.url = url;
      const img = new Image();
      img.alt = "";
      img.onload = () => img.classList.add("shown");
      img.src = url;
      f.replaceChildren(img);
    }
  });
  for (const [n, f] of row.faces) {
    if (d.artists.includes(n)) continue;
    f.style.opacity = 0;
    row.faces.delete(n);
    f.gone = setTimeout(() => f.remove(), dur(CHASE_MS));
  }
}
const OVERLAYS = { "mix-card": faces };

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
// (a card's "Everyone else" toggle redraws its thumbnail with it: otherOn)
document.addEventListener("change", (e) => {
  if (e.target.closest?.(".other-toggle")) paintThumbs();
});
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
  for (const [id, el] of els) {
    if (!near.has(el) || !el.offsetParent) {
      owed.add(el);
      continue;
    }
    paintOne(id, el, t);
  }
}
// One thumbnail, now, wherever it is (a flight closing into it reads its form before it shows: gallery.js)
export function paintThumb(id) {
  const el = els.get(id);
  if (el?.offsetParent && state.plays && state.range && state.mixArgs) paintOne(id, el, tokens());
}
function paintOne(id, el, t) {
  owed.delete(el);
  const d = digest();
  const c = chart(el);
  const first = !c.getOption()?.series?.length;
  c.setOption({
    // (heatmaps and dots don't tween in ECharts, so those draw once a paint rather than every frame for nothing)
    animation: !STILL.has(id), animationDuration: dur(ENTER_MS), animationEasing: EASE_OUT.echarts,
    animationDurationUpdate: dur(CHASE_MS), animationEasingUpdate: EASE_OUT.echarts,
    tooltip: hide, silent: true, ...THUMBS[id](d, t, { w: el.clientWidth, h: el.clientHeight }),
  }, { replaceMerge: first ? [] : ["series"] });
  OVERLAYS[id]?.(el, d, t, { w: el.clientWidth, h: el.clientHeight });
}

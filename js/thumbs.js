// The gallery's thumbnails (gallery.js): each graph's own small drawing, made for its tile rather than shrunk from the
// card. They keep the card's look (tinted bands under 1px lines in the artist's color, the gray of everyone else, a
// baseline) and drop what doesn't fit 96px: axes' labels, names except where there's room, the controls. They draw
// from one digest of the period's plays, worked out in a single pass per paint, and paint together, coalesced to one
// a frame. Thumbnails get one look and one tier (CHASE_MS, cut short by the next paint).
//
// THUMBS: card id -> (digest, tokens, box) => ECharts option. A contributed graph adds its own entry here.

import { state, shownPlays, rangeTotals, OTHER, WINDOWS, catchUp } from "./state.js";
import { coverFor, knownCover } from "./covers.js";
import { chart, clockShares, clockSmoothing } from "./charts.js";
import { rankLines, rankKey } from "./rankrace.js";
import { tokens, alpha, mix } from "./colors.js";
import { DAY, HOUR, isSkip, isPick, monthSpan, clockBy, firstHeard, firstHeardTracks, dayToDate } from "./aggregate.js";
import { tune } from "./tune.js";
import { CHASE_MS, ENTER_MS, EASE_OUT, dur, easeOut, litLook } from "./motion.js";
import { fmtH, hoursText } from "./format.js";
import { sunLayout, sunShape } from "./sunburst.js";
import { paintRasterThumb, paintCalendarThumb } from "./every.js";
import { raceNow } from "./race.js";
import { skipsNow } from "./skips.js";

const BUCKETS = 40; // time slices across the period
const POINTS = 160; // places along the period the Top … View thumbnail is worked out at
const FACE = 26; // the mix thumbnail's pictures
const RASTER_MAX = 1800; // marks in Every play's thumbnail (digest: no longer drawn, every.js draws its own)
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

// Discovery's finds as its card has them (rollingview.js paintDiscovery): every item first heard (or, by the card's
// "Reached threshold", first reaching its Listening Threshold) in the period with at least that much all time, on
// the card's axes. lit: those of the chart's artists (a genre's tracks by their genre); rest: a sample of the others.
let heardMemo = null, findsMemo = null;
function discoveryFinds(d) {
  const floor = tune.discoveryFloor / 60;
  const reach = document.querySelector("#discovery-by [aria-pressed=true]")?.dataset.by === "reach" ? floor : 0;
  const key = [d.key, floor, reach].join("|");
  if (findsMemo?.key === key) return findsMemo;
  if (heardMemo?.plays !== state.plays || heardMemo.reach !== reach) {
    const items = state.dim === "genre" ? firstHeardTracks(state.plays, reach) : firstHeard(state.plays, state.dim !== "track", state.dim !== "album", reach);
    heardMemo = { plays: state.plays, reach, items };
  }
  const span = [dayToDate(d.lo).getTime(), dayToDate(d.lo + d.days).getTime()];
  const hidden = new Set(state.hidden);
  const shown = heardMemo.items.filter((e) => e.t >= span[0] && e.t < span[1] && e.hours >= floor && !hidden.has(e.group ?? e.name));
  const keyed = new Set(d.artists.filter((n) => state.colorSlots?.has(n)));
  const lit = shown.filter((e) => keyed.has(e.group ?? e.name)), rest = shown.filter((e) => !keyed.has(e.group ?? e.name));
  const step = Math.max(1, Math.ceil(rest.length / FOUND_MAX));
  const top = Math.max(1, shown.reduce((m, x) => Math.max(m, x.hours), floor) * 1.6);
  findsMemo = { key, span, floor, top, lit, rest: rest.filter((_, i) => i % step === 0) };
  return findsMemo;
}

// When you listened's bands as its card has them (rollingview.js paintClock): the chart's artists' shares through
// the day (and everyone else's, when the card shows it), smoothed as the card smooths them, each band's top edge
let clockMemo = null;
function clockBands(d) {
  const other = otherOn("clock-card"), { sigma, curve } = clockSmoothing();
  const key = [d.key, other, sigma, curve].join("|");
  if (clockMemo?.key === key) return clockMemo;
  const keyed = d.artists.filter((n) => state.colorSlots?.has(n));
  const { share, bottom } = clockShares(clockBy(shownPlays(), keyed, 1), keyed.length, other, sigma);
  const data = share.map((v, k) => v.map((x, h) => [h, bottom[k][h] + x]));
  clockMemo = { key, curve, all: [...keyed, OTHER], data };
  return clockMemo;
}

// Rank race's lines as its card draws them (rankrace.js rankLines), kept while nothing they depend on changes
let rankMemo = null;
function rankThumb(d, t) {
  const key = [d.key, rankKey(), [...(state.colorSlots ?? [])].join()].join("|");
  if (rankMemo?.key !== key) rankMemo = { key, r: rankLines(t) };
  return rankMemo.r;
}
// The earlier design (a Visual tweak): where each artist stood among the chart's artists, slice by slice
function rankAmong(d, t) {
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

// Rows as the list cards draw them, for their thumbnails (race, skips): a row's pitch (rows hang from the top, as the
// card's do, never taller than ROW_MAX), the name column's width (left) and the room kept right of the bars
const ROW_MAX = 16;
const rowLook = (box, n, nameFrac = 0.22, rightPx = 30) => {
  const pitch = Math.min(ROW_MAX, box.h / Math.max(1, n));
  return { pitch, left: Math.round(box.w * nameFrac), right: rightPx, font: pitch < 11 ? 8 : 9 };
};
export const SKIPS_NAME = 0.155; // the skips thumbnail's name column, as a share of its width (its arrival cuts names there)
const mono = () => getComputedStyle(document.body).getPropertyValue("--mono").trim() || "monospace";

// ---------- Top … View and Hours per week: the card's own plot, in miniature ----------
// Both tiles draw what their card's chart draws (rolling.js), so every setting of it (days per slice, smoothing,
// Everyone else, albums or songs, hidden and pinned artists, ridges or lines) shows in the tile, and the flight's
// arrival only has to bring the height from the tile's to the card's (arrivals.js). The chart waits while both its
// cards are away (rollingview.js putOff): a tile runs what it owes first (catchUp), so it's drawn, off screen, as
// the tiles need it. Its morphs can chain past the paint that asked, so the tiles also repaint as its renders settle.
const watched = new WeakSet(); // charts the tiles repaint after
function plotOf(id) {
  // (what both cards owe: the chart draws both plots unless both are away. They stay away: its series hold the whole
  // history and the tile reads the period itself, so a drag's zoom, put off each frame, needn't be drawn for it)
  // While the period window is dragged, the tiles slide over the chart as it is (its artists settle as it's let go)
  if (!document.getElementById("brush-track")?.classList.contains("dragging")) catchUp(...["rolling-card", "hours-card"].map((c) => document.getElementById(c)));
  const c = echarts.getInstanceByDom(document.getElementById(id));
  if (!c?.getModel()?.getSeries().length) return null;
  if (!watched.has(c)) {
    watched.add(c);
    c.on("finished", () => paintThumbs());
    // (an artist change ends on a plain redraw that never reports finished: the tile follows its series instead)
    c.on("rendered", () => idsOf(c) !== copied.get(c) && paintThumbs());
  }
  return c;
}
document.getElementById("brush-track")?.addEventListener("pointerup", () => paintThumbs()); // (a drag let go: see plotOf)
const copied = new WeakMap(); // chart -> its series' ids as the tile last copied them
const idsOf = (c) => c.getModel().getSeries().map((m) => m.id).join();
// The chart's series as it draws them at rest (their options as its model holds them, read, never changed), on its
// own y extent, over the period (rollingview.js periodZoom) and the point past each end. The card draws about a point
// per pixel; the tile takes every step-th of the same points, about one per pixel of its own. Share's edges are drawn
// twice as wide and half clipped away by their band (rolling.js clipEdges); here they're lines of their own, edge ×
// what shows.
function miniature(t, id, box, edge) {
  const c = plotOf(id);
  if (!c) return null;
  const models = c.getModel().getSeries();
  copied.set(c, idsOf(c));
  const xs = models[0].option.data; // (flat: x, y, x, y …, the same dates in every series)
  const n = xs.length / 2;
  const x0 = Math.max(dayToDate(state.range.lo).getTime(), xs[0]), x1 = Math.min(dayToDate(state.range.hi + 1).getTime() - 1, xs[2 * n - 2]);
  let a = 0, b = n - 1;
  while (a < b && xs[2 * (a + 1)] <= x0) a++;
  while (b > a && xs[2 * (b - 1)] >= x1) b--;
  const step = Math.max(1, Math.floor((b - a) / Math.max(1, box.w)));
  const at = [];
  for (let i = a; i < b; i += step) at.push(i);
  at.push(b);
  const [, top] = c.getModel().getComponent("yAxis").axis.scale.getExtent();
  const series = models.map(({ id, option: s }) => {
    const data = new Float64Array(at.length * 2);
    at.forEach((i, j) => ((data[2 * j] = s.data[2 * i]), (data[2 * j + 1] = s.data[2 * i + 1])));
    return {
      type: "line", id, z: s.z, symbol: "none", showSymbol: false, smooth: s.smooth, color: s.color, connectNulls: false,
      lineStyle: { ...s.lineStyle, width: /^[tb]\d/.test(id) ? (s.lineStyle.width / 2) * edge : s.lineStyle.width },
      areaStyle: s.areaStyle ? { ...s.areaStyle } : null,
      data,
    };
  });
  const x = [x0, x1];
  return {
    // (the top edge sits a line's width inside the frame, so it's drawn whole)
    grid: { left: 0, right: 0, top: 2, bottom: 1 },
    xAxis: base(t, "time", { min: x[0], max: x[1] }),
    yAxis: { ...axis("value"), min: 0, max: top },
    series,
  };
}

// How well each thumbnail looks stretched to a column and a half (0 to 1): a section that must stretch some tiles to
// fill its rows stretches its best (gallery.js pack). Placeholders until the thumbnails are settled; score them then.
export const STRETCH = {
  // (grouped as the per-graph sessions are, a comment between groups, so re-scoring one group never touches another's
  // lines: git merges them cleanly)
  // over time, the rolling chart's
  "rolling-card": 0.9, "hours-card": 0.75,
  // over time, ECharts
  "rank-card": 0.65, "discovery-card": 0.75, "clock-card": 0.7,
  // rows
  // (rows across: wider only lengthens the bars and the name column; the text keeps its size)
  "race-card": 0.75, "ranking-card": 0.6, "skips-card": 0.65,
  // your top
  "mix-card": 0.7, "sunburst-card": 0.1,
  // every.js
  "raster-card": 0.85, "calendar-card": 0.7, // (scored: every.js's miniatures. A play's marks widen along time; the boxes turn wide past their square)
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
  // Inside your top: the card's own rings, round, drawn over this empty chart (OVERLAYS: rings)
  "sunburst-card": () => ({ series: [] }),
  // All your …: the list, a name over a thin line as long as its hours, the hours at the right, from the card's own
  // totals (the period's, less what's hidden), past an empty column where the card's ranks go
  // (rows keep their height and run on past the bottom, faded out there, as the card's list goes on)
  "ranking-card": (d, t, box) => {
    const ROW = 19, TOP = 12, RANK = Math.round(box.w * 0.044);
    const n = Math.ceil((box.h - TOP) / ROW) + 1;
    const hidden = new Set(state.hidden);
    const top = [...rangeTotals().items].filter(([k, e]) => !hidden.has(k) && e.ms > 0).sort((a, b) => b[1].ms - a[1].ms).slice(0, n)
      .map(([k, e]) => [k, e.ms]);
    const own = (k) => (state.chartNames?.includes(k) ? colorOf(t, k) : t.other); // (as the card's chartColor)
    return {
      grid: { left: RANK, right: 34, top: TOP, bottom: box.h - TOP - n * ROW }, xAxis: axis("value", { max: top[0]?.[1] || 1 }),
      yAxis: axis("category", { data: top.map((x) => x[0]), inverse: true }),
      series: [{
        type: "bar", id: "bar", barWidth: 1.5, data: top.map(([k, ms]) => ({ name: k, value: ms, itemStyle: { color: own(k) } })),
        label: { show: true, position: [0, -12], color: t.primary, fontSize: 10, formatter: (p) => state.titles?.get(top[p.dataIndex][0]) ?? top[p.dataIndex][0], width: 220, overflow: "truncate" },
      }, {
        // the hours, at the right as the card has them
        type: "bar", id: "val", barWidth: 1, barGap: "-100%", silent: true, z: 0, itemStyle: { color: "transparent" },
        data: top.map(([k]) => ({ name: k, value: top[0][1] })),
        label: { show: true, position: "right", distance: 6, color: t.muted, fontSize: 9, formatter: (p) => fmtH(top[p.dataIndex][1] / HOUR) },
      }],
    };
  },
  // Top … View: the card's own bands, as it draws them (miniature). The first design, kept as a Visual tweak ("Gallery
  // tile", which crossfades): each artist's share among the chart's artists, stacked (the rest left out), over the
  // card's own window, its days per slice, summed from the days at up to POINTS places, without its smoothing
  "rolling-card": (d, t, box) => {
    const mini = !tune.rollingThumb && miniature(t, "chart-rolling", box, 2 / 3);
    if (mini) return mini;
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
  // … over time: the card's rows at its playhead (raceNow), as the card draws them: the name ending at its bar, a bar in the item's color
  // as long as its hours, the hours after it. The card waits halfway through the period, so this is the race then.
  "race-card": (d, t, box) => {
    const rows = raceNow();
    const top = rows[0]?.[1] || 1;
    const { pitch, left, right, font } = rowLook(box, rows.length);
    const own = (k) => (state.chartNames?.includes(k) ? colorOf(t, k) : t.other); // (as the card's chartColor)
    return {
      grid: { left, right, top: 0, height: pitch * rows.length }, xAxis: axis("value", { max: top }),
      yAxis: axis("category", { data: rows.map((r) => r[0]), inverse: true }),
      series: [{
        type: "bar", id: "bar", barWidth: Math.round(pitch * 0.53), animationDurationUpdate: dur(CHASE_MS),
        data: rows.map(([k, v]) => ({ name: k, value: v, itemStyle: { color: own(k), borderRadius: 2 } })),
        label: {
          // (right-aligned, ending just before the bar, as the card's names do)
          show: true, position: [-6, "50%"], align: "right", verticalAlign: "middle", color: t.primary, fontSize: font,
          width: left - 6, overflow: "truncate", formatter: (p) => state.titles?.get(rows[p.dataIndex][0]) ?? rows[p.dataIndex][0],
        },
      }, {
        // the hours, just past the bar's end
        // (as wide as the bar it rides on: overlaid bars line up by their top edge)
        type: "bar", id: "val", barWidth: Math.round(pitch * 0.53), barGap: "-100%", z: 0, itemStyle: { color: "transparent" },
        data: rows.map(([k, v]) => ({ name: k, value: v })),
        label: { show: true, position: "right", distance: 4, color: t.secondary, fontSize: font - 1, fontFamily: mono(), formatter: (p) => hoursText(rows[p.dataIndex][1], 0) },
      }],
    };
  },
  // Rank race: the card's own lines (rankLines), where everything that reached its positions stood slice by slice,
  // the chart's artists in their colors over thin grays, without circles or names, so its arrival only grows them
  // (morphRankRace). Visual tweaks' tune.rankThumb 1 draws the earlier design instead: only the chart's artists,
  // ranked among themselves over BUCKETS slices (that one crossfades).
  "rank-card": (d, t) => {
    if (tune.rankThumb) return rankAmong(d, t);
    const r = rankThumb(d, t);
    if (!r) return { series: [] };
    return {
      grid: { left: 0, right: 0, top: 3, bottom: 0 }, xAxis: axis("value", { min: 0, max: Math.max(1, r.n - 1) }),
      yAxis: guides(t, { inverse: true, min: 1, max: r.MAX + 0.4, interval: 1 }),
      series: r.lines.map((l) => ({
        type: "line", id: l.a, symbol: "none", smooth: 0.5, smoothMonotone: "x", z: l.col ? 3 : 1,
        lineStyle: { width: l.col ? 1.25 : 0.75, color: l.col ?? t.other, opacity: l.col ? 1 : tune.rankGrayOpacity },
        data: l.ys.map((y, i) => [i, y]),
      })),
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
  // Discovery: the card's finds (its threshold and its First listen / Reached choice), a dot by when and (on its log
  // scale, from the threshold up) how much all time, in the card's colors: the chart's artists over a sample of the
  // rest. Each dot is named, so the card's arrival grows its own dots from these (morphDiscovery).
  "discovery-card": (d, t) => {
    const f = discoveryFinds(d);
    return {
      grid: { left: 3, right: 3, top: 4, bottom: 1 }, xAxis: base(t, "value", { min: f.span[0], max: f.span[1] }),
      yAxis: { ...guides(t), type: "log", min: f.floor, max: f.top, splitLine: hide },
      series: [
        { id: "rest", type: "scatter", symbolSize: 3.5, z: 1, itemStyle: { color: mix(t.surface, t.other, 0.8) }, data: f.rest.map((e) => ({ name: e.name, value: [e.t, Math.max(e.hours, f.floor)] })) },
        {
          id: "mine", type: "scatter", symbolSize: 7, z: 2, itemStyle: { borderColor: t.surface, borderWidth: 1 },
          data: f.lit.map((e) => ({ name: e.name, value: [e.t, Math.max(e.hours, f.floor)], itemStyle: { color: colorOf(t, e.group ?? e.name) } })),
        },
      ],
    };
  },
  // Hours per week: the card's own ridges (or lines), as it draws them, on its one scale (miniature). The first
  // design, kept as a Visual tweak ("Gallery tile", which crossfades): a ridge per artist, its hours rising from its
  // own baseline to its own peak, each over the next
  "hours-card": (d, t, box) => {
    const mini = !tune.hoursThumb && miniature(t, "chart-rolling-hours", box, 1);
    if (mini) return mini;
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
  // When you listened: the card's own bands (clockShares, its smoothing and its Everyone else), each artist's share
  // of the hour through the day under a line in its color, everyone else's gray on top, stacked by hand as the card
  // stacks them, so its arrival only grows them to the card's height (morphClock). They stand only as tall as the
  // card's plot is for its width (the flight can't draw them taller than the card's canvas), the guides going on
  // above. Visual tweaks' tune.clockThumb 1 fills the tile instead (that one crossfades).
  "clock-card": (d, t, box) => {
    const { curve, all, data } = clockBands(d);
    const hidden = new Set(state.hidden);
    const plot = document.getElementById("chart-clock");
    const g = echarts.getInstanceByDom(plot)?.getModel()?.getComponent("grid")?.coordinateSystem?.getRect();
    // (before the card has drawn, its grid from its element: renderClock's margins, 16 at the sides, 8 over, 28 under)
    const aspect = g?.width > 0 ? g.height / g.width : plot?.clientWidth > 32 ? (plot.clientHeight - 36) / (plot.clientWidth - 32) : 0;
    const top = 1, H = box.h - top, max = tune.clockThumb || !aspect ? 1 : Math.max(1, H / (box.w * aspect));
    return {
      grid: { left: 0, right: 0, top, bottom: 0 }, xAxis: axis("value", { min: 0, max: 24 }),
      yAxis: guides(t, { min: 0, max, interval: 0.25 }),
      series: all.map((n, k) => {
        const col = n === OTHER ? t.other : colorOf(t, n);
        return {
          id: `c${k}`, type: "line", symbol: "none", smooth: curve, z: 2 + all.length - k, data: data[k],
          lineStyle: { width: hidden.has(n) ? 0 : 1, color: mix(t.surface, col, t.fade.rest) }, areaStyle: { color: mix(t.surface, col, t.shade.rest), opacity: 1 },
        };
      }),
    };
  },
  // Every play: drawn by every.js, the card's own drawing in miniature (OVERLAYS), over an empty chart
  "raster-card": () => ({ series: [] }),
  // Every day: drawn by every.js, the card's own boxes in miniature (OVERLAYS), over an empty chart
  "calendar-card": () => ({ series: [] }),
  // Skips and picks: the card's rows (skipsNow) in its columns: the name, the bar of plays picked, played through and
  // skipped in shades of its color, the share picked and the share skipped. The rows share the thumbnail's height, as
  // the card's share its list's.
  "skips-card": (d, t, box) => {
    const rows = skipsNow();
    const W = box.w, n = Math.max(1, rows.length);
    // (the card's columns at its usual width: name 1-17%, bar 18-86.5%, then the two numbers)
    const left = Math.round(W * 0.18), right = Math.round(W * 0.135), pitch = box.h / n;
    const shade = tune.skipsShades === 1 ? 0.18 : 1;
    const col = (r) => (r.slot == null ? t.other : t.series[r.slot]);
    const label = (x, o) => ({ show: true, position: [x - left, "50%"], align: "left", verticalAlign: "middle", fontSize: pitch < 11 ? 8 : 9, ...o });
    const thick = Math.max(2, Math.round(Math.min(pitch - 3, pitch * 0.7)));
    // (each label rides a clear bar as thick as the row's: overlaid bars line up by their top edge)
    const words = (id, x, o) => ({
      type: "bar", id, barWidth: thick, barGap: "-100%", silent: true, z: 0, itemStyle: { color: "transparent" },
      data: rows.map((r) => ({ name: r.name, value: 1 })), label: label(x, o),
    });
    return {
      grid: { left, right, top: 0, height: pitch * n }, xAxis: axis("value", { max: 1 }),
      yAxis: axis("category", { data: rows.map((r) => r.name), inverse: true }),
      series: [
        ...[["bar", 1], ["bar-on", 0.5], ["bar-skip", shade]].map(([id, k], s) => ({
          type: "bar", id, stack: "a", barWidth: thick,
          data: rows.map((r) => ({ name: r.name, value: r1(r.parts[s]), itemStyle: { color: mix(t.surface, col(r), k) } })),
        })),
        words("name", Math.round(W * 0.01), { color: t.primary, width: Math.round(W * SKIPS_NAME), overflow: "truncate", formatter: (p) => rows[p.dataIndex].shown }),
        words("pick", Math.round(W * 0.877), { color: t.primary, fontFamily: mono(), formatter: (p) => rows[p.dataIndex].pick }),
        words("skip", Math.round(W * 0.941), { color: t.primary, fontFamily: mono(), formatter: (p) => rows[p.dataIndex].skip }),
      ],
    };
  },
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
// Inside your top's thumbnail: the card's slices as it draws them (sunLayout), round at the tile's height, in the
// card's own classes (so its colors and looks), without labels; a change glides each slice from where it is
const SVGNS = "http://www.w3.org/2000/svg";
function rings(el, d, t, box) {
  let svg = el.querySelector(".thumb-sun");
  if (!svg) {
    svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "thumb-sun");
    svg.shapes = new Map(); // id -> { path, ext, outline, g (on screen) }
    el.append(svg);
  }
  const lay = sunLayout();
  const R = box.h / 2 - 1;
  svg.setAttribute("viewBox", `${-box.w / 2} ${-box.h / 2} ${box.w} ${box.h}`);
  svg.R = R;
  svg.ids = lay ? lay.slices.map((x) => x.id) : [];
  if (!lay) return;
  const pins = state.mixArgs?.[3];
  const pinned = new Set(lay.slices.filter((x) => x.depth === 1 && pins?.has(x.item)).map((x) => x.item));
  const first = !svg.shapes.size;
  const want = new Map(lay.slices.map((x) => [x.id, x]));
  const moves = [];
  for (const x of lay.slices) {
    let sh = svg.shapes.get(x.id);
    if (!sh) {
      const make = (cls) => {
        const p = document.createElementNS(SVGNS, "path");
        p.setAttribute("class", cls);
        return p;
      };
      sh = { path: make("sun-slice"), ext: make("sun-slice sun-ext"), outline: make("sun-outline") };
      svg.append(sh.path, sh.ext);
      svg.shapes.set(x.id, sh);
      // (comes in from nothing: growing out of its ring on the first paint, opening from its start after)
      sh.g = first ? { ...x.g, r1: x.g.r0, rn: x.g.r0 } : { ...x.g, a1: x.g.a0 };
    }
    sh.leaving = false;
    const dd = Math.min(x.depth, 3);
    for (const e of [sh.path, sh.ext]) for (let k = 0; k <= 3; k++) e.classList.toggle("d" + k, k === dd);
    sh.ext.classList.toggle("seam", tune.sunTeeth === 2);
    const slot = x.item != null && x.item !== OTHER ? state.colorSlots?.get(x.item) : undefined;
    const c = slot === undefined ? "var(--other)" : `var(--series-${slot + 1})`;
    for (const e of [sh.path, sh.ext, sh.outline]) e.style.setProperty("--c", c);
    const look = x.depth === 0 ? "rest" : litLook(pinned, null, x.item);
    sh.path.dataset.look = sh.ext.dataset.look = look;
    const on = x.depth === 1 && pinned.has(x.item);
    if (on && !sh.outline.isConnected) svg.append(sh.outline);
    sh.outline.classList.toggle("on", on);
    moves.push([sh, sh.g, x.g]);
  }
  // Whoever left closes up where they were
  for (const [id, sh] of svg.shapes) {
    if (want.has(id)) continue;
    if (!sh.leaving) moves.push([sh, sh.g, { ...sh.g, a0: sh.g.a0, a1: sh.g.a0 }]);
    sh.leaving = true;
  }
  const put = (sh) => {
    const [dd, ext, outline] = sunShape(sh.g, R);
    sh.path.setAttribute("d", dd);
    sh.ext.setAttribute("d", ext);
    sh.outline.setAttribute("d", sh.outline.classList.contains("on") ? outline : "");
  };
  const lerp = (a, b, p) => Object.fromEntries(Object.keys(b).map((k) => [k, (a[k] ?? b[k]) + (b[k] - (a[k] ?? b[k])) * p]));
  cancelAnimationFrame(svg.raf);
  const ms = dur(first ? ENTER_MS : CHASE_MS);
  const t0 = performance.now();
  const tick = (now) => {
    const p = ms ? Math.min(1, (now - t0) / ms) : 1;
    for (const [sh, a, b] of moves) {
      sh.g = lerp(a, b, easeOut(p));
      put(sh);
    }
    if (p < 1) return void (svg.raf = requestAnimationFrame(tick));
    for (const [id, sh] of svg.shapes) {
      if (!sh.leaving) continue;
      sh.path.remove();
      sh.ext.remove();
      sh.outline.remove();
      svg.shapes.delete(id);
    }
  };
  tick(ms ? t0 : t0 + 1);
}
// Every play and Every day draw on every.js's canvases, from what their cards are drawn from (rollingview.js paintEvery)
const everyArgs = (id) => {
  const [artists, , , pins] = state.mixArgs;
  const names = artists.filter((a) => state.colorSlots.has(a) && !state.hidden.includes(a));
  const { lo, hi } = state.range;
  return { plays: state.plays, hidden: state.hidden, lo, hi, names, slots: names.map((n) => state.colorSlots.get(n)), pins, other: otherOn(id) };
};
const OVERLAYS = {
  "mix-card": faces,
  "sunburst-card": rings,
  "raster-card": (el) => paintRasterThumb(el, document.getElementById("chart-raster"), everyArgs("raster-card")),
  "calendar-card": (el) => paintCalendarThumb(el, document.getElementById("chart-calendar"), everyArgs("calendar-card")),
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

// The gallery's thumbnails (gallery.js): each graph's own small drawing, made for its tile rather than shrunk from the
// card. They keep the card's look (tinted bands under 1px lines in the artist's color, the gray of everyone else, a
// baseline) and drop what doesn't fit 96px: axes' labels, names except where there's room, the controls. They draw
// from one digest of the period's plays, worked out in a single pass per paint, and paint together, coalesced to one
// a frame. Thumbnails get one look and one tier (CHASE_MS, cut short by the next paint).
//
// THUMBS: card id -> (digest, tokens, box) => ECharts option. A contributed graph adds its own entry here.

import { state, shownPlays, rangeTotals, OTHER, WINDOWS, catchUp, soon, onPan, pan } from "./state.js";
import { coverFor, knownCover } from "./covers.js";
import { chart, clockShares, clockSmoothing, TILE_EDGE, clipBandEdges, EDGE_GAP, MONTH_SHADE } from "./charts.js";
import { rankLines, rankKey } from "./rankrace.js";
import { tokens, alpha, mix } from "./colors.js";
import { DAY, HOUR, isSkip, isPick, monthSpan, clockBy, firstHeard, firstHeardTracks, dayToDate } from "./aggregate.js";
import { tune } from "./tune.js";
import { CHASE_MS, ENTER_MS, MORPH_MS, FADE_MS, EASE_OUT, dur, easeOut, easeInOut, litLook, setOptionFaded, drawStill } from "./motion.js";
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
    Object.assign(mo, { top, topH, own, mine, mineH, by: artists.map((n) => mo.each.get(n) ?? 0), each: null });
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
  if (!wide && findsMemo?.key === key) return findsMemo;
  if (heardMemo?.plays !== state.plays || heardMemo.reach !== reach) {
    const items = state.dim === "genre" ? firstHeardTracks(state.plays, reach) : firstHeard(state.plays, state.dim !== "track", state.dim !== "album", reach);
    heardMemo = { plays: state.plays, reach, items };
  }
  // (sliding: the finds of both periods, the axes the window's: its span and its own top)
  const span = wide?.win ?? [dayToDate(d.lo).getTime(), dayToDate(d.lo + d.days).getTime()], [s0, s1] = wide?.span ?? span;
  const hidden = new Set(state.hidden);
  const shown = heardMemo.items.filter((e) => e.t >= s0 && e.t < s1 && e.hours >= floor && !hidden.has(e.group ?? e.name));
  const keyed = new Set(d.artists.filter((n) => state.colorSlots?.has(n)));
  const lit = shown.filter((e) => keyed.has(e.group ?? e.name)), rest = shown.filter((e) => !keyed.has(e.group ?? e.name));
  const step = Math.max(1, Math.ceil(rest.length / (wide ? FOUND_MAX * ((s1 - s0) / (span[1] - span[0])) : FOUND_MAX)));
  const top = Math.max(1, shown.reduce((m, x) => (x.t >= span[0] && x.t < span[1] ? Math.max(m, x.hours) : m), floor) * 1.6);
  const f = { key, span, floor, top, lit, rest: rest.filter((_, i) => i % step === 0) };
  if (!wide) findsMemo = f;
  return f;
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
let catching = false;
function plotOf(id) {
  // (what both cards owe: the chart draws both plots unless both are away. They stay away: its series hold the whole
  // history and the tile reads the period itself, so a drag's zoom, put off each frame, needn't be drawn for it)
  // While the period window is dragged, the tiles slide over the chart as it is (its artists settle as it's let go)
  // (drawn for the change the tiles are already painting for: it doesn't ask them all to paint again)
  if (!document.getElementById("brush-track")?.classList.contains("dragging")) {
    catching = true;
    try {
      catchUp(...["rolling-card", "hours-card"].map((c) => document.getElementById(c)));
    } finally {
      catching = false;
    }
  }
  const c = echarts.getInstanceByDom(document.getElementById(id));
  if (!c?.getModel()?.getSeries().length) return null;
  if (!watched.has(c)) {
    watched.add(c);
    // (only the two tiles that copy it, and only when what it draws changed: a hover's restyle, or one a pin's or a
    // period's morph chained past, isn't new data. An artist change ends on a plain redraw that never reports
    // finished: the tiles follow its series instead)
    const follow = () => {
      if (sigOf(c) === copied.get(c)) return;
      queue("rolling-card", true);
      queue("hours-card", true);
    };
    c.on("finished", follow);
    c.on("rendered", () => idsOf(c) !== copiedIds.get(c) && follow());
  }
  return c;
}
document.getElementById("brush-track")?.addEventListener("pointerup", () => paintThumbs()); // (a drag let go: see plotOf)
const copied = new WeakMap(), copiedIds = new WeakMap(); // chart -> what the tile last copied, its series' ids
const idsOf = (c) => c.getModel().getSeries().map((m) => m.id).join();
// (what it draws: its series, their data and its y extent; a new array of points is new data)
const dataIds = new WeakMap();
let nextData = 0;
const sigOf = (c) => idsOf(c) + "|" + c.getModel().getSeries().map((m) => {
  const d = m.option.data;
  return d && typeof d === "object" ? dataIds.get(d) ?? (dataIds.set(d, ++nextData), nextData) : 0;
}).join() + "|" + c.getModel().getComponent("yAxis")?.axis.scale.getExtent()[1];
// The chart's series as it draws them at rest (their options as its model holds them, read, never changed), on its
// own y extent, over the period (rollingview.js periodZoom) and the point past each end. The card draws about a point
// per pixel; the tile takes every step-th of the same points, about one per pixel of its own. Share's edges (edge:
// TILE_EDGE of the card's weight, which the arrival brings them to) are clipped to their bands' insides as the card's
// are, hiding in bands too thin for them with the card's gap at the tile's scale, so a flight starts and lands on the
// same edges (clipBandEdges, run once the paint has drawn them).
// While a pan slides it (wide, below), the points span both periods at the step the slide set, the axis showing
// wide.win; `still` reads the chart as it is (the pan's start: what the tile shows), without catching it up.
function miniature(t, id, box, edge, still = false) {
  const c = still ? echarts.getInstanceByDom(document.getElementById(id)) : plotOf(id);
  if (!c?.getModel()?.getSeries().length) return null;
  const models = c.getModel().getSeries();
  if (!still) {
    copied.set(c, sigOf(c));
    copiedIds.set(c, idsOf(c));
  }
  const xs = models[0].option.data; // (flat: x, y, x, y …, the same dates in every series)
  const n = xs.length / 2;
  const [w0, w1] = wide?.win ?? spanOf(state.range), [s0, s1] = wide?.span ?? [w0, w1];
  const x0 = Math.max(s0, xs[0]), x1 = Math.min(s1, xs[2 * n - 2]);
  let a = 0, b = n - 1;
  while (a < b && xs[2 * (a + 1)] <= x0) a++;
  while (b > a && xs[2 * (b - 1)] >= x1) b--;
  const step = wide?.step ?? Math.max(1, Math.floor((b - a) / Math.max(1, box.w)));
  const at = [];
  for (let i = a; i < b; i += step) at.push(i);
  at.push(b);
  const [, top] = c.getModel().getComponent("yAxis").axis.scale.getExtent();
  const series = models.map(({ id, option: s }) => {
    const data = new Float64Array(at.length * 2);
    at.forEach((i, j) => ((data[2 * j] = s.data[2 * i]), (data[2 * j + 1] = s.data[2 * i + 1])));
    return {
      type: "line", id, z: s.z, symbol: "none", showSymbol: false, smooth: s.smooth, color: s.color, connectNulls: false,
      lineStyle: { ...s.lineStyle, width: /^[tb]\d/.test(id) ? s.lineStyle.width * edge : s.lineStyle.width },
      areaStyle: s.areaStyle ? { ...s.areaStyle } : null,
      data,
    };
  });
  const x = wide ? [Math.max(w0, xs[0]), Math.min(w1, xs[2 * n - 2])] : [x0, x1];
  if (edge && !still) {
    const bands = models.filter((m) => /^s\d+$/.test(m.id)).length, opacity = new Map(models.map((m) => [m.id, m.option.lineStyle?.opacity ?? 1]));
    const gap = EDGE_GAP * (box.w / c.getModel().getComponent("grid").coordinateSystem.getRect().width);
    const tile = document.getElementById(id === "chart-rolling" ? "thumb-rolling-card" : "thumb-hours-card");
    queueMicrotask(() => clipBandEdges(echarts.getInstanceByDom(tile), bands, (k) => opacity.get(`t${k}`) > 0, gap));
  }
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
  // The mix bar: each artist's tinted block with its share in its color and its hours under, their pictures above (faces);
  // a lit artist's block takes the card's deeper tint (.mix-seg's --tint), and the rest dim, pictures too
  "mix-card": (d, t, box) => {
    const rows = mixRows(d), hrs = rows.map((r) => r[1]);
    const sum = hrs.reduce((s, v) => s + v, 0) || 1;
    const lit = litAmong(rows.map((r) => r[0]));
    return {
      grid: { left: 0, right: 0, top: FACE + 8, bottom: 0 }, xAxis: axis("value", { max: 1 }), yAxis: axis("category", { data: [""] }),
      series: rows.map(([n], i) => {
        const col = n === OTHER ? t.other : colorOf(t, n), look = lit(n);
        return {
          type: "bar", stack: "a", barWidth: "100%", id: n, name: n, data: [r1(hrs[i] / sum)],
          itemStyle: {
            color: isLit(look) ? mix(t.surface, col, Math.min(1, MIX_TINT * litK(look))) : band(t, col), opacity: t.dimItem[look],
            borderColor: t.surface, borderWidth: 1, borderRadius: 3,
          },
          label: {
            show: (hrs[i] / sum) * box.w > 30, position: "inside", lineHeight: 14,
            formatter: `{p|${Math.round((hrs[i] / sum) * 100)}%}\n{h|${fmtH(hrs[i])}}`,
            rich: { p: { color: col, fontSize: 11, fontWeight: isLit(look) ? 700 : 600 }, h: { color: isLit(look) ? t.primary : t.muted, fontSize: 9 } },
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
    const mini = !tune.rollingThumb && miniature(t, "chart-rolling", box, TILE_EDGE);
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
    const lit = litAmong(rows.map((r) => r[0])), dim = (k) => t.dimItem[lit(k)];
    const w = washes(rows.map((r) => r[0]), pitch, (k) => wash(own(k), 0.12, lit(k)));
    return {
      grid: [{ left, right, top: 0, height: pitch * rows.length }, w.grid], xAxis: [axis("value", { max: top }), w.xAxis],
      yAxis: [axis("category", { data: rows.map((r) => r[0]), inverse: true }), w.yAxis],
      series: [w.series, {
        type: "bar", id: "bar", barWidth: Math.round(pitch * 0.53), animationDurationUpdate: dur(CHASE_MS),
        data: rows.map(([k, v]) => ({ name: k, value: v, itemStyle: { color: own(k), borderRadius: 2, opacity: dim(k) }, label: { opacity: dim(k) } })),
        label: {
          // (right-aligned, ending just before the bar, as the card's names do)
          show: true, position: [-6, "50%"], align: "right", verticalAlign: "middle", color: t.primary, fontSize: font,
          width: left - 6, overflow: "truncate", formatter: (p) => state.titles?.get(rows[p.dataIndex][0]) ?? rows[p.dataIndex][0],
        },
      }, {
        // the hours, just past the bar's end
        // (as wide as the bar it rides on: overlaid bars line up by their top edge)
        type: "bar", id: "val", barWidth: Math.round(pitch * 0.53), barGap: "-100%", z: 0, itemStyle: { color: "transparent" },
        data: rows.map(([k, v]) => ({ name: k, value: v, label: { opacity: dim(k) } })),
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
    const lit = litAmong(r.lines.map((l) => l.a));
    return {
      grid: { left: 0, right: 0, top: 3, bottom: 0 }, xAxis: axis("value", { min: 0, max: Math.max(1, r.n - 1) }),
      yAxis: guides(t, { inverse: true, min: 1, max: r.MAX + 0.4, interval: 1 }),
      series: r.lines.map((l) => ({
        type: "line", id: l.a, symbol: "none", smooth: 0.5, smoothMonotone: "x", z: l.col ? 3 : 1,
        lineStyle: { width: l.col ? 1.25 : 0.75, color: l.col ?? t.other, opacity: (l.col ? 1 : tune.rankGrayOpacity) * RANK_DIM(lit(l.a)) },
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
    // (a lit artist's months, where they aren't its top, as a slice of their own out of the gray: m{k}, the card's ids)
    const lit = litAmong(d.artists), slice = (m, k) => (isLit(lit(d.artists[k])) && bar(m)[1] !== d.artists[k] ? m.by[k] : 0);
    const slices = d.artists.map((n, k) => ({
      type: "bar", stack: "a", id: `m${k}`, itemStyle: { color: mix(t.surface, colorOf(t, n), MONTH_SHADE[lit(n)]) }, data: d.months.map((m) => r1(slice(m, k))),
    }));
    return {
      grid: { left: 0, right: 0, top: 2, bottom: 1 }, xAxis: base(t, "category", { data: keys(d.months.length) }), yAxis: guides(t, { splitNumber: 3 }),
      series: [
        { type: "bar", stack: "a", id: "rest", barCategoryGap: "26%", itemStyle: { color: mix(t.surface, t.other, 0.28) }, data: d.months.map((m) => r1(bar(m)[0] - bar(m)[2] - d.artists.reduce((s, _, k) => s + slice(m, k), 0))) },
        ...slices,
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
        // (unclipped: a dot leaving or coming in with a pan slides past the edge rather than popping; the tile clips it)
        { id: "rest", type: "scatter", symbolSize: 3.5, z: 1, clip: false, itemStyle: { color: mix(t.surface, t.other, 0.8) }, data: f.rest.map((e) => ({ name: e.name, value: [e.t, Math.max(e.hours, f.floor)] })) },
        {
          id: "mine", type: "scatter", symbolSize: 7, z: 2, clip: false, itemStyle: { borderColor: t.surface, borderWidth: 1 },
          data: f.lit.map((e) => ({ name: e.name, value: [e.t, Math.max(e.hours, f.floor)], itemStyle: { color: colorOf(t, e.group ?? e.name) } })),
        },
      ],
    };
  },
  // Hours per week: the card's own ridges (or lines), as it draws them, on its one scale (miniature). The first
  // design, kept as a Visual tweak ("Gallery tile", which crossfades): a ridge per artist, its hours rising from its
  // own baseline to its own peak, each over the next
  "hours-card": (d, t, box) => {
    const mini = !tune.hoursThumb && miniature(t, "chart-rolling-hours", box, 0);
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
    const lit = litAmong(all.filter((n) => n !== OTHER && !hidden.has(n)));
    const plot = document.getElementById("chart-clock");
    const g = echarts.getInstanceByDom(plot)?.getModel()?.getComponent("grid")?.coordinateSystem?.getRect();
    // (before the card has drawn, its grid from its element: renderClock's margins, 16 at the sides, 8 over, 28 under)
    const aspect = g?.width > 0 ? g.height / g.width : plot?.clientWidth > 32 ? (plot.clientHeight - 36) / (plot.clientWidth - 32) : 0;
    const top = 1, H = box.h - top, max = tune.clockThumb || !aspect ? 1 : Math.max(1, H / (box.w * aspect));
    return {
      grid: { left: 0, right: 0, top, bottom: 0 }, xAxis: axis("value", { min: 0, max: 24 }),
      yAxis: guides(t, { min: 0, max, interval: 0.25 }),
      series: all.map((n, k) => {
        const col = n === OTHER ? t.other : colorOf(t, n), look = lit(n === OTHER ? undefined : n);
        return {
          id: `c${k}`, type: "line", symbol: "none", smooth: curve, z: 2 + all.length - k, data: data[k],
          lineStyle: { width: hidden.has(n) ? 0 : 1, color: mix(t.surface, col, t.fade[look]) }, areaStyle: { color: mix(t.surface, col, t.shade[look]), opacity: 1 },
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
    const lit = litAmong(rows.map((r) => r.name).filter((n) => n !== OTHER)), dim = (r) => t.dimItem[lit(r.name)];
    // (each label rides a clear bar as thick as the row's: overlaid bars line up by their top edge)
    const words = (id, x, o) => ({
      type: "bar", id, barWidth: thick, barGap: "-100%", silent: true, z: 0, itemStyle: { color: "transparent" },
      data: rows.map((r) => ({ name: r.name, value: 1, label: { opacity: dim(r) } })), label: label(x, o),
    });
    const w = washes(rows.map((r) => r.name), pitch, (n, i) => wash(col(rows[i]), 0.14, lit(n)));
    return {
      grid: [{ left, right, top: 0, height: pitch * n }, w.grid], xAxis: [axis("value", { max: 1 }), w.xAxis],
      yAxis: [axis("category", { data: rows.map((r) => r.name), inverse: true }), w.yAxis],
      series: [
        w.series,
        ...[["bar", 1], ["bar-on", 0.5], ["bar-skip", shade]].map(([id, k], s) => ({
          type: "bar", id, stack: "a", barWidth: thick,
          data: rows.map((r) => ({ name: r.name, value: r1(r.parts[s]), itemStyle: { color: mix(t.surface, col(r), k), opacity: dim(r) } })),
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
  const lit = litAmong(rows.map((r) => r[0]));
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
    f.style.opacity = w >= FACE + 4 && n !== OTHER ? t.dimItem[lit(n)] : 0;
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
// Inside your top's thumbnail: the card's slices as it draws them (sunLayout), round, in the card's own classes (so its
// colors and looks), without labels or a pin's outline; a change glides each slice from where it is. The thumbnail
// fills the tile under its words (.gal-tile.round), and the circle is as tall as it, at its right, as wide as the
// title leaves room for; the line under the title narrows beside it (--round)
const SVGNS = "http://www.w3.org/2000/svg";
function rings(el, d, t, box) {
  let svg = el.querySelector(".thumb-sun");
  if (!svg) {
    svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "thumb-sun");
    svg.shapes = new Map(); // id -> { path, ext, g (on screen) }
    el.append(svg);
  }
  const lay = sunLayout();
  const title = el.closest(".gal-tile")?.querySelector("h4"), words = document.createRange();
  words.selectNodeContents(title ?? el);
  const R = Math.max(8, Math.min(box.h / 2 - 1, (box.w - (title ? words.getBoundingClientRect().width + 16 : 0)) / 2 - 1));
  const cx = box.w / 2 - R - 1; // (the circle's middle, right of the box's)
  svg.setAttribute("viewBox", `${-box.w / 2 - cx} ${-box.h / 2} ${box.w} ${box.h}`);
  el.closest(".gal-tile")?.style.setProperty("--round", `${2 * R + 2}px`);
  Object.assign(svg, { R, cx });
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
      sh = { path: make("sun-slice"), ext: make("sun-slice sun-ext") };
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
    for (const e of [sh.path, sh.ext]) e.style.setProperty("--c", c);
    const look = x.depth === 0 ? "rest" : litLook(pinned, null, x.item);
    sh.path.dataset.look = sh.ext.dataset.look = look;
    moves.push([sh, sh.g, x.g]);
  }
  // Whoever left closes up where they were
  for (const [id, sh] of svg.shapes) {
    if (want.has(id)) continue;
    if (!sh.leaving) moves.push([sh, sh.g, { ...sh.g, a0: sh.g.a0, a1: sh.g.a0 }]);
    sh.leaving = true;
  }
  const put = (sh) => {
    const [dd, ext] = sunShape(sh.g, R);
    sh.path.setAttribute("d", dd);
    sh.ext.setAttribute("d", ext);
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

// Each thumbnail draws a frame at a time (state.js soon), those on screen first; while a graph is open, the ones on
// screen where the grid was left (comingBack) draw after its neighbours, so it closes onto them drawn. The rest wait
// until they come near the screen.
let frame = 0;
export function paintThumbs() {
  if (!frame && !catching) frame = requestAnimationFrame(paint);
}
let back = new Set();
export const comingBack = (thumbs) => void (back = new Set(thumbs));
function paint() {
  frame = 0;
  if (!state.plays || !state.range || !state.mixArgs) return;
  for (const id of els.keys()) queue(id);
}
// (one that has taken longer than a frame to draw, Top … View's, which draws the chart off screen first when it owes a
// paint, Hours per week's, Every play's: on screen, it goes first, in the frame after the change's own, before the
// others start moving, so its long frame stops nothing mid-way; just off screen, it waits for the change's morph)
const cost = new Map(); // thumbnail -> the most ms a paint of it has taken
// (light: it's quick this time, as Top … View's and Hours per week's are, the chart already drawn, following it)
function queue(id, light = false) {
  const el = els.get(id);
  if (!el) return;
  owed.add(el);
  if (near.has(el) && el.offsetParent) {
    const r = !light && (cost.get(el) ?? 0) > 16 && el.getBoundingClientRect();
    if (slide?.from.has(id) && !slide.landed.has(id)) soon(el, () => paintThumb(id), r ? 0 : -1); // (sliding: before it falls behind, quick ones first)
    else if (!r) soon(el, () => paintThumb(id), 1);
    else if (r.bottom > 0 && r.top < innerHeight) soon(el, () => paintThumb(id), 0);
    else soon(el, () => paintThumb(id), 1, dur(MORPH_MS));
  }
  else if (back.has(el)) soon(el, () => paintThumb(id), 3, dur(MORPH_MS));
}
// ---------- Sliding with a pan ----------
// A preset or a step (state.js pan) slides the thumbnails drawn over time with the period, in one move rather than
// their cards' steps. As the pan starts, each one on screen notes what it shows over both periods (from: its option,
// with the artists it has, unanimated); its paint for the change draws that first (nothing on screen changes), then
// the new period's picture, also over both periods, on the pan's remaining time. With the same points in the same
// order, ECharts carries each from where it is to where it's going: the time axis slides (and stretches, for a preset
// of another length) while new artists and values morph in the same move. Paints asked for meanwhile wait; as the pan
// ends each is drawn at the period's own detail at once (the same picture). Every play's, on its own canvas, redraws
// for the range on screen each frame, as it does while the period is dragged.
const SLIDE = { "rolling-card": ["chart-rolling", TILE_EDGE], "hours-card": ["chart-rolling-hours", 0], "discovery-card": null };
let slide = null; // { pan, t0, span, from: id -> option, step: id -> step, landed: ids, raster: its tile or false }
let wide = null; // while a paint draws over both periods: { span, win, step } (ms, ms, points)
// A range of days (fractional on a pan's way) as times, its last day whole
const msOf = (d) => dayToDate(Math.floor(d)).getTime() + (d - Math.floor(d)) * DAY;
const spanOf = (r) => [msOf(r.lo), msOf(r.hi + 1) - 1];
const minMax = ([min, max]) => ({ min, max });
const onScreen = (el) => {
  const r = el.getBoundingClientRect();
  return !!el.offsetParent && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
};
onPan((p) => {
  if (slide?.pan !== p && !p.done) {
    if (slide) slideEnd();
    slideStart(p);
  }
  const raster = slide?.pan === p && slide.raster;
  if (raster && state.mixArgs)
    paintRasterThumb(raster, document.getElementById("chart-raster"), { ...everyArgs("raster-card"), lo: Math.round(p.at.lo), hi: Math.round(p.at.hi) });
  if (p.done && slide?.pan === p) slideEnd();
});
function slideStart(p) {
  const span = [msOf(Math.min(p.from.lo, p.to.lo)), msOf(Math.max(p.from.hi, p.to.hi) + 1) - 1];
  // (Every play's tile, if it's on screen: it redraws each frame)
  const raster = els.get("raster-card");
  slide = { pan: p, t0: performance.now(), span, from: new Map(), step: new Map(), landed: new Set(), raster: raster && onScreen(raster) && raster };
  const t = tokens();
  for (const [id, plot] of Object.entries(SLIDE)) {
    const el = els.get(id);
    if (!el || !onScreen(el) || owed.has(el) || !chart(el).getOption()?.series?.length) continue;
    const box = { w: el.clientWidth, h: el.clientHeight };
    if (plot) {
      // (the chart as the tile copied it: not since redrawn for something it hasn't shown)
      const c = echarts.getInstanceByDom(document.getElementById(plot[0]));
      if (!c?.getModel()?.getSeries().length || copied.get(c) !== sigOf(c)) continue;
      // about a point per pixel of the tile across both periods: each frame of the move rebuilds every band, so it
      // slides with less detail than it rests with (the end's paint brings it back)
      const xs = c.getModel().getSeries()[0].option.data, n = xs.length / 2;
      let k = 0;
      for (let i = 0; i < n; i++) if (xs[2 * i] >= span[0] && xs[2 * i] <= span[1]) k++;
      slide.step.set(id, Math.max(1, Math.ceil(k / Math.max(1, box.w))));
    }
    wide = { span, win: spanOf(p.from), step: slide.step.get(id) };
    try {
      const option = plot ? miniature(t, plot[0], box, plot[1], true) : THUMBS[id]({ key: "", artists: (state.mixArgs?.[0] ?? []).filter((n) => n !== OTHER) }, t, box);
      if (option) slide.from.set(id, option);
    } finally {
      wide = null;
    }
  }
}
function slideEnd() {
  const ids = [...slide.landed];
  slide = null;
  for (const id of ids) {
    const el = els.get(id);
    if (el) soon(el, () => el.offsetParent && drawStill(() => paintOne(id, el, tokens())), 1);
  }
}

// One thumbnail, now, wherever it is (a flight closing into it reads its form before it shows: gallery.js); at once
// when it isn't on screen (near it, or in the grid an open graph hides), where no one sees it move
export function paintThumb(id) {
  const el = els.get(id);
  if (!el?.offsetParent || !state.plays || !state.range || !state.mixArgs) return;
  const r = el.getBoundingClientRect(), seen = r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  if (seen) paintOne(id, el, tokens());
  else drawStill(() => paintOne(id, el, tokens()));
}
// (fade: a change of look, a hover, faded over that many ms, shapes and words, rather than morphed on CHASE_MS)
function paintOne(id, el, t, fade = 0) {
  // (one already moving to where a pan is going waits for its end: slideEnd)
  if (slide?.landed.has(id)) return void owed.add(el);
  owed.delete(el);
  const start = performance.now();
  const d = digest();
  const c = chart(el);
  const first = !c.getOption()?.series?.length;
  const from = !first && slide?.from.get(id), box = { w: el.clientWidth, h: el.clientHeight };
  if (from) {
    // what it showed, over both periods, where the pan has got to: nothing on screen changes
    // (a line's axis ends where its points do, as at rest)
    const [x0, x1] = spanOf(pan?.at ?? slide.pan.to), xs = id !== "discovery-card" && from.series[0].data;
    const x = xs ? [Math.max(x0, xs[0]), Math.min(x1, xs[xs.length - 2])] : [x0, x1];
    c.setOption({ ...from, animation: false, xAxis: { ...from.xAxis, ...minMax(x) } }, { replaceMerge: ["series"] });
    wide = { span: slide.span, win: spanOf(slide.pan.to), step: slide.step.get(id) };
  }
  let option;
  try {
    option = {
      // (heatmaps and dots don't tween in ECharts, so those draw once a paint rather than every frame for nothing)
      animation: !STILL.has(id), animationDuration: dur(ENTER_MS), animationEasing: EASE_OUT.echarts,
      animationDurationUpdate: fade || dur(CHASE_MS), animationEasingUpdate: EASE_OUT.echarts,
      tooltip: hide, silent: true, ...THUMBS[id](d, t, box),
    };
  } finally {
    wide = null;
  }
  if (from) {
    // then to the new period's picture over the pan's remaining time, if it has the same points (a line's are by
    // their order); otherwise at once. Its easing is the rest of the pan's own curve from where the pan has got to, so
    // a tile that starts a few frames late keeps pace with the period bar rather than setting off slowly again
    const same = id === "discovery-card" || option.series?.[0]?.data?.length === from.series?.[0]?.data?.length;
    const a = Math.min(1, (performance.now() - slide.t0) / slide.pan.ms), ea = easeInOut(a);
    Object.assign(option, same && a < 1 ? {
      animationDurationUpdate: slide.pan.ms * (1 - a), animationEasingUpdate: (u) => (easeInOut(a + u * (1 - a)) - ea) / (1 - ea),
    } : { animation: false });
    slide.landed.add(id);
  }
  const opts = { replaceMerge: first ? [] : ["series"] };
  if (fade && !first) fadeWords(c, () => setOptionFaded(c, option, opts, fade), fade);
  else c.setOption(option, opts);
  OVERLAYS[id]?.(el, d, t, { w: el.clientWidth, h: el.clientHeight });
  if (!first) cost.set(el, Math.max(cost.get(el) ?? 0, performance.now() - start)); // (a first paint makes its chart too)
}
// setOptionFaded fades shapes, not the words on them: those fade from what they showed to their new opacity too
function fadeWords(c, apply, ms) {
  const words = () => {
    const out = new Map();
    c.getModel().eachSeries((s) => {
      const data = s.getData();
      data.each((i) => {
        const w = data.getItemGraphicEl(i)?.getTextContent?.();
        if (w) out.set(`${s.id}:${data.getName(i)}`, w);
      });
    });
    return out;
  };
  const was = new Map([...words()].map(([k, w]) => [k, w.style.opacity ?? 1]));
  apply();
  for (const [k, w] of words()) {
    const from = was.get(k), to = w.style.opacity ?? 1;
    if (from == null || from === to) continue;
    w.stopAnimation();
    w.setStyle({ opacity: from });
    w.animateTo({ style: { opacity: to } }, { duration: ms, easing: EASE_OUT.echarts });
  }
}

// ---------- The lit look ----------
// A thumbnail lights its artists as its card does, by the page's hover/pin rule (litLook) among those it draws, but
// without the outline a pin adds in the card: the mix bar deepens a lit block's tint and dims the rest, Top … over time
// and Skips and picks wash a lit row and dim the rest, Rank race and When you listened dim the others' lines and bands,
// Every Month grows a lit artist's slices out of the gray. A hover fades the tiles on screen (a frame at a time, state.js soon); the rest take it as they come back,
// or, while a graph is open, the ones it'll close onto, after it.
let hovered = null;
const LIT = ["mix-card", "race-card", "rank-card", "monthly-card", "clock-card", "skips-card"];
export function focusThumbs(name) {
  if ((name ?? null) === hovered) return;
  hovered = name ?? null;
  for (const id of LIT) {
    const el = els.get(id);
    if (!el || !state.mixArgs) continue;
    owed.add(el);
    if (near.has(el) && el.offsetParent) soon(el, () => el.offsetParent && paintOne(id, el, tokens(), dur(FADE_MS)), 1);
    else if (back.has(el)) soon(el, () => paintThumb(id), 3, dur(MORPH_MS));
  }
}
function litAmong(names) {
  const has = new Set(names), pinned = new Set(state.pinned.filter((n) => has.has(n)));
  const h = has.has(hovered) ? hovered : null;
  return (n) => litLook(pinned, h, n);
}
const isLit = (look) => look === "hover" || look === "pin" || look === "pinHover";
// Rank race's lines' opacity by look, as the card's (rankrace.js lookOf)
const RANK_DIM = (look) => (look === "dim" ? tune.rankDim : look === "dimHover" ? 1 - (1 - tune.rankDim) * 0.6 : 1);
// A row's wash as the card's rows have it: its --tint of the color hovered, times --lit-pin pinned and
// --lit-pin-hover both; none at rest or dimmed (a clear one, so it fades in rather than appearing)
function wash(col, tint, look) {
  return alpha(col, Math.min(1, tint * litK(look)));
}
// How many times its --tint a lit item takes: 1 hovered, --lit-pin pinned, --lit-pin-hover both; 0 otherwise
function litK(look) {
  const css = (k) => +getComputedStyle(document.documentElement).getPropertyValue(k) || 1;
  return look === "hover" ? 1 : look === "pin" ? css("--lit-pin") : look === "pinHover" ? css("--lit-pin-hover") : 0;
}
const MIX_TINT = 0.26; // (.mix-seg's --tint)
// The washes: a full-width bar behind each row, on a grid of its own across the whole tile (names and numbers too)
function washes(keys, pitch, color) {
  return {
    grid: { left: 0, right: 0, top: 0, height: pitch * keys.length },
    xAxis: axis("value", { gridIndex: 1, max: 1 }),
    yAxis: axis("category", { gridIndex: 1, data: keys, inverse: true }),
    series: {
      type: "bar", id: "wash", xAxisIndex: 1, yAxisIndex: 1, barWidth: Math.max(1, Math.floor(pitch)), z: -1, silent: true,
      data: keys.map((k, i) => ({ name: k, value: 1, itemStyle: { color: color(k, i) } })),
    },
  };
}

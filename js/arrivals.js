// How each graph's thumbnail becomes its card in the gallery's flight (gallery.js), one entry per card. See
// docs/arrivals.md before adding one.
//
// ARRIVALS: card id -> (card, thumb, to, ms) => boolean. `thumb` is the thumbnail's element (.gal-thumb), drawn as it
// is now (an ECharts one: echarts.getInstanceByDom(thumb)); in the flight's first frame the card's plot sits on its
// baseline, as wide as it. `to` is "thumb" (the card's plot in the thumbnail's form) or "card" (its own). It morphs
// the plot from what's on screen to `to` over ms, in-out, or draws it at once when ms is 0. The flight calls it:
//   opening: ("thumb", 0) then ("card", MORPH_MS), as the flight starts
//   closing: ("thumb", MORPH_MS) as it starts, then ("card", 0) once it lands (the card waits off screen as itself)
//   turned back midway: the other way, over the time flown so far
// Return false when it can't (the thumbnail doesn't match the card's data yet), and the flight crossfades.
//
// A card with an entry flies solid: its plot is the thumbnail from the first frame and never fades. The card's frame
// and words fade in around it, and for an ECharts plot, its overlays and its axes too (gallery.js); a plot of
// elements or its own canvas is all plot, so its arrival fades what it doesn't morph. A card without one crossfades:
// the card fades in over the flying thumbnail, which fades out after.
//
// Each group's imports and entries sit in their own slot, a comment between slots, so sessions working on different
// graphs at once merge cleanly: change only your slot.

import { $ } from "./state.js";
// Every Month
import { morphMonthly } from "./charts.js";
// Top … View, Hours per week
import { arriveHeight } from "./charts.js";
import { tune as rollingTune } from "./tune.js"; // (another slot imports tune too)
// (the tile's series are the plot's, or it's the first design, a Visual tweak, which crossfades)
function rollingArrival(card, el, id, classic, to, ms) {
  const thumb = echarts.getInstanceByDom(el), plot = echarts.getInstanceByDom($(id));
  const ids = (c) => c?.getModel().getSeries().map((s) => s.id).sort().join() ?? ""; // (a merge appends newcomers: z orders them)
  if (classic || !plot || !ids(thumb) || ids(thumb) !== ids(plot)) return false;
  // The flight scales the card by s, from the tile's width to its own (the tiles' plots fill their width), and the
  // thumbnail rides on it, scaled evenly: in the card's pixels its height stays the tile's, h / s of the plot's. The
  // plot keeps to that while the thumbnail shows (the flight's ends) and grows to its own height between, on p² of the
  // card's progress p, read from the card as it flies, so a flight turned back keeps to it too.
  const box = (c) => c.getModel().getComponent("grid").coordinateSystem.getRect();
  const a = box(thumb), b = box(plot);
  const s = a.width / b.width, k0 = a.height / b.height / s; // (the tile's height in the plot's, in the card's pixels)
  const at = () => {
    const scale = new DOMMatrix(getComputedStyle(card).transform).a;
    const p = Math.min(1, Math.max(0, (scale - s) / (1 - s)));
    return { k: k0 + (1 - k0) * p * p, p, scale };
  };
  return arriveHeight($(id), ms, at, to === "thumb" ? { k: k0, p: 0, scale: s } : { k: 1, p: 1, scale: 1 });
}

// Rank race, Discovery, When you listened
import { morphDiscovery, morphClock } from "./charts.js";
import { morphRankRace } from "./rankrace.js";
import { tune } from "./tune.js";
// Where a thumbnail's plot lands on its card's in a solid flight (gallery.js: the card's grid as wide as the
// thumbnail, on its baseline): a point a fraction f across (or up) the thumbnail's grid is at at + k·f of the card's.
// s: the card's pixels per thumbnail pixel.
const gridOf = (c) => c.getModel().getComponent("grid").coordinateSystem.getRect();
function landing(thumbEl, thumb, plot) {
  const a = gridOf(thumb), b = gridOf(plot), W = thumbEl.offsetWidth, H = thumbEl.offsetHeight;
  const s = b.width / W; // (the card's grid is as wide as the whole thumbnail)
  return { s, x: [a.x / W, a.width / W], y: [((H - a.y - a.height) * s) / b.height, (a.height * s) / b.height] };
}

// Top … over time, All your …, Skips and picks
import { flyRows, thumbShapes } from "./rowfly.js";
import { raceRows, settleRace } from "./race.js";
import { skipsRows, skipsNow } from "./skips.js";
import { SKIPS_NAME } from "./thumbs.js";

// Listening mix, Inside your top …
import { morphMix } from "./mix.js";
import { arriveSunburst } from "./sunburst.js";

// Every play, Every day
import { arriveRaster, arriveCalendar } from "./every.js";
import { paintThumb } from "./thumbs.js";

// (end of the imports' slots)

// (Top … over time, All your …, Skips and picks) A thumbnail's label as flyRows' text, and whether the thumbnail draws
// the card's rows (its first ones, in order)
// (room: the width it may take before it's clipped, in the plot's px; by default it isn't)
const text = (l, align = "left", room = Infinity) => l && { x: align === "right" ? l.x + l.w : l.x, y: l.y + l.h / 2, w: room, size: l.size, align };
const matches = (rows, at) => rows.length > 0 && rows.slice(0, at.size).every((r) => at.has(r.key));

export const ARRIVALS = {
  // … Every Month: each bar its top item over one gray (the crowns thumbnail), growing the chart's other artists'
  // slices out of the gray as the colors, gap and heights turn into the card's
  "monthly-card": (card, el, to, ms) => {
    const thumb = echarts.getInstanceByDom(el);
    const series = thumb?.getOption()?.series ?? [], rest = series.find((s) => s?.id === "rest"), top = series.find((s) => s?.id === "top");
    if (!rest || !top) return false;
    // (a lit artist's slices, m{k}: its months' hours where it isn't the top, in its color)
    const slices = new Map(series.filter((s) => /^m\d+$/.test(s?.id) && s.data.some((v) => v > 0)).map((s) => [s.id, s.itemStyle.color]));
    // (the thumbnail's plot is squatter than the card's: its bars stand this much taller, for the same width)
    const box = (c) => c.getModel().getComponent("grid").coordinateSystem.getRect();
    const a = box(thumb), b = box(echarts.getInstanceByDom($("chart-monthly")));
    const look = {
      max: thumb.getModel().getComponent("yAxis").axis.scale.getExtent()[1], stretch: (a.height / a.width) / (b.height / b.width),
      gap: rest.barCategoryGap, rest: rest.itemStyle.color, tops: top.data.map((d) => d.itemStyle.color), slices,
    };
    return morphMonthly($("chart-monthly"), look, to === "thumb", ms);
  },
  // Top … View, Hours per week: the tile draws the card's own series (thumbs.js miniature), so the plot only grows from
  // the tile's height to its own (arriveHeight), the axes and the ridges' names fading in around it
  "rolling-card": (card, el, to, ms) => rollingArrival(card, el, "chart-rolling", rollingTune.rollingThumb, to, ms),
  "hours-card": (card, el, to, ms) => rollingArrival(card, el, "chart-rolling-hours", rollingTune.hoursThumb, to, ms),

  // Rank race, Discovery, When you listened
  // … Rank race: the thumbnail draws the card's own lines, so the card's start as them, squashed to its height, thin
  // and without circles or names, and grow into the card's (its earlier design, a Visual tweak, crossfades)
  "rank-card": (card, el, to, ms) => {
    const thumb = echarts.getInstanceByDom(el), plot = echarts.getInstanceByDom($("chart-rank"));
    const opt = thumb?.getOption(), series = opt?.series?.filter(Boolean); // (a series replaced away leaves a hole)
    if (tune.rankThumb || !series?.length || !plot) return false;
    const lines = new Map(series.map((s) => [s.id, { width: s.lineStyle.width, color: s.lineStyle.color, opacity: s.lineStyle.opacity }]));
    return morphRankRace({ ...landing(el, thumb, plot), lines, n: series[0].data.length, MAX: Math.round(opt.yAxis[0].max - 0.4) }, to === "thumb", ms);
  },
  // … Discovery: the card's own dots start as the thumbnail's, the same finds on the same axes squashed to its
  // height, and grow to the card's sizes as the dots the thumbnail left out grow from nothing and the names fade in
  "discovery-card": (card, el, to, ms) => {
    const thumb = echarts.getInstanceByDom(el), plot = echarts.getInstanceByDom($("chart-discovery"));
    const opt = thumb?.getOption();
    if (!opt?.series?.length || !plot) return false;
    const dots = new Map();
    for (const s of opt.series.filter(Boolean)) for (const p of s.data) dots.set(p.name, s.id === "mine" ? { size: s.symbolSize, color: p.itemStyle.color, border: s.itemStyle.borderColor } : { size: s.symbolSize });
    const [x] = opt.xAxis, [y] = opt.yAxis;
    return morphDiscovery($("chart-discovery"), { ...landing(el, thumb, plot), dots, span: [x.min, x.max], floor: y.min, top: y.max }, to === "thumb", ms);
  },

  // … When you listened: the thumbnail draws the card's own bands at its plot's shape, so the card's start as them,
  // with its thin outlines, and grow to the card's (its full-tile design, a Visual tweak, crossfades)
  "clock-card": (card, el, to, ms) => {
    const thumb = echarts.getInstanceByDom(el), plot = echarts.getInstanceByDom($("chart-clock"));
    const opt = thumb?.getOption(), series = opt?.series?.filter(Boolean); // (a series replaced away leaves a hole)
    if (tune.clockThumb || !series?.length || !plot) return false;
    const max = opt.yAxis[0].max; // (the bands' tops in the thumbnail's grid, as a share of it)
    const look = landing(el, thumb, plot), b = gridOf(plot);
    // (bands that would stand taller than the card's canvas reaches would be cut: then it crossfades)
    if ((look.y[0] + look.y[1] / max) * b.height > b.y + b.height + 0.5) return false;
    return morphClock($("chart-clock"), { ...look, n: series.length, edges: series.map((s) => s.data.map(([h, y]) => [h, y / max])) }, to === "thumb", ms);
  },

  // Top … over time, All your …, Skips and picks: the card's rows, each bar, name and number from where the thumbnail
  // draws it (rowfly.js), ranks and the rows it doesn't have fading in
  // … over time: the thumbnail is the card's rows at its playhead
  "race-card": (card, el, to, ms) => {
    const plot = $("race-rows");
    if (!settleRace()) return false;
    const sh = thumbShapes(el, plot.offsetWidth / el.offsetWidth);
    const vals = sh.get("val") ?? [];
    const at = new Map((sh.get("bar") ?? []).map((b, i) => [b.name, { bar: b.bar, name: b.label, val: vals[i]?.label }]));
    const rows = raceRows();
    if (to === "thumb" && !matches(rows, at)) return false;
    return flyRows(card, plot, rows.flatMap((r, row) => {
      const a = at.get(r.key);
      return a ? [{ el: r.bar, at: a.bar, row }, { el: r.name, at: text(a.name, "right") }, { el: r.val, at: text(a.val) }, { el: r.rank, at: null, row }] : [{ el: r.li, at: null, row }];
    }), to, ms);
  },
  // All your …: the thumbnail is the list's first rows; the rest of the list fades in below them
  "ranking-card": (card, el, to, ms) => {
    const plot = $("ranking-list");
    const sh = thumbShapes(el, plot.offsetWidth / el.offsetWidth);
    const vals = sh.get("val") ?? [];
    const at = new Map((sh.get("bar") ?? []).map((b, i) => [b.name, { bar: b.bar, name: b.label, val: vals[i]?.label }]));
    const rows = [...plot.children].map((li) => ({ key: li._key, li, rank: li.querySelector(".rank"), name: li.querySelector(".name"), bar: li._bar, val: li._val }));
    if (to === "thumb" && !matches(rows, at)) return false;
    return flyRows(card, plot, rows.flatMap((r, row) => {
      const a = at.get(r.key);
      return a ? [{ el: r.bar, at: a.bar, row }, { el: r.name, at: text(a.name) }, { el: r.val, at: text(a.val, "right") }, { el: r.rank, at: null, row }] : [{ el: r.li, at: null, row }];
    }), to, ms);
  },

  // Skips and picks: the thumbnail is the card's rows in its columns; each whole bar flies (its three parts in it)
  "skips-card": (card, el, to, ms) => {
    const plot = $("skips-list"), rows = skipsRows();
    if (!rows) return false; // (the vertical look crossfades)
    const u = plot.offsetWidth / el.offsetWidth, sh = thumbShapes(el, u);
    const get = (id, i) => sh.get(id)?.[i];
    const nameRoom = SKIPS_NAME * el.offsetWidth * u; // (a long name is cut where the thumbnail's bar begins)
    const names = skipsNow().map((r) => r.name); // (the thumbnail's rows are by place: thumbs.js)
    const at = new Map((sh.get("bar") ?? []).map((_, i) => {
      // the row's bar: its three stacked parts as one box
      const bs = ["bar", "bar-on", "bar-skip"].map((id) => get(id, i)?.bar).filter((r) => r && r.w > 0);
      const x = Math.min(...bs.map((r) => r.x)), y = Math.min(...bs.map((r) => r.y));
      const bar = bs.length ? { x, y, w: Math.max(...bs.map((r) => r.x + r.w)) - x, h: Math.max(...bs.map((r) => r.y + r.h)) - y } : null;
      return [names[i], { bar, name: get("name", i)?.label, pick: get("pick", i)?.label, skip: get("skip", i)?.label }];
    }));
    if (to === "thumb" && !matches(rows, at)) return false;
    return flyRows(card, plot, rows.flatMap((r, row) => {
      const a = at.get(r.key);
      return a ? [{ el: r.bar, at: a.bar, row }, { el: r.name, at: text(a.name, "left", nameRoom) }, { el: r.pick, at: text(a.pick) }, { el: r.skip, at: text(a.skip) }] : [{ el: r.li, at: null, row }];
    }), to, ms);
  },
  // Listening mix, Inside your top …
  // … Listening mix: each block of the thumbnail becomes its segment (place, height, corners, tint, labels), and its
  // faces fly down into their tiles in the list under the bar, the pictures it already shows (no new asks)
  "mix-card": (card, el, to, ms) => {
    const thumb = echarts.getInstanceByDom(el), bar = $("mix-bar");
    const series = thumb?.getOption()?.series ?? [];
    if (!series.length || !bar.offsetWidth || !el.clientWidth) return false;
    // the thumbnail's px in the bar's: as wide, on the same baseline
    const s = el.clientWidth / bar.offsetWidth, H = el.clientHeight, base = bar.offsetHeight;
    const y = (v) => base - (H - v) / s;
    const model = thumb.getModel();
    const blocks = new Map();
    series.forEach((sr, i) => {
      const data = model.getSeriesByIndex(i)?.getData();
      const L = data?.getItemLayout(0);
      if (!L) return;
      // (each block's 1px surface border: half of it over the fill on every side)
      blocks.set(sr.id, {
        l: (L.x + 0.5) / s, t: y(L.y + 0.5), w: Math.max(0, L.width - 1) / s, h: Math.max(0, L.height - 1) / s, r: 3 / s,
        color: data.getItemVisual(0, "style").fill, show: !!sr.label?.show,
        pct: { dy: -7 / s, k: 11 / s }, hrs: { dy: 7 / s, k: 9 / s },
      });
    });
    const faces = new Map();
    const row = el.querySelector(".thumb-faces");
    for (const [n, f] of row?.faces ?? []) {
      const img = f.querySelector("img.shown");
      if (+f.style.opacity !== 1) continue;
      const size = f.offsetWidth / s;
      faces.set(n, {
        l: (f.offsetLeft) / s, t: y(f.offsetTop + row.offsetTop), size, r: row.classList.contains("square") ? 3 / s : size / 2,
        src: img?.src, bg: f.style.background,
      });
    }
    return morphMix({ blocks, faces }, to === "thumb", ms);
  },
  // … Inside your top: the thumbnail is the card's own rings (sunLayout), round; the circle grows from the
  // thumbnail's radius and place to the card's, reaching out to the card's edges as its labels fade in
  "sunburst-card": (card, el, to, ms) => {
    const svg = el.querySelector(".thumb-sun"), plot = $("sunburst");
    if (!svg?.ids?.length || !plot.offsetWidth || !el.clientWidth) return false;
    // the thumbnail's px in the card's: as wide, on the plot's baseline (gallery.js plotBox: at most 16px above the
    // card's bottom), and the circle in the middle of the plot's svg; the thumbnail's sits right of its middle (cx)
    const s = el.clientWidth / plot.offsetWidth;
    const r = plot.getBoundingClientRect(), k = r.width / plot.offsetWidth || 1;
    const bottom = (Math.min(r.bottom, card.getBoundingClientRect().bottom - 16) - r.top) / k;
    const H = plot.querySelector(".sun-svg")?.getAttribute("height") ?? plot.offsetHeight;
    const dy = bottom - el.clientHeight / 2 / s - H / 2;
    return arriveSunburst({ R: svg.R / s, dx: (svg.cx ?? 0) / s, dy, gap: 1 / s }, svg.ids, to === "thumb", ms);
  },

  // Every play, Every day
  // … Every play: the thumbnail is the card's drawing in miniature (every.js paintRasterThumb), so its marks move by one
  // transform to the plot, the labels and guides fading in. (Drawn again first if the card changed since, a pin say.)
  "raster-card": (card, el, to, ms) => arriveRaster($("chart-raster"), el, to, ms) || (paintThumb("raster-card"), arriveRaster($("chart-raster"), el, to, ms)),
  // … Every day: the same, its boxes laid out as the card's and fitted to the tile (every.js paintCalendarThumb)
  "calendar-card": (card, el, to, ms) => arriveCalendar($("chart-calendar"), el, to, ms) || (paintThumb("calendar-card"), arriveCalendar($("chart-calendar"), el, to, ms)),

  // (end of the entries' slots)
};

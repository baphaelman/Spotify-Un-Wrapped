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

// Rank race, Discovery, When you listened

// Top … over time, All your …, Skips and picks
import { flyRows, thumbShapes } from "./rowfly.js";
import { raceRows, settleRace } from "./race.js";

// Listening mix, Inside your top …
import { morphMix } from "./mix.js";
import { arriveSunburst } from "./sunburst.js";

// Every play, Every day
import { arriveRaster, arriveCalendar } from "./every.js";
import { paintThumb } from "./thumbs.js";

// (end of the imports' slots)

// (Top … over time, All your …, Skips and picks) A thumbnail's label as flyRows' text, and whether the thumbnail draws
// the card's rows (its first ones, in order)
const text = (l, align = "left") => l && { x: align === "right" ? l.x + l.w : l.x, y: l.y + l.h / 2, w: l.w, size: l.size, align };
const matches = (rows, at) => rows.length > 0 && rows.slice(0, at.size).every((r) => at.has(r.key));

export const ARRIVALS = {
  // … Every Month: each bar its top item over one gray (the crowns thumbnail), growing the chart's other artists'
  // slices out of the gray as the colors, gap and heights turn into the card's
  "monthly-card": (card, el, to, ms) => {
    const thumb = echarts.getInstanceByDom(el);
    const [rest, top] = thumb?.getOption()?.series ?? [];
    if (!rest || !top) return false;
    // (the thumbnail's plot is squatter than the card's: its bars stand this much taller, for the same width)
    const box = (c) => c.getModel().getComponent("grid").coordinateSystem.getRect();
    const a = box(thumb), b = box(echarts.getInstanceByDom($("chart-monthly")));
    const look = {
      max: thumb.getModel().getComponent("yAxis").axis.scale.getExtent()[1], stretch: (a.height / a.width) / (b.height / b.width),
      gap: rest.barCategoryGap, rest: rest.itemStyle.color, tops: top.data.map((d) => d.itemStyle.color),
    };
    return morphMonthly($("chart-monthly"), look, to === "thumb", ms);
  },
  // Top … View, Hours per week

  // Rank race, Discovery, When you listened

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
      return a ? [{ el: r.bar, at: a.bar, row }, { el: r.name, at: text(a.name) }, { el: r.val, at: text(a.val) }, { el: r.rank, at: null, row }] : [{ el: r.li, at: null, row }];
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
    // card's bottom), and the circle in the middle of the plot's svg
    const s = el.clientWidth / plot.offsetWidth;
    const r = plot.getBoundingClientRect(), k = r.width / plot.offsetWidth || 1;
    const bottom = (Math.min(r.bottom, card.getBoundingClientRect().bottom - 16) - r.top) / k;
    const H = plot.querySelector(".sun-svg")?.getAttribute("height") ?? plot.offsetHeight;
    const dy = bottom - el.clientHeight / 2 / s - H / 2;
    return arriveSunburst({ R: svg.R / s, dy, gap: 1 / s }, svg.ids, to === "thumb", ms);
  },

  // Every play, Every day
  // … Every play: the thumbnail is the card's drawing in miniature (every.js paintRasterThumb), so its marks move by one
  // transform to the plot, the labels and guides fading in. (Drawn again first if the card changed since, a pin say.)
  "raster-card": (card, el, to, ms) => arriveRaster($("chart-raster"), el, to, ms) || (paintThumb("raster-card"), arriveRaster($("chart-raster"), el, to, ms)),
  // … Every day: the same, its boxes laid out as the card's and fitted to the tile (every.js paintCalendarThumb)
  "calendar-card": (card, el, to, ms) => arriveCalendar($("chart-calendar"), el, to, ms) || (paintThumb("calendar-card"), arriveCalendar($("chart-calendar"), el, to, ms)),

  // (end of the entries' slots)
};

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

// Listening mix, Inside your top …
import { morphMix } from "./mix.js";

// Every play, Every day

// (end of the imports' slots)

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

  // Top … over time, All your …, Skips and picks

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

  // Every play, Every day

  // (end of the entries' slots)
};

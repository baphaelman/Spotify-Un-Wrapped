// How each graph's thumbnail becomes its card in the gallery's flight (gallery.js), one entry per card.
//
// ARRIVALS: card id -> (card, thumb, to, ms) => boolean. `thumb` is the thumbnail's ECharts instance, drawn as it
// is now (its plot sits on the card's baseline, as wide as the card's plot); `to` is "thumb" (the card's plot in the thumbnail's form) or "card" (its own). It morphs the plot from what's
// on screen to `to` over ms, in-out, or draws it at once when ms is 0. The flight calls it:
//   opening: ("thumb", 0) then ("card", MORPH_MS), as the flight starts
//   closing: ("thumb", MORPH_MS) as it starts, then ("card", 0) once it lands (the card waits off screen as itself)
//   turned back midway: the other way, over the time flown so far
// Return false when it can't (the thumbnail doesn't match the card's data yet), and the flight crossfades.
//
// A card with an entry flies solid: its plot is the thumbnail from the first frame and never fades; the card's frame,
// words, controls, overlays and its chart's axes fade in around it (gallery.js). A card without one crossfades: the
// card fades in over the flying thumbnail, which fades out after.

import { $ } from "./state.js";
import { morphMonthly } from "./charts.js";

export const ARRIVALS = {
  // … Every Month: each bar its top item over one gray (the crowns thumbnail), growing the chart's other artists'
  // slices out of the gray as the colors, gap and heights turn into the card's
  "monthly-card": (card, thumb, to, ms) => {
    const o = thumb.getOption();
    const [rest, top] = o?.series ?? [];
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
};

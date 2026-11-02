// When you listened (renderClock): shares of each hour of the day, stacked as in the rolling chart's Share mode.

import { FADE_MS, ENTER_MS, MORPH_MS, EASE_IN_OUT, setOptionFaded, dur, litLook, isPinLook } from "../motion.js";
import { shownName } from "../state.js";
import { tokens, mix } from "../colors.js";
import { baseAxis, chart, instances, row, tooltipBase } from "./core.js";

// When you listened: one share stack graph across the hours of the day (every weekday together), drawn like the
// rolling chart's Share mode (bands bottom up in rank order, a pale tint of each artist's color under an outline). With
// includeOther, the rest of the time is a gray "Everyone else" band on top; without, the shares are among the artists
// shown. grid is clockBy's, by weekday and hour; the hours are summed over the week and smoothed around the day's clock
// (late night runs into the early morning) so a band doesn't jump between neighbouring hours. Pins and hover work as
// in renderMonthly (focusClock lights an artist from elsewhere): names/slots are the artists and their palette slots,
// off the deselected ones (already left out of grid's plays, so shares are of what's shown). sigma is the smoothing,
// in hours, and curve the line's rounding (ECharts' smooth).
const clockState = new WeakMap();
const hourLabel = (h) => (h % 24 === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

// Gaussian blur of a ring (the day's 24 hours)
function blurRing(v, sigma) {
  if (!(sigma > 0)) return v;
  const n = v.length, r = Math.ceil(sigma * 3);
  const w = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  return v.map((_, i) => w.reduce((s, wj, j) => s + wj * v[(i + j - r + n) % n], 0));
}

export function renderClock(el, grid, names = [], slots = [], pins = null, hover = () => {}, off = new Set(), includeOther = true, sigma = 0.5, curve = 0.3) {
  const t = tokens();
  const all = [...names, "Everyone else"];
  const colors = [...names.map((n, k) => t.series[slots[k]]), t.other];
  const otherIdx = names.length;
  const c = chart(el);
  const prev = clockState.get(el);
  const fresh = !prev || prev.names.join("\u0000") !== names.join("\u0000");

  // Hours on the day's ring (24 hours from midnight, every weekday summed) for each series, then smoothed
  const cell = (e, k) => (k < otherIdx ? e.by[k] : includeOther ? Math.max(0, e.hours - e.by.reduce((x, y) => x + y, 0)) : 0);
  const ring = all.map((_, k) => Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + cell(row[h], k), 0)));
  const smooth = ring.map((v) => blurRing(v, sigma));
  // Each hour's value sits at the middle of the hour; points go on the hour (0..24), halfway between two
  const hours = smooth.map((v) => Array.from({ length: 25 }, (_, h) => (v[(h + 23) % 24] + v[h % 24]) / 2));
  const total = Array.from({ length: 25 }, (_, h) => all.reduce((s, _n, k) => s + hours[k][h], 0));
  // Each band's share, and its bottom and top in the stack (for hover)
  const share = all.map((_, k) => total.map((tot, h) => (tot > 1e-9 ? hours[k][h] / tot : 0)));
  const bottom = all.map(() => new Array(25).fill(0));
  for (let h = 0; h < 25; h++) {
    let acc = 0;
    all.forEach((_, k) => {
      bottom[k][h] = acc;
      acc += share[k][h];
    });
  }

  const st = { names, all, colors, t, off, pinned: new Set(names.filter((n) => pins?.has(n) && !off.has(n))), hovered: prev?.hovered ?? null };
  st.zrMove = prev?.zrMove;
  st.zrOut = prev?.zrOut;
  st.zrClick = prev?.zrClick;
  clockState.set(el, st);

  const tip = (params) => {
    if (!params.length) return "";
    const h = Math.round(params[0].axisValue);
    const rows = all
      .map((n, k) => ({ k, s: share[k][h] }))
      .filter((r) => r.s >= 0.005 && !off.has(all[r.k]))
      .sort((a, b) => b.k - a.k)
      .map((r) => row(colors[r.k], (r.s * 100).toFixed(0) + "%", shownName(all[r.k]), all[r.k] === st.hovered));
    return `<div style="color:${t.muted};margin-bottom:4px">Around ${hourLabel(h)}</div>${rows.join("")}`;
  };

  setOptionFaded(
    c,
    {
      animation: true,
      animationDuration: ENTER_MS,
      animationDurationUpdate: MORPH_MS,
      animationEasingUpdate: EASE_IN_OUT.echarts,
      grid: { left: 16, right: 16, top: 8, bottom: 28 },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 }, triggerEmphasis: false },
        formatter: tip,
      },
      axisPointer: { triggerEmphasis: false },
      xAxis: {
        type: "value",
        min: 0,
        max: 24,
        interval: 3,
        ...baseAxis(t),
        axisLine: { show: false },
        splitLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => hourLabel(v) },
        axisPointer: { triggerEmphasis: false },
      },
      yAxis: { type: "value", min: 0, max: 1, ...baseAxis(t), axisLine: { show: false }, splitLine: { show: false }, axisLabel: { show: false } },
      series: all.map((n, k) => ({
        id: `c${k}`,
        name: n,
        type: "line",
        silent: true,
        symbol: "none",
        smooth: curve,
        // Stacked by hand, as in the rolling chart: each band is its top edge filled down to the axis, and the
        // bands below paint over it
        z: 2 + all.length - k,
        ...clockLook(st, k),
        data: share[k].map((s, h) => [h, bottom[k][h] + s]),
      })),
    },
    // Outlines and fills fade with the morph (deselecting an artist), rather than snapping before it
    { notMerge: fresh },
    fresh ? 0 : dur(MORPH_MS)
  );

  // Hover from the data, as in the rolling chart: the band under the pointer
  const zr = c.getZr();
  if (st.zrMove) {
    zr.off("mousemove", st.zrMove);
    zr.off("globalout", st.zrOut);
    zr.off("click", st.zrClick);
  }
  const pick = (px) => {
    if (!c.containPixel({ gridIndex: 0 }, px)) return undefined;
    const [x, y] = c.convertFromPixel({ gridIndex: 0 }, px);
    const h = Math.max(0, Math.min(24, Math.round(x)));
    for (let k = 0; k < all.length; k++) {
      if (off.has(all[k])) continue;
      if (y >= bottom[k][h] && y <= bottom[k][h] + share[k][h] && share[k][h] > 0) return all[k];
    }
    return null;
  };
  let fromPlot = false;
  st.zrMove = (e) => {
    const name = pick([e.offsetX, e.offsetY]);
    if (name === undefined) {
      if (fromPlot) hover(null);
      fromPlot = false;
      zr.setCursorStyle("default");
      return;
    }
    fromPlot = true;
    const artist = names.includes(name) ? name : null; // "Everyone else" isn't an artist to light or pin
    zr.setCursorStyle(pins && artist ? "pointer" : "default");
    if (artist !== st.hovered) {
      hover(artist);
      c.dispatchAction({ type: "showTip", x: e.offsetX, y: e.offsetY });
    }
  };
  st.zrOut = () => {
    if (fromPlot) hover(null);
    fromPlot = false;
    zr.setCursorStyle("default");
  };
  st.zrClick = (e) => {
    const name = pick([e.offsetX, e.offsetY]);
    if (name && names.includes(name)) pins?.toggle(name);
  };
  zr.on("mousemove", st.zrMove);
  zr.on("globalout", st.zrOut);
  zr.on("click", st.zrClick);
}

// The style of artist k's bands by the hover/pin rule (litLook), as in the rolling chart's Share mode: shaded by
// its look, outlined more strongly only while pinned, and the others' outlines fading into the surface (less for
// a hover than while one is pinned)
function clockLook(st, k) {
  const { t, names, colors } = st;
  const col = colors[k];
  // A deselected artist has no share, so no outline either (a flat line would still draw)
  if (k < names.length && st.off.has(names[k])) return { lineStyle: { width: 0, opacity: 0 }, areaStyle: { color: mix(t.surface, col, t.shade.rest), opacity: 1 } };
  // (the gray series, names[names.length], is never lit, only dimmed)
  const look = litLook(st.pinned, st.hovered, names[k]);
  return {
    lineStyle: { color: mix(t.surface, col, t.fade[look]), width: isPinLook(look) ? 2 : 1, opacity: 1 },
    areaStyle: { color: mix(t.surface, col, t.shade[look]), opacity: 1 },
  };
}

// Light one artist (and dim the rest) from a hover elsewhere on the page; null clears
export function focusClock(el, name) {
  const st = clockState.get(el);
  const c = instances.get(el);
  if (!st || !c) return;
  const next = name != null && st.names.includes(name) && !st.off.has(name) ? name : null;
  if (next === st.hovered) return;
  st.hovered = next;
  // Faded, as hover in the rolling chart is
  setOptionFaded(c, { series: st.all.map((n, k) => ({ id: `c${k}`, ...clockLook(st, k) })) }, undefined, dur(FADE_MS));
}

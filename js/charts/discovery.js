// Discovery (renderDiscovery): a dot per item first heard in the period, and its key.

import { FADE_MS, ENTER_MS, MORPH_MS, EASE_IN_OUT, EASE_OUT, setOptionFaded, dur, litLook, isLitLook, isPinLook } from "../motion.js";
import { shownName } from "../state.js";
import { tokens, mix } from "../colors.js";
import { esc, fmtHoursRound } from "../format.js";
import { baseAxis, chart, instances, tooltipBase } from "./core.js";
import { tune } from "../tune.js";

// The items found in the period, across it: each a dot at the day it was first played (or reached the threshold) and as high as its
// hours across everything (a log scale from `floor` hours up to `top`). The
// chart's artists among them (names, in their palette slots) take their colors and follow the hover/pin rule, and are
// named beside their dots, or, when two names would overlap, in a key right of the plot (.found-key, beside the
// chart), which hovers and pins as the dots do. The rest are one neutral tone on a canvas layer of their own, which
// dims as a whole (a fade of the layer, cheaper than restyling thousands of dots). items: [{name, t, hours, first,
// album, group}] (first: the song it was first heard through, or null; album: that song's album, or the track's;
// group: what it's colored, lit and pinned as, if not itself, so a genre's tracks: they're never named beside their
// dots, and the key always shows);
// span: the period, [start, end) times; pins is {has, toggle}; hover(name|null) reports the pointer; dot: the
// neutral dots' size in a roomy period (a crowded one shrinks them all). The pointer reads the nearest dot; a click pins it (into the chart) or unpins it.
// The neutral dots are named too, in gray, from the top down wherever a name fits clear of the others (nameRest).
// panning: drawn for a pan (state.js) about to slide the plot (panDiscovery): at once, keeping the names and key.
const discoveryState = new WeakMap();
const NEUTRAL_Z = 1, LIT_Z = 2; // canvas layers above the axes
const FOUND_GRID = { left: 56, right: 24, top: 12, bottom: 28 };
const FOUND_KEY_W = 168; // the plot's right margin while the key shows (.found-key's width and a gap)
const FOUND_LABEL = { size: 13, weight: 600, gap: 8, h: 18 };
const FOUND_ROOMY = 400; // dots per 1000px of plot drawn at full size; more, and every dot shrinks (down to half)
// The lit dots are a series per artist (their palette's size, always all of them, so ids stay put): a hover restyles
// each series as a whole, not each of a genre's thousands of tracks
const FOUND_LIT = 10;
export function renderDiscovery(el, items, span, floor, top, names = [], slots = [], pins = null, hover = () => {}, dot = 5, panning = false) {
  const t = tokens();
  dot *= Math.min(1, Math.max(0.5, Math.sqrt((FOUND_ROOMY * el.clientWidth) / 1000 / Math.max(1, items.length))));
  const c = chart(el);
  const prev = discoveryState.get(el);
  const slotOf = new Map(names.map((n, k) => [n, slots[k]]));
  const st = {
    c, t, names, slotOf, floor, top, pins, span, hover, dot, near: null, lighted: null,
    rest: items.filter((e) => !slotOf.has(groupOf(e))),
    lit: items.filter((e) => slotOf.has(groupOf(e))),
    litBy: names.slice(0, FOUND_LIT).map((n) => items.filter((e) => groupOf(e) === n)), // (each artist's own series)
    grouped: items.some((e) => e.group != null),
    litSize: items.some((e) => e.group != null) ? dot * 1.4 : dot * 2, // (a genre's many tracks smaller)
    pinned: new Set(names.filter((n) => pins?.has(n))),
    hovered: names.includes(prev?.hovered) ? prev.hovered : null,
  };
  st.keyed = panning && prev ? prev.keyed : st.grouped ? st.lit.length > 0 : st.lit.length > 1 && labelsOverlap(el, st);
  st.named = panning && prev ? prev.named : nameRest(el, st);
  discoveryState.set(el, st);
  paintFoundKey(el, st);

  const byName = new Map(items.map((e) => [e.name, e]));
  const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const fmtSpent = (h) => (h >= 1 ? fmtHoursRound(h) : `${Math.max(1, Math.round(h * 60))} min`);
  st.tip = (name) => {
    const e = byName.get(name);
    const from = e.album ? `<div style="color:${t.muted}">${e.first ? "from " : "From "}<span style="color:${t.primary}">${esc(e.album)}</span></div>` : "";
    const genre = e.group != null ? `<div style="color:${t.muted}">Genre: <span style="color:${t.primary}">${esc(e.group)}</span></div>` : "";
    const reached = e.heard != null ? `<div style="color:${t.muted}">Reached ${fmtSpent(floor)} ${fmtDay(e.t)}</div>` : "";
    return `<b>${esc(name)}</b><div style="color:${t.muted}">First heard ${fmtDay(e.heard ?? e.t)}</div>` + reached + genre +
      (e.first ? `<div style="color:${t.muted}">First song: <span style="color:${t.primary}">${esc(e.first)}</span></div>` : "") +
      from + `${fmtSpent(e.hours)} all time`;
  };
  const fresh = prev?.c !== c; // (a theme flip makes a new chart)
  const ms = fresh || panning ? 0 : dur(MORPH_MS);
  setOptionFaded(
    c,
    {
      animation: !panning, // (each frame of a pan is a plain redraw)
      animationDuration: ENTER_MS,
      animationEasing: EASE_OUT.echarts,
      animationDurationUpdate: MORPH_MS,
      animationEasingUpdate: EASE_IN_OUT.echarts,
      grid: { ...FOUND_GRID, right: st.keyed ? FOUND_KEY_W : FOUND_GRID.right },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        triggerOn: "none", // shown for the dot nearest the pointer (pointAt), with st.tip's content
      },
      xAxis: { type: "time", min: span[0], max: span[1], ...baseAxis(t), splitLine: { show: false } },
      yAxis: {
        type: "log",
        min: floor,
        max: top,
        ...baseAxis(t),
        axisLine: { show: false },
        // (the top fits the period, so it's rarely round: it goes unlabeled unless it's a power of ten)
        axisLabel: {
          color: t.muted,
          formatter: (h) => (Math.abs(h / st.top - 1) < 1e-6 && Math.abs(Math.log10(h) % 1) > 1e-6 ? "" : h < 1 ? `${+(h * 60).toPrecision(2)} min` : `${+h.toPrecision(2)} h`),
        },
      },
      series: [
        {
          id: "rest",
          type: "scatter",
          zlevel: NEUTRAL_Z,
          progressive: 0,
          symbolSize: dot,
          silent: true, // read by nearestFound
          itemStyle: { color: mix(t.surface, t.other, 0.8) },
          label: { show: false, distance: FOUND_LABEL.gap, formatter: ({ name }) => name, fontSize: REST_LABEL.size, color: t.muted },
          emphasis: { disabled: true },
          data: st.rest.map((e) => ({
            name: e.name,
            value: [e.t, Math.max(e.hours, floor)],
            ...(st.named.has(e.name) && { label: { show: true, position: foundOnLeft(st, e) ? "left" : "right" } }),
          })),
        },
        ...st.litBy.concat(Array(FOUND_LIT - st.litBy.length).fill([])).map((list, k) => ({
          ...discoveryLit(st, k),
          type: "scatter",
          zlevel: LIT_Z,
          symbolSize: st.litSize,
          // a genre's tracks (never named) drawn as one path, so a restyle is one shape, not thousands
          large: st.grouped,
          largeThreshold: 1,
          silent: true,
          emphasis: { disabled: true },
          data: list.map((e) => ({
            name: e.name,
            value: [e.t, Math.max(e.hours, floor)],
            ...(st.grouped ? {} : { label: { position: foundOnLeft(st, e) ? "left" : "right" } }),
          })),
        })),
      ],
    },
    { notMerge: fresh },
    ms
  );
  dimRest(c, st, ms);
  // The dots moved: the pointer's ring and readout wait for its next move
  st.ring = fresh ? null : prev.ring;
  if (prev) clearTimeout(prev.unlight);
  if (prev?.lighted != null) hover(null);
  if (prev?.near) {
    c.dispatchAction({ type: "hideTip" });
    st.ring?.animateTo({ style: { opacity: 0 } }, { duration: dur(FADE_MS), easing: EASE_OUT.echarts });
  }
  if (!fresh) return;

  // The pointer reads the dot nearest it, anywhere over the plot: a ring marks it, a lit one lights its artist
  // everywhere, and a click pins it into the chart (or unpins it)
  const zr = c.getZr();
  zr.on("mousemove", (e) => {
    const s = discoveryState.get(el);
    const near = nearestFound(s, e.offsetX, e.offsetY);
    zr.setCursorStyle(near && s.pins ? "pointer" : "default");
    if (near?.name === s.near?.name) return;
    pointAt(s, near);
  });
  zr.on("globalout", () => pointAt(discoveryState.get(el), null));
  zr.on("click", (e) => {
    const s = discoveryState.get(el);
    const near = nearestFound(s, e.offsetX, e.offsetY);
    if (near) s.pins?.toggle(near.group);
  });
}

// Where each item's name would sit beside its dot, as [x0, x1, y0, y1], on the plot as `rect` lays it out
let measureCtx = null;
function nameBoxes(st, rect, list, { size, weight, h }, dot) {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  measureCtx.font = `${weight} ${size}px sans-serif`; // (ECharts' default family)
  return list.map((e) => {
    const [x, y] = foundPixel(st, rect, e);
    const w = measureCtx.measureText(e.name).width, off = dot / 2 + FOUND_LABEL.gap;
    const x0 = foundOnLeft(st, e) ? x - off - w : x + off;
    return [x0, x0 + w, y - h / 2, y + h / 2];
  });
}
const plotRect = (el, keyed) => {
  const { left, right, top, bottom } = FOUND_GRID;
  return { x: left, y: top, width: el.clientWidth - left - (keyed ? FOUND_KEY_W : right), height: el.clientHeight - top - bottom };
};
const overlap = (a, b) => a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3];

// Whether any two of the lit dots' names would overlap, drawn beside their dots on the full-width plot
function labelsOverlap(el, st) {
  const boxes = nameBoxes(st, plotRect(el, false), st.lit, FOUND_LABEL, st.litSize);
  return boxes.some((a, i) => boxes.some((b, j) => j > i && overlap(a, b)));
}

// The neutral dots that get their names, in gray: from the most heard down (the top of the plot first), each where
// its name stays on the plot and clear of every dot, every name already placed and the chart's artists' names (when
// beside their dots). What's taken is kept in cells of the plot, so a name is checked only against what's near it.
const REST_LABEL = { size: 11, weight: 400, h: 14 };
const CELL = 48;
function nameRest(el, st) {
  const rect = plotRect(el, st.keyed);
  const cells = new Map();
  const near = (b, fn) => {
    for (let i = Math.floor(b[0] / CELL); i <= Math.floor(b[1] / CELL); i++)
      for (let j = Math.floor(b[2] / CELL); j <= Math.floor(b[3] / CELL); j++) if (fn(i * 4096 + j)) return true;
    return false;
  };
  const take = (b) => near(b, (k) => void (cells.get(k) ?? cells.set(k, []).get(k)).push(b));
  const clear = (b) => !near(b, (k) => cells.get(k)?.some((a) => overlap(a, b)));
  const dotBox = (e, size) => {
    const [x, y] = foundPixel(st, rect, e), r = size / 2;
    return [x - r, x + r, y - r, y + r];
  };
  st.lit.forEach((e) => take(dotBox(e, st.litSize)));
  st.rest.forEach((e) => take(dotBox(e, st.dot)));
  if (!st.keyed && !st.grouped) nameBoxes(st, rect, st.lit, FOUND_LABEL, st.litSize).forEach(take);
  const order = [...st.rest].sort((a, b) => b.hours - a.hours);
  const boxes = nameBoxes(st, rect, order, REST_LABEL, st.dot);
  const named = new Set();
  // (each name keeps tune.discoveryNameGap of room around it, so they stay sparse enough to read)
  const gap = tune.discoveryNameGap / 2;
  order.forEach((e, i) => {
    const b = boxes[i];
    if (b[0] < rect.x || b[1] > rect.x + rect.width || b[2] < rect.y || b[3] > rect.y + rect.height || !clear(b)) return;
    take([b[0] - gap, b[1] + gap, b[2] - gap, b[3] + gap]);
    named.add(e.name);
  });
  return named;
}

// A frame of a pan: the plot shows the times `span` and the hours up to `top`, its dots (drawn for the pan) sliding
// under it
export function panDiscovery(el, span, top) {
  const st = discoveryState.get(el);
  if (!st || st.c !== instances.get(el)) return;
  st.span = span;
  st.top = top;
  st.c.setOption({ xAxis: { min: span[0], max: span[1] }, yAxis: { max: top } }, { lazyUpdate: false });
}
const groupOf = (e) => e.group ?? e.name;
// (named on the left near the right end, where there's no room after it)
const foundOnLeft = (st, e) => (e.t - st.span[0]) / (st.span[1] - st.span[0]) > 0.8;

// The key right of the plot, while the names would overlap: the lit artists in the period bar's order, each
// after a dash of its color. HTML, so a long name ellipsizes; hovering one is hovering its dot, a click pins it.
function paintFoundKey(el, st) {
  const box = el.parentElement.querySelector(".found-key");
  if (!box) return;
  box._st = st;
  if (!box._wired) {
    box._wired = true;
    const nameAt = (e) => e.target.closest(".found-name")?.dataset.artist ?? null;
    box.addEventListener("pointerover", (e) => box._st.hover(nameAt(e)));
    box.addEventListener("pointerleave", () => box._st.hover(null));
    box.addEventListener("click", (e) => {
      const name = nameAt(e);
      if (name != null) box._st.pins?.toggle(name);
    });
  }
  box.classList.toggle("on", st.keyed);
  const here = new Set(st.lit.map(groupOf));
  const order = st.names.filter((n) => here.has(n));
  const have = new Map([...box.children].map((n) => [n.dataset.artist, n]));
  box.replaceChildren(
    ...order.map((name) => {
      let n = have.get(name);
      if (!n) {
        n = document.createElement("div");
        n.className = "found-name";
        n.dataset.artist = name;
        n.textContent = shownName(name); // artist names come from user files
      }
      n.style.setProperty("--c", st.t.series[st.slotOf.get(name)]);
      return n;
    })
  );
  lightFoundKey(st, box);
}
function lightFoundKey(st, box) {
  for (const n of box?.children ?? []) {
    const name = n.dataset.artist, pinned = st.pinned.has(name);
    n.classList.toggle("pinned", pinned);
    n.classList.toggle("focus", st.hovered === name);
    n.classList.toggle("dimmed", !isLitLook(litLook(st.pinned, st.hovered, name)) && (st.pinned.size > 0 || st.hovered != null));
    n.title = `${pinned ? "Unpin" : "Pin"} ${shownName(name)}`;
  }
}

// Where an item's dot sits in pixels, worked out from the axes as they're set (cheaper than asking ECharts for each)
function foundPixel(st, rect, e) {
  const [lo, hi] = st.span, ly = Math.log(st.floor), ry = Math.log(st.top) - ly;
  return [rect.x + ((e.t - lo) / (hi - lo)) * rect.width, rect.y + rect.height - ((Math.log(Math.max(e.hours, st.floor)) - ly) / ry) * rect.height];
}

// The dot nearest a pixel over the plot, as { name, lit, index, x, y }, or null off the plot
function nearestFound(st, x, y) {
  if (!st || !st.c.containPixel({ gridIndex: 0 }, [x, y])) return null;
  const rect = st.c.getModel().getComponent("grid").coordinateSystem.getRect();
  let best = null, bestD = Infinity;
  [st.rest, ...st.litBy].forEach((list, s) => {
    list.forEach((e, index) => {
      const [px, py] = foundPixel(st, rect, e);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bestD) [best, bestD] = [{ name: e.name, group: groupOf(e), lit: s > 0, series: s, index, x: px, y: py }, d];
    });
  });
  return best;
}

// Light an artist across the page from the pointer (null: none), only when that changes: lighting restyles every
// graph. Passing over a gray dot (soft) clears it only once the pointer rests there, so a sweep through a genre's
// tracks doesn't flicker the whole page between each of them.
function lightFound(st, group, soft) {
  clearTimeout(st.unlight);
  if (group == null && soft && st.lighted != null) {
    st.unlight = setTimeout(() => lightFound(st, null, false), FADE_MS);
    return;
  }
  if (group === st.lighted) return;
  st.lighted = group;
  st.hover(group);
}

// Point at a dot (or nothing): its readout, a ring that glides to it, and its artist lit if it's one of the chart's
function pointAt(st, near) {
  if (!st) return;
  st.near = near;
  const { c, t } = st;
  lightFound(st, near?.lit ? near.group : null, near != null);
  if (!near) {
    c.dispatchAction({ type: "hideTip" });
    st.ring?.animateTo({ style: { opacity: 0 } }, { duration: dur(FADE_MS), easing: EASE_OUT.echarts });
    return;
  }
  // (at the dot, with its content: a large series keeps no place per dot for ECharts to find)
  const html = st.tip(near.name);
  c.dispatchAction({ type: "showTip", x: near.x, y: near.y, tooltip: { formatter: () => html } });
  const r = (near.lit ? st.litSize : st.dot) / 2 + 4;
  const stroke = near.lit ? t.series[st.slotOf.get(near.group)] : t.primary;
  if (!st.ring) {
    st.ring = new echarts.graphic.Circle({ shape: { cx: near.x, cy: near.y, r }, style: { fill: null, stroke, lineWidth: 1.5, opacity: 0 }, zlevel: LIT_Z + 1, silent: true });
    c.getZr().add(st.ring);
  }
  const ms = dur(FADE_MS), easing = EASE_OUT.echarts;
  // From nothing it appears where it points; from another dot it glides over
  if ((st.ring.style.opacity ?? 1) < 0.05) st.ring.attr({ shape: { cx: near.x, cy: near.y, r } });
  st.ring.stopAnimation();
  st.ring.animateTo({ shape: { cx: near.x, cy: near.y, r }, style: { stroke, opacity: 1 } }, { duration: ms, easing });
}

// The lit dots by the hover/pin rule: a light shade of the color at rest, deeper hovered, the color in full with a
// thicker edge pinned, and faded while another is lit (by the --dim-item tokens, so they stay easy to make out)
// (series k, the k-th of the chart's artists: its look, set on the series as a whole)
function discoveryLit(st, k) {
  const { t } = st, name = st.names[k];
  if (k >= st.litBy.length) return { id: `lit${k}` };
  const col = t.series[st.slotOf.get(name)];
  const look = litLook(st.pinned, st.hovered, name);
  const fill = isLitLook(look) ? col : mix(t.surface, col, t.dimItem[look]);
  return {
    id: `lit${k}`,
    // named in the ink, faded as the dot is, unless the key names them
    label: {
      show: !st.grouped,
      distance: FOUND_LABEL.gap,
      formatter: ({ name }) => name,
      fontSize: FOUND_LABEL.size,
      fontWeight: FOUND_LABEL.weight,
      color: mix(t.surface, t.primary, t.dimItem[look]),
      opacity: st.keyed ? 0 : 1,
    },
    itemStyle: { color: fill, borderColor: mix(t.surface, col, t.dimItem[look]), borderWidth: isPinLook(look) ? 3 : 1 },
  };
}

// The neutral dots' layer fades as a whole (by the --dim-item tokens): a little while one of the chart's artists is
// hovered, more while one is pinned
function dimRest(c, st, ms) {
  const layer = c.getZr().painter.getLayer?.(NEUTRAL_Z)?.dom;
  if (!layer) return;
  const look = st.pinned.size ? "dim" : st.hovered != null ? "dimHover" : "rest";
  layer.style.transition = `opacity ${ms}ms ${EASE_OUT.css}`;
  layer.style.opacity = st.t.dimItem[look];
}

// Light one artist (and dim the rest) from a hover elsewhere on the page; null clears
export function focusDiscovery(el, name) {
  const st = discoveryState.get(el);
  const c = instances.get(el);
  if (!st || !c) return;
  const next = name != null && st.names.includes(name) ? name : null;
  if (next === st.hovered) return;
  st.hovered = next;
  setOptionFaded(c, { series: st.litBy.map((_, k) => discoveryLit(st, k)) }, undefined, dur(FADE_MS));
  dimRest(c, st, dur(FADE_MS));
  lightFoundKey(st, el.parentElement.querySelector(".found-key"));
}

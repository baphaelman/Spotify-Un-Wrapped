// What every ECharts graph shares: one instance per element (dropped on a theme flip), the axes, and the hover
// cards beside the pointer.

import { esc } from "../format.js";

export const instances = new Map();

export function chart(el) {
  let c = instances.get(el);
  if (!c) {
    c = echarts.init(el, null, { renderer: "canvas" });
    instances.set(el, c);
    // (only when the size differs from the canvas's: the hours strip resizes its canvas itself, see sizeStrip)
    new ResizeObserver(() => (el.clientWidth !== c.getWidth() || el.clientHeight !== c.getHeight()) && c.resize()).observe(el);
  }
  return c;
}

// Theme changed: throw away instances so the next render picks up new tokens.
export function disposeAll() {
  for (const c of instances.values()) c.dispose();
  instances.clear();
}

export function baseAxis(t) {
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.muted },
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
  };
}

export function tooltipBase(t) {
  return {
    backgroundColor: t.surface,
    borderColor: t.grid,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: t.primary, fontSize: 13 },
    extraCssText: "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);",
    position: tipBeside,
  };
}

// A hover card beside the pointer (right and below it, or left where there's no room), kept inside the window and
// under the sticky period bar: a long readout (a split chart lists many parts) would otherwise run off the screen.
// Taller than the room, it starts at the top of it (fitTip keeps the rolling chart's readout from getting there)
const TIP_EDGE = 8;
const tipRoom = () => {
  const bar = document.querySelector(".filters.sticky")?.getBoundingClientRect().bottom ?? 0;
  return { top: Math.max(0, bar) + TIP_EDGE, bottom: innerHeight - TIP_EDGE };
};
function tipBeside(point, _params, dom, _rect, size) {
  const GAP = 16, EDGE = TIP_EDGE;
  const [w, h] = size.contentSize;
  const box = dom.parentElement.getBoundingClientRect();
  const { top, bottom } = tipRoom();
  let x = box.left + point[0] + GAP;
  if (x + w > innerWidth - EDGE) x = box.left + point[0] - GAP - w;
  x = Math.max(EDGE, Math.min(x, innerWidth - EDGE - w));
  const y = Math.max(top, Math.min(box.top + point[1] + GAP, bottom - h));
  return [x - box.left, y - box.top];
}

// Line-key row: value leads, label follows. `strong` picks out the row under the pointer.
export const row = (color, value, label, strong = false) =>
  `<div style="display:flex;align-items:center;gap:8px;line-height:1.6;${strong ? `background:${color}26;margin:0 -6px;padding:0 6px;border-radius:4px` : ""}">` +
  `<span style="width:12px;height:${strong ? 4 : 2}px;background:${color};border-radius:1px"></span>` +
  `<b style="min-width:3.5em">${value}</b><span style="${strong ? "font-weight:600" : "opacity:.75"}">${esc(label)}</span></div>`;

// A part's row (an album or song) under its artist's: indented and quieter
// (strong: the part under the pointer)
export const subRow = (color, value, label, strong = false) =>
  `<div style="display:flex;align-items:center;gap:8px;line-height:1.5;padding-left:20px;font-size:12px;${strong ? `background:${color}66;margin:0 -6px;padding-right:6px;padding-left:26px;border-radius:4px` : ""}">` +
  `<span style="width:8px;height:8px;background:${color};border-radius:2px"></span>` +
  `<b style="min-width:3.5em;font-weight:500">${value}</b><span style="${strong ? "font-weight:600" : "opacity:.75"}">${esc(label)}</span></div>`;

// The rows of a readout listing each artist with its parts under it, cut to fit the window: while it's taller than
// the room under the period bar, the smallest part (by `size`, the same measure for every artist) gives way, and each
// artist that lost some ends with one row counting them, `more(group, gone)` its [value, label]. Artists always stay.
// groups: [{ head: row html, parts: [{ html, size, ... }] }]. Heights are the rows' own (row, subRow), estimated
const TIP_ROW_H = 13 * 1.6, TIP_SUB_H = 12 * 1.5, TIP_FRAME_H = 2 * 8 + 2 + 24; // padding, border, the date line
export function fitTip(groups, more) {
  const { top, bottom } = tipRoom();
  const room = bottom - top - TIP_FRAME_H;
  const cut = groups.map(() => new Set());
  const height = () =>
    groups.reduce((h, g, k) => h + TIP_ROW_H + (g.parts.length - cut[k].size + (cut[k].size ? 1 : 0)) * TIP_SUB_H, 0);
  const left = groups.flatMap((g, k) => g.parts.map((p, j) => ({ k, j, size: p.size }))).sort((a, b) => a.size - b.size);
  for (const p of left) {
    if (height() <= room) break;
    cut[p.k].add(p.j);
  }
  // One part counted in its own row saves nothing, so it's shown after all
  for (const c of cut) if (c.size === 1) c.clear();
  return groups.flatMap((g, k) => {
    const kept = g.parts.filter((_, j) => !cut[k].has(j)).map((p) => p.html);
    if (!cut[k].size) return [g.head, ...kept];
    const gone = g.parts.filter((_, j) => cut[k].has(j));
    return [g.head, ...kept, subRow("transparent", ...more(g, gone))];
  });
}

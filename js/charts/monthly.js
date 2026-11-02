// Top Artists Every Month (renderMonthly): stacked bars, their captions and the lines under them.

import { FADE_MS, ENTER_MS, MORPH_MS, EASE_IN_OUT, setOptionFaded, dur, litLook, isPinLook } from "../motion.js";
import { tune } from "../tune.js";
import { tokens, mix } from "../colors.js";
import { fmtHoursRound } from "../format.js";
import { baseAxis, chart, instances, row, tooltipBase } from "./core.js";

// Total hours per month (or per `span` months), stacked: the month's top artist on top of each bar, filled in strongly and captioned
// above it where there's room; below them the chart's other artists in a lighter tint; and at the base everyone
// else in gray. Artists with less than FOLD of a month are folded into the gray, so small slices don't clutter
// it, unless they're lit (pinned, or hovered anywhere on the page, through focusMonthly): then they show, filled
// in and outlined, while the rest dim. Hovering a month lists its top five. names/slots are the chart's artists
// and their palette slots; pins is {has, toggle}; hover(name|null) reports the pointer; off holds deselected
// artists (never lit). other: false leaves everyone else out, so each bar is only the chart's artists and its
// top artist is the biggest of them.
const FOLD = 0.03;
const monthlyState = new WeakMap();
export function renderMonthly(el, rows, names = [], slots = [], pins = null, hover = () => {}, off = new Set(), span = 1, other = true) {
  const t = tokens();
  const short = (d) => d.toLocaleDateString(undefined, { month: "short" });
  // A bar's period: "Mar 2024", "Jan–Jun 2024", "2024" or "2024–2025"
  const label = (d) =>
    span === 24
      ? `${d.getFullYear()}–${d.getFullYear() + 1}`
      : span === 12
        ? String(d.getFullYear())
        : span > 1
          ? `${short(d)}–${short(new Date(d.getFullYear(), d.getMonth() + span - 1, 1))} ${d.getFullYear()}`
          : d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  // Months: every month's name. Years: every bar. Quarters and halves: each January with its year.
  const tick = (r) =>
    span === 1 ? short(r.month) : span >= 12 || r.month.getMonth() === 0 ? String(r.month.getFullYear()) : "";
  const grid = { left: 48, right: 16, top: 28, bottom: 32 };
  // Room for a caption above each bar; too narrow and they're left off (the tooltip still names the top artist)
  const slotW = rows.length ? (el.clientWidth - grid.left - grid.right) / rows.length : 0;
  const caption = slotW >= 56;
  const slotOf = new Map(names.map((n, k) => [n, slots[k]]));
  const colorOf = (n) => (slotOf.has(n) ? t.series[slotOf.get(n)] : t.other);
  const c = chart(el);
  const prev = monthlyState.get(el);
  // A new bar size changes every bar, so the chart draws afresh rather than morphing bars into unrelated ones
  const fresh = !prev || prev.span !== span || prev.names.join("\u0000") !== names.join("\u0000");
  // last: each series' values on screen (see settleMonthly)
  // Captions: the top artist's name, in one row along the top of the plot above every column, with room for every
  // line a caption can take
  if (caption) grid.top += (CAP_LINES - 1) * CAP_LINE_H;
  const st = { names, rows, span, other, t, off, pins, colorOf, underline: caption, grid, hovered: prev?.hovered ?? null, picked: prev?.picked ?? null, full: prev?.full ?? null, fullNext: prev?.full ?? null, last: fresh ? null : prev.last };
  monthlyState.set(el, st);
  // Bars morph until then; a hover's setOption before it would restart their easing (see focusMonthly)
  st.busyUntil = fresh ? 0 : performance.now() + dur(MORPH_MS);
  const captionOf = (r) => barView(st, r).top[0]?.name ?? "";
  const bar = { type: "bar", stack: "month", barCategoryGap: `${tune.barGap}%` };
  const looks = monthlySeries(st);
  // New artists over the same bars (a pin, the artist count): the bars stand still and only who fills them
  // changes, so the old chart fades out over the new one instead of the bars growing in again
  const crossfade =
    fresh && prev && prev.span === span && prev.rows.length === rows.length && +prev.rows[0]?.month === +rows[0]?.month && dur(MORPH_MS) > 0;
  // Rebuilding under an open tooltip (a click pinning a new artist in) leaves it filling a removed element
  if (fresh && prev) c.dispatchAction({ type: "hideTip" });
  if (crossfade) fadeOutFrame(el, t.surface);
  setOptionFaded(
    c,
    {
      animation: !crossfade,
      animationDuration: ENTER_MS,
      animationDurationUpdate: MORPH_MS,
      animationEasingUpdate: EASE_IN_OUT.echarts,
      grid,
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        // The tooltip follows the column, without shading it
        axisPointer: { type: "none" },
        formatter: (ps) => {
          const r = rows[ps[0].dataIndex];
          const { hours, top } = barView(st, r);
          const head = `<div style="margin-bottom:4px"><b>${label(r.month)}</b> <span style="opacity:.75">${fmtHoursRound(hours)}</span></div>`;
          if (!hours) return head;
          const lit = litSet(st);
          const pct = (h) => `${Math.round((h / hours) * 100)}%`;
          // Lit artists outside the month's top five follow it
          const extra = names
            .map((n, k) => ({ name: n, hours: r.by[k] }))
            .filter((a) => lit.has(a.name) && a.hours > 0 && !top.some((x) => x.name === a.name));
          return head + [...top, ...extra].map((a) => row(colorOf(a.name), pct(a.hours), a.name, lit.has(a.name))).join("");
        },
      },
      xAxis: [
        {
          type: "category",
          data: rows.map(tick),
          ...baseAxis(t),
          axisLabel: { color: t.muted, interval: 0 },
          axisPointer: { triggerEmphasis: false },
          splitLine: { show: false },
        },
        {
          type: "category",
          position: "top",
          data: rows.map(captionOf),
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisPointer: { show: false },
          // Drawn as elements instead (paintCaptionMarks), so a lit artist's name can fade to the main ink
          axisLabel: { show: false },
        },
      ],
      yAxis: {
        type: "value",
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => `${v} h` },
      },
      series: [
        { ...looks[0], name: "Everyone else", ...bar, silent: true },
        ...[...names, ...names].map((n, j) => ({ ...looks[j + 1], name: n, ...bar, cursor: pins ? "pointer" : "default" })),
        { ...looks[2 * names.length + 1], name: "Top artist", ...bar },
      ],
    },
    // Colors and outlines fade with the bars' morph rather than snapping before it
    { notMerge: fresh },
    fresh ? 0 : dur(MORPH_MS)
  );
  // The gray top series' artist is each bar's top one (looked up, not named in its data: ECharts matches data by
  // name, so a bar whose name changed would fade out where it stood instead of morphing with the others)
  const artistOf = (p) => (p.seriesId === "top" ? barView(st, rows[p.dataIndex]).top[0]?.name : p.seriesName);
  settleMonthly(el, st, looks);
  paintUnderlines(el, st);
  // The pointer picks the artist whose slice it's over; anywhere else in a column, it picks the column's top
  // artist, so hovering or clicking the column is hovering or clicking them. A top artist outside the chart can
  // be picked too: clicking pins them into it, but only the chart's artists light up on hover (shared with the
  // rest of the page). ECharts reports the slice (mouseover/out) before zrender's mousemove, which then works
  // out the pick. A pin re-renders the chart without moving the pointer, so the slice under it carries over, and
  // a click works out its own pick.
  // `lit` is the artist last reported to hover(): only the chart's artists, carried over a re-render so it's
  // cleared when the pointer leaves
  const pickable = (n) => n != null && !off.has(n);
  let slice = pickable(prev?.slice?.()) ? prev.slice() : null;
  let lit = prev?.lit?.() ?? null;
  st.slice = () => slice;
  st.lit = () => lit;
  // A column runs from the top of the card down to the axis, so the space above the bars (where the captions sit,
  // outside the plot) and the card's header beside the title answer too, tooltip and all: ECharts only shows it
  // inside the plot, so it's asked for there
  let tipAbove = null;
  const pick = (x, y) => {
    let n = slice;
    const inColumn = x >= grid.left && x <= el.clientWidth - grid.right && y <= el.clientHeight - grid.bottom;
    const i = inColumn ? Math.round(c.convertFromPixel({ gridIndex: 0 }, [x, Math.max(y, grid.top)])[0]) : null;
    if (n == null && rows[i]) {
      const top = barView(st, rows[i]).top[0]?.name;
      if (pickable(top)) n = top;
    }
    // Asked for on every move, since ECharts hides it again whenever the pointer moves outside the plot
    const above = rows[i] && y < grid.top ? i : null;
    if (above != null) c.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: above });
    else if (tipAbove != null && !c.containPixel("grid", [x, y])) c.dispatchAction({ type: "hideTip" });
    tipAbove = above;
    c.getZr().setCursorStyle(n != null && pins ? "pointer" : "default");
    const l = names.includes(n) ? n : null;
    if (l !== lit) hover((lit = l));
    if (n !== st.picked) {
      st.picked = n;
      paintCaptionMarks(el, st);
    }
    return n;
  };
  const leave = () => {
    slice = null;
    if (st.picked != null) {
      st.picked = null;
      paintCaptionMarks(el, st);
    }
    if (lit != null) hover((lit = null));
    if (tipAbove != null) c.dispatchAction({ type: "hideTip" });
    tipAbove = null;
  };
  const zr = c.getZr();
  if (prev?.zr) for (const [ev, fn] of Object.entries(prev.zr)) zr.off(ev, fn);
  st.zr = {
    mousemove: (e) => pick(e.offsetX, e.offsetY),
    globalout: leave,
    click: (e) => {
      const n = pick(e.offsetX, e.offsetY);
      if (n != null) pins?.toggle(n);
    },
  };
  for (const [ev, fn] of Object.entries(st.zr)) zr.on(ev, fn);
  // The card around the chart, outside it: its controls and text keep to themselves, the rest is the column below
  const card = el.closest(".card");
  if (prev?.card) for (const [ev, fn] of Object.entries(prev.card)) card?.removeEventListener(ev, fn);
  const fromCard = (e) => {
    if (el.contains(e.target)) return undefined; // the chart's own handlers have it
    const r = el.getBoundingClientRect();
    const own = e.target.closest("h2, p, label, button, input, a");
    const n = own ? (leave(), null) : pick(e.clientX - r.left, e.clientY - r.top);
    card.style.cursor = n != null && pins ? "pointer" : "";
    return n;
  };
  st.card = card && {
    pointermove: fromCard,
    pointerleave: () => {
      card.style.cursor = "";
      leave();
    },
    click: (e) => {
      const n = fromCard(e);
      if (n != null) pins?.toggle(n);
    },
  };
  if (card) for (const [ev, fn] of Object.entries(st.card)) card.addEventListener(ev, fn);
  c.off("mouseover");
  c.off("mouseout");
  c.off("click");
  c.on("mouseover", (p) => (slice = pickable(artistOf(p)) ? artistOf(p) : null));
  c.on("mouseout", () => (slice = null));
}

// Lay a copy of the chart's current frame over it and fade it out (MORPH_MS), so whatever is drawn next crossfades
// in. A copy still fading from an earlier call is folded into the new one, at the opacity it has reached.
function fadeOutFrame(el, background) {
  const src = el.querySelector("canvas");
  if (!src) return;
  const copy = document.createElement("canvas");
  copy.width = src.width;
  copy.height = src.height;
  const ctx = copy.getContext("2d");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, copy.width, copy.height);
  ctx.drawImage(src, 0, 0);
  for (const old of el.querySelectorAll(".chart-fade")) {
    ctx.globalAlpha = +getComputedStyle(old).opacity;
    ctx.drawImage(old, 0, 0);
    old.remove();
  }
  copy.className = "chart-fade";
  Object.assign(copy.style, { position: "absolute", left: 0, top: 0, width: src.style.width, height: src.style.height, pointerEvents: "none", zIndex: 1 });
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  el.append(copy);
  copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MORPH_MS, easing: EASE_IN_OUT.css, fill: "forwards" }).finished.then(
    () => copy.remove(),
    () => {}
  );
}

// The artists in the spotlight: the pinned ones, and the one hovered
const pinnedSet = (st) => new Set(st.names.filter((n) => st.pins?.has(n) && !st.off.has(n)));
function litSet(st) {
  const lit = pinnedSet(st);
  if (st.hovered != null) lit.add(st.hovered);
  return lit;
}
// How much of an artist's color fills their slices in each look of the hover/pin rule (litLook): deeper than the
// rolling chart's tints, since a slice is small
const MONTH_SHADE = { rest: 0.25, hover: 0.38, pin: 0.5, pinHover: 0.62, dim: 0.1, dimHover: 0.16 };

// A bar's total and its top five, [{ name, hours }]: of everyone, or only of the chart's artists when everyone
// else is left out
function barView(st, r) {
  if (st.other) return { hours: r.hours, top: r.top };
  const own = st.names.map((name, k) => ({ name, hours: r.by[k] })).filter((a) => a.hours > 0);
  return { hours: own.reduce((s, a) => s + a.hours, 0), top: own.sort((a, b) => b.hours - a.hours).slice(0, 5) };
}

// The series' ids, data and styles, bottom to top: the gray remainder (rest), each chart artist's slices (m{k}),
// each chart artist's top-of-the-month block (t{k}), then the top block of a month whose top artist isn't in the
// chart (top, gray). Giving every artist their own top series keeps a region theirs when they stop being on
// top (deselected, say), so it shrinks away instead of turning into someone else's. A small artist's slice is
// folded into the gray unless they're lit, so lighting one grows their slices out of it. Without everyone else
// there's no gray to fold into, so every slice shows and the gray shrinks away.
function monthlySeries(st) {
  const { t, names, rows, colorOf } = st;
  const lit = litSet(st);
  const pinned = pinnedSet(st);
  const fill = (col, look) => mix(t.surface, col, MONTH_SHADE[look]);
  // A hairline in the surface color between slices, or the artist's color around a pinned one (only a pin outlines)
  const edge = (col, on) => (on ? { borderColor: col, borderWidth: 1.5 } : { borderColor: t.surface, borderWidth: 1 });
  const radius = { borderRadius: [1.5, 1.5, 0, 0] };
  // A zero-height bar still strokes its outline, so an emptied bar keeps it only while it shrinks (settleMonthly
  // takes it off after)
  const items = (id, values) =>
    values.map((v, i) => ({ value: v, ...(v > 0 || st.last?.get(id)?.[i] > 0 ? {} : { itemStyle: { borderWidth: 0 } }) }));
  const tops = rows.map((r) => barView(st, r).top[0]);
  const shown = names.map((n, k) =>
    rows.map((r, i) => n !== tops[i]?.name && r.by[k] > 0 && (!st.other || lit.has(n) || r.by[k] >= FOLD * r.hours))
  );
  const rest = rows.map((r, i) => {
    if (!st.other) return 0;
    const slices = names.reduce((s, _n, k) => s + (shown[k][i] ? r.by[k] : 0), 0);
    return Math.max(0, r.hours - slices - (tops[i]?.hours ?? 0));
  });
  const slices = names.map((n, k) => {
    const look = litLook(pinned, st.hovered, n);
    const col = colorOf(n);
    return {
      id: `m${k}`,
      itemStyle: { color: fill(col, look), ...edge(col, isPinLook(look)) },
      data: items(`m${k}`, rows.map((r, i) => (shown[k][i] ? r.by[k] : 0))),
    };
  });
  // Always drawn like a pinned artist, so lighting another doesn't dim them
  const topBlocks = names.map((n, k) => ({
    id: `t${k}`,
    itemStyle: { color: fill(colorOf(n), "pin"), ...edge(colorOf(n), true), ...radius },
    data: items(`t${k}`, rows.map((r, i) => (tops[i]?.name === n ? r.by[k] : 0))),
  }));
  // A top artist outside the chart has no color of their own: a lighter gray than the rest, without an outline
  const uncharted = rows.map((r, i) => (tops[i] && !names.includes(tops[i].name) ? tops[i].hours : 0));
  const top = { id: "top", itemStyle: { color: mix(t.surface, t.other, 0.6), ...edge(t.other, false), ...radius }, data: items("top", uncharted) };
  // The gray never dims either: it's the rest of the month, whoever is lit
  const gray = { id: "rest", itemStyle: { color: mix(t.surface, t.other, 0.35), ...edge(t.other, false) }, data: rest };
  return [gray, ...slices, ...topBlocks, top];
}

// Under a caption whose artist is in the chart, a line in their color across their bar's column, all one length and
// thickness, never dimmed (a top artist stays as strong whoever is lit). Neighbouring lines join into one strip,
// rounded only at its two ends. They're elements over the chart rather than shapes in it, so CSS tweens them: a
// strip that comes or goes (an artist selected, deselected or pinned in) grows from or shrinks to a point in its
// middle; lines joining or leaving a strip that stays grow from or shrink to their seam with it; the strips'
// lengths morph with the bars. still: place them without tweening (a resize).
const LINE_H = 2;
function paintUnderlines(el, st, still = false) {
  const c = instances.get(el);
  let layer = el.querySelector(".month-lines");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "month-lines";
    // (placed here as well as in the stylesheet, so a cached stylesheet can't drop them in a heap)
    Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: 2 });
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    el.appendChild(layer);
    new ResizeObserver(() => monthlyState.has(el) && paintUnderlines(el, monthlyState.get(el), true)).observe(el);
  }
  const { rows, grid, names, off } = st;
  const who = rows.map((r) => {
    const n = barView(st, r).top[0]?.name;
    return st.underline && names.includes(n) && !off.has(n) ? n : null;
  });
  // What was drawn last ({ who, rects }), if it was over the same bars
  const before = layer._drawn?.who.length === rows.length ? layer._drawn : null;
  const was = before?.who ?? who.map(() => null);
  const slot = (el.clientWidth - grid.left - grid.right) / Math.max(1, rows.length);
  const bottom = `${el.clientHeight - grid.top + 4}px`;
  layer.classList.toggle("still", still);
  while (layer.children.length > rows.length) layer.lastChild.remove();
  while (layer.children.length < rows.length) {
    const d = layer.appendChild(document.createElement("div"));
    Object.assign(d.style, { position: "absolute", width: "0px", height: `${LINE_H}px`, bottom });
  }
  // Each line's [left, right]: its bar's whole column, halfway into the gaps either side, so lines keep one length
  // whatever their neighbours do (a joined one reaches half a pixel further left, so the seam doesn't show)
  const rects = who.map((n, i) => {
    if (n == null) return null;
    const mid = c ? c.convertToPixel({ xAxisIndex: 0 }, i) : grid.left + slot * (i + 0.5);
    return [mid - slot / 2 - (who[i - 1] != null ? 0.5 : 0), mid + slot / 2];
  });
  // Where a run of lines that come (or go) grows from (or shrinks to): its seam with the part of its strip that
  // stays, else the run's middle. inRun picks the run; at holds where each of its lines is (or was)
  const stays = (j) => who[j] != null && was[j] != null;
  const anchor = (i, inRun, at) => {
    let p = i, q = i;
    while (inRun(p - 1)) p--;
    while (inRun(q + 1)) q++;
    if (stays(p - 1)) return at[p][0];
    if (stays(q + 1)) return at[q][1];
    return (at[p][0] + at[q][1]) / 2;
  };
  const place = (d, l, r) => Object.assign(d.style, { left: `${l}px`, width: `${Math.max(0, r - l)}px` });
  // Lines that come jump to their anchor first, untweened
  const coming = [];
  who.forEach((n, i) => {
    if (n == null || was[i] != null || still) return;
    const x = anchor(i, (j) => who[j] != null && was[j] == null, rects);
    const d = layer.children[i];
    d.style.transition = "none";
    place(d, x, x);
    coming.push(d);
  });
  if (coming.length) void layer.offsetWidth;
  for (const d of coming) d.style.transition = "";
  who.forEach((n, i) => {
    const d = layer.children[i];
    if (n == null) {
      // Gone: shrinks to its anchor, keeping its color and ends
      if (was[i] != null && !still) {
        const x = anchor(i, (j) => was[j] != null && who[j] == null, before.rects);
        place(d, x, x);
      } else d.style.width = "0px";
      return;
    }
    const rl = who[i - 1] != null ? 0 : LINE_H / 2, rr = who[i + 1] != null ? 0 : LINE_H / 2;
    place(d, ...rects[i]);
    Object.assign(d.style, {
      bottom,
      height: `${LINE_H}px`,
      borderRadius: `${rl}px ${rr}px ${rr}px ${rl}px`,
      background: st.colorOf(n),
    });
  });
  layer._drawn = { who, rects };
  paintCaptionMarks(el, st);
}

// The captions (each column's top artist), and behind them a wash over the columns of the pinned artists and of the
// one a click would pin or unpin (the one the pointer picks, or one hovered elsewhere on the page), the same for
// both, so pinning keeps what hovering showed. It runs from above the caption down to the axis and rises from it
// (sinks back into it); neighbouring washes join into one, rounded only at its outer corners. A lit artist's name
// brightens. They're elements over the chart, so CSS tweens them.
// A caption takes up to CAP_LINES lines of the name shortened by cleanName; where that still leaves some of it out,
// hovering shows it whole (paintFullNames).
const CAP_LINES = 3, CAP_LINE_H = 13;
// A track or album name without what's usually tacked on: "(feat. …)", "[with …]", "(Radio Edit)", "- Remastered 2011"
const ADDED = [
  /\s*[([](?:feat\.?|ft\.?|with|prod\.?|from)\s[^)\]]*[)\]]/gi,
  /\s*[([][^)\]]*\b(?:remaster(?:ed)?|version|edit|mix|live|mono|stereo|deluxe|bonus)\b[^)\]]*[)\]]/gi,
  /\s+[-–—]\s+.*\b(?:remaster(?:ed)?|version|edit|mix|live|mono|stereo|deluxe|bonus|from)\b.*$/gi,
];
const cleanName = (s) => ADDED.reduce((a, re) => a.replace(re, ""), s).trim() || s;
// A name too wide for its column, in up to n lines, broken at a space (or between any two characters in a name
// without one: Chinese, Japanese), never inside a word. When it fits, it takes as few lines as it can, split as
// evenly as can be ("HOE (Heaven / on Earth)", not "HOE (Heaven on / Earth)"); when it can't, each line takes all
// the words it can and the last is cut off (the stylesheet's ellipsis, as is a word too long for a line).
// { lines, cut }: cut when some of it doesn't show.
let measure = null;
function fitLines(text, w, font, n) {
  measure ??= document.createElement("canvas").getContext("2d");
  measure.font = font;
  const widths = new Map();
  const width = (s) => widths.get(s) ?? widths.set(s, measure.measureText(s).width).get(s);
  if (width(text) <= w) return { lines: [text], cut: false };
  const parts = text.includes(" ") ? text.split(" ") : Array.from(text);
  const sep = text.includes(" ") ? " " : "";
  const join = (i, j) => parts.slice(i, j).join(sep);
  // The evenest split of parts from i on into m lines that each fit: [lines, the widest], or [null, Infinity]
  const even = (i, m) => {
    if (m === 1) return width(join(i, parts.length)) <= w ? [[join(i, parts.length)], width(join(i, parts.length))] : [null, Infinity];
    let best = [null, Infinity];
    for (let k = i + 1; k <= parts.length - m + 1 && width(join(i, k)) <= w; k++) {
      const [rest, wr] = even(k, m - 1);
      if (rest && Math.max(width(join(i, k)), wr) < best[1]) best = [[join(i, k), ...rest], Math.max(width(join(i, k)), wr)];
    }
    return best;
  };
  for (let m = 2; m <= n; m++) {
    const [lines] = even(0, m);
    if (lines) return { lines, cut: false };
  }
  const lines = [];
  let i = 0;
  while (lines.length < n - 1 && i < parts.length) {
    let k = i + 1;
    while (k < parts.length && width(join(i, k + 1)) <= w) k++;
    lines.push(join(i, k));
    i = k;
  }
  if (i < parts.length) lines.push(join(i, parts.length));
  return { lines, cut: true };
}

function paintCaptionMarks(el, st) {
  const c = instances.get(el);
  let layer = el.querySelector(".month-caps");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "month-caps";
    // (placed here as well as in the stylesheet, so a cached stylesheet can't drop them in a heap)
    Object.assign(layer.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: 2 });
    layer.append(document.createElement("div"), document.createElement("div"), document.createElement("div"));
    el.appendChild(layer);
  }
  const [marks, caps, fulls] = layer.children;
  const { rows, grid, off } = st;
  const slot = (el.clientWidth - grid.left - grid.right) / Math.max(1, rows.length);
  // The top of the plot (the line sits 4-6px above it), and the axis
  layer.style.setProperty("--gt", `${grid.top}px`);
  layer.style.setProperty("--axis", `${el.clientHeight - grid.bottom}px`);
  const focus = st.picked ?? st.hovered;
  const pinned = (n) => n != null && !!st.pins?.has(n) && !off.has(n);
  const tops = rows.map((r) => barView(st, r).top[0]?.name ?? null);
  const mark = tops.map((n) => (st.underline && n != null && (pinned(n) || n === focus) ? n : null));
  for (const [box, name] of [[marks, "mark"], [caps, "cap"], [fulls, "cap-full"]]) {
    while (box.children.length > rows.length) box.lastChild.remove();
    while (box.children.length < rows.length) box.appendChild(document.createElement("div")).className = name;
  }
  caps.hidden = fulls.hidden = !st.underline;
  const font = rows.length ? getComputedStyle(caps.children[0]).font : "";
  const mids = rows.map((_r, i) => (c ? c.convertToPixel({ xAxisIndex: 0 }, i) : grid.left + slot * (i + 0.5)));
  // Which columns' captions leave some of the name out (cut off, or shortened by cleanName)
  const cut = rows.map(() => false);
  rows.forEach((_r, i) => {
    const mid = mids[i];
    const cap = caps.children[i];
    const text = tops[i] ? cleanName(tops[i]) : "";
    const fit = fitLines(text, slot - 6, font, CAP_LINES);
    cut[i] = fit.cut || text !== (tops[i] ?? "");
    cap.replaceChildren(...fit.lines.map((line) => Object.assign(document.createElement("span"), { textContent: line })));
    cap.classList.toggle("lit", mark[i] != null);
    Object.assign(cap.style, { left: `${mid - slot / 2 + 3}px`, width: `${Math.max(0, slot - 6)}px` });
    const d = marks.children[i];
    const n = mark[i];
    d.classList.toggle("on", n != null);
    if (n == null) return; // sinks away as it was, in its color
    d.classList.toggle("pin", pinned(n)); // a pin deepens the hover's lighter wash, and hovering it deepens it again
    d.classList.toggle("hot", pinned(n) && n === focus);
    d.classList.toggle("jl", mark[i - 1] != null);
    d.classList.toggle("jr", mark[i + 1] != null);
    Object.assign(d.style, { left: `${mid - slot / 2}px`, width: `${slot}px` });
    d.style.setProperty("--c", st.colorOf(n));
  });
  // The whole name waits for the pointer to rest (a fade's length) on its artist, so sweeping across the chart doesn't
  // flash every long name on the way; it goes as soon as the pointer moves on
  // (full: the name shown; fullNext: the one waited for)
  if (focus !== st.full && focus !== st.fullNext) {
    st.full = null;
    clearTimeout(st.fullWait);
    st.fullNext = focus;
    if (focus != null)
      st.fullWait = setTimeout(() => {
        if (monthlyState.get(el) !== st) return;
        st.full = focus;
        paintCaptionMarks(el, st);
      }, dur(FADE_MS));
  }
  paintFullNames(el, caps, fulls, st.full, tops, cut, mids, slot, font);
}

// Where the hovered (or pointed-at) artist's caption leaves some of their name out, the whole name in its place, in
// the lit ink and as few lines as the others: at the narrowest width that holds it (from the column's own, kept
// inside the chart), centred on each run of their columns. It opens out sideways from their columns as it fades in
// (and closes back into them), while the captions it reaches over fade out of its way, so the only text that changes
// in place is the caption's own. Each run's name is the element of its first column, so moving between columns
// crossfades rather than sliding text.
function paintFullNames(el, caps, fulls, focus, tops, cut, mids, slot, font) {
  const runs = [];
  if (focus != null)
    tops.forEach((n, i) => {
      if (n !== focus || !cut[i]) return;
      if (runs.at(-1)?.[1] === i - 1) runs.at(-1)[1] = i;
      else runs.push([i, i]);
    });
  const maxW = el.clientWidth - 8;
  const spans = runs.map(([a, b]) => {
    let w = slot - 6, fit = fitLines(focus, w, font, CAP_LINES);
    while (fit.cut && w < maxW) fit = fitLines(focus, (w = Math.min(w + 8, maxW)), font, CAP_LINES);
    const left = Math.min(Math.max((mids[a] + mids[b]) / 2 - w / 2, 4), el.clientWidth - 4 - w);
    const f = fulls.children[a];
    if (f.classList.contains("on")) return [left, left + w];
    // Arriving: laid out and clipped to its columns at once, then it opens out (.on)
    f.replaceChildren(...fit.lines.map((line) => Object.assign(document.createElement("span"), { textContent: line })));
    f.style.transition = "none";
    Object.assign(f.style, { left: `${left}px`, width: `${w}px` });
    f.style.setProperty("--cl", `${Math.max(0, mids[a] - slot / 2 + 3 - left)}px`);
    f.style.setProperty("--cr", `${Math.max(0, left + w - (mids[b] + slot / 2 - 3))}px`);
    void f.offsetWidth;
    f.style.transition = "";
    return [left, left + w];
  });
  const starts = new Set(runs.map(([a]) => a));
  [...fulls.children].forEach((f, i) => f.classList.toggle("on", starts.has(i)));
  [...caps.children].forEach((cap, i) => {
    const l = mids[i] - slot / 2 + 3, r = mids[i] + slot / 2 - 3;
    cap.classList.toggle("under", spans.some(([a, b]) => l < b && r > a));
  });
}

// Note what's on screen once `series` is set, and once any emptied bars have shrunk away, take their outlines off.
// It waits for the chart's animations to finish rather than a fixed MORPH_MS: the morph's first frame can come late
// (after the work of a render), and a setOption while bars still move restarts their easing, a visible stutter.
function settleMonthly(el, st, series) {
  const was = st.last;
  st.last = new Map(series.filter((s) => s.id !== "rest").map((s) => [s.id, s.data.map((d) => d.value)]));
  const c = instances.get(el);
  if (st.settle) c?.off("finished", st.settle);
  st.settle = null;
  const emptied = [...st.last].some(([id, vs]) => vs.some((v, i) => v === 0 && was?.get(id)?.[i] > 0));
  if (!emptied || !c) return;
  const settle = () => {
    c.off("finished", settle);
    if (monthlyState.get(el) !== st || st.settle !== settle) return;
    st.settle = null;
    const next = monthlySeries(st);
    c.setOption({ series: next }, undefined, true);
    settleMonthly(el, st, next);
  };
  st.settle = settle;
  c.on("finished", settle);
}

// Light one artist (and dim the rest) from a hover elsewhere on the page; null clears
export function focusMonthly(el, name) {
  const st = monthlyState.get(el);
  const c = instances.get(el);
  if (!st || !c) return;
  const next = name != null && st.names.includes(name) && !st.off.has(name) ? name : null;
  if (next === st.hovered) return;
  st.hovered = next;
  paintUnderlines(el, st);
  // Mid-morph, the slices' look waits for the morph to end: a setOption now would restart the bars' easing
  const wait = st.busyUntil - performance.now();
  if (wait > 0) {
    clearTimeout(st.hoverWait);
    st.hoverWait = setTimeout(() => {
      if (monthlyState.get(el) === st) restyleMonthly(el, st, c);
    }, wait);
    return;
  }
  restyleMonthly(el, st, c);
}

function restyleMonthly(el, st, c) {
  const series = monthlySeries(st);
  setOptionFaded(c, { series }, undefined, dur(FADE_MS)); // faded, as hover in the other charts is
  settleMonthly(el, st, series);
}

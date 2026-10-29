// ECharts renderers. Colors come from the CSS tokens so light/dark stay in one place (style.css).

import { FADE_MS, ENTER_MS, MORPH_MS, EASE_IN_OUT, EASE_OUT, drawnShapes, setOptionFaded, easeInOut, dur } from "./motion.js";

const instances = new Map();

function tokens() {
  // body, not the root: a chosen palette overrides the series colors there (see main.js)
  const css = getComputedStyle(document.body);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    surface: v("--surface"),
    primary: v("--text-primary"),
    secondary: v("--text-secondary"),
    muted: v("--text-muted"),
    grid: v("--grid"),
    axis: v("--axis"),
    accent: v("--accent"),
    other: v("--other"),
    series: Array.from({ length: 10 }, (_, i) => i + 1).map((i) => v(`--series-${i}`)),
    seq: [0, 1, 2, 3, 4, 5].map((i) => v(`--seq-${i}`)),
    // Rolling chart fills, set per theme: the share of the artist's color mixed into the surface for a
    // band at rest, a hovered band, and the other bands while one is hovered; and the opacity under a
    // hovered hours line
    shade: { band: +v("--shade-band"), hover: +v("--shade-hover"), dim: +v("--shade-dim"), line: +v("--shade-line") },
  };
}

function chart(el) {
  let c = instances.get(el);
  if (!c) {
    c = echarts.init(el, null, { renderer: "canvas" });
    instances.set(el, c);
    new ResizeObserver(() => c.resize()).observe(el);
  }
  return c;
}

// Theme changed: throw away instances so the next render picks up new tokens.
export function disposeAll() {
  for (const c of instances.values()) c.dispose();
  instances.clear();
}

// [startValue, endValue] of a chart's current zoom, so re-renders can keep the reader's place.
export function currentZoom(el) {
  const dz = instances.get(el)?.getOption()?.dataZoom?.[0];
  if (Number.isFinite(dz?.startValue)) return [dz.startValue, dz.endValue];
  // With every series hidden, ECharts reports the range as NaN; fall back to the last one the rolling
  // chart had
  return rollingState.get(el)?.zoom;
}

// Artist and track names come from user files: escape before they enter tooltip HTML.
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Blend two hex colors; w is the share of b
function mix(a, b, w) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v * (1 - w) + y[i] * w).toString(16).padStart(2, "0")).join("");
}

const fmtHours = (h) => (h >= 100 ? Math.round(h).toLocaleString() : h.toFixed(1)) + " h";

function baseAxis(t) {
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.muted },
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
  };
}

function tooltipBase(t) {
  return {
    backgroundColor: t.surface,
    borderColor: t.grid,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: t.primary, fontSize: 13 },
    extraCssText: "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);",
  };
}

// Line-key row: value leads, label follows. `strong` picks out the row under the pointer.
const row = (color, value, label, strong = false) =>
  `<div style="display:flex;align-items:center;gap:8px;line-height:1.6;${strong ? `background:${color}26;margin:0 -6px;padding:0 6px;border-radius:4px` : ""}">` +
  `<span style="width:12px;height:${strong ? 4 : 2}px;background:${color};border-radius:1px"></span>` +
  `<b style="min-width:3.5em">${value}</b><span style="${strong ? "font-weight:600" : "opacity:.75"}">${esc(label)}</span></div>`;

// Legend selections per rolling chart, kept across morphs and reset when the artist list changes.
const rollingState = new WeakMap();

// Called with the name of the artist lit in a rolling chart (or null) whenever that changes, whatever
// lit it (the plot, a legend, a list); lets other parts of the page follow the highlight.
const focusHooks = new WeakMap();
export const onFocusChange = (el, fn) => focusHooks.set(el, fn);
// fn runs whenever the chart's zoom range changes, however it got there
const zoomHooks = new Map();
export const onZoomChange = (el, fn) => zoomHooks.set(el, fn);

// Called with the artists hidden in a rolling chart's legend after every render, so the rest of the page
// can leave them out. It fires on each render, so a reset to all shown is reported too.
const selectionHooks = new WeakMap();
export const onSelectionChange = (el, fn) => selectionHooks.set(el, fn);
// The artists hidden in each rolling chart, by name, so a hidden artist stays hidden while the artist list changes
// (moving the period, changing the count), even if they drop out of it for a while
const hiddenNames = new WeakMap();

const artistsOf = (names, hasOther) => (hasOther ? names.slice(0, -1) : names);

// Series can't tween in or out of existence, so "Everyone else" arrives and leaves as a band that grows
// from, or shrinks to, zero thickness on top of the stack. Returns true if it handled this render (share
// mode, same artists and window, "Everyone else" newly on or off), false for a plain render.
//  - On: draw the old data with a zero-thickness band added (instantly), then morph to the new data.
//  - Off: morph the new data with a zero-thickness band kept on top, then redraw without it.
function withOtherMorph(el, data, names, window, zoom, mode, hasOther, ms, pins, slots, smooth) {
  const st = rollingState.get(el);
  if (!st || mode !== "share" || st.mode !== "share" || st.hasOther === hasOther || st.window !== window) return false;
  if (artistsOf(st.names, st.hasOther).join("\u0000") !== artistsOf(names, hasOther).join("\u0000")) return false;
  if (!data.share.length) return false;
  const flat = (d) => ({
    ...d,
    share: [...d.share, d.dates.map((_, i) => (d.share[0][i] == null ? null : 0))],
    hours: [...d.hours, d.dates.map(() => 0)],
  });
  if (hasOther) {
    const [oldData, , , , , , , , oldSmooth] = st.args;
    renderRolling(el, flat(oldData), names, window, zoom, mode, true, false, pins, slots, oldSmooth);
    renderRolling(el, data, names, window, zoom, mode, true, ms, pins, slots, smooth);
  } else {
    renderRolling(el, flat(data), [...names, "Everyone else"], window, zoom, mode, true, ms, pins, slots, smooth);
    const token = rollingState.get(el).renderToken;
    setTimeout(() => {
      if (rollingState.get(el)?.renderToken !== token) return; // something re-rendered since
      renderRolling(el, data, names, window, currentZoom(el), mode, false, false, pins, slots, smooth);
    }, ms);
  }
  return true;
}

// Shows [start, end] (dates) of the rolling chart's timeline right now, without redrawing the series
export function setZoom(el, [start, end]) {
  const c = instances.get(el);
  if (!c) return;
  const st = rollingState.get(el);
  // The range follows the reader's hand, so it mustn't tween behind it (a morph leaves a duration set)
  if (st?.tweens) {
    c.setOption({ animationDurationUpdate: 0 });
    st.tweens = false;
  }
  c.dispatchAction({ type: "dataZoom", dataZoomIndex: 0, startValue: start, endValue: end });
  if (st?.live) paintLive(c, st); // the zoom redrew the new values; put the blend back before it's painted
}

// A live morph (morph.live): new artists while the range is moving under the reader's hand, as in a drag
// of the period window. ECharts' own morph tweens points on screen, so every zoom step would restart it
// and the bands would trail the window. Instead the chart is drawn with the new data at once, and each
// frame every shape's points are moved back between the old values and the new ones, at x positions the
// zoom has just laid out. Values are kept per series id by data index (st.values), so a live morph
// interrupted by the next one carries on from what's on screen. Reaches into ECharts internals like
// setOptionFaded.
const liveEase = (t) => 1 - Math.pow(1 - t, 3); // starts quick, so a chain of interrupted morphs keeps up
const liveAt = (L, now = performance.now()) => liveEase(Math.min(1, (now - L.t0) / L.ms));

// The values on screen now, per series id
function liveValues(st) {
  if (!st?.live) return st?.values;
  const e = liveAt(st.live);
  return new Map([...st.live.to].map(([id, b]) => {
    const a = st.live.from.get(id);
    return [id, a ? b.map((v, i) => (v == null || a[i] == null ? v : a[i] + (v - a[i]) * e)) : b];
  }));
}

function stopLive(st) {
  if (!st?.live) return;
  cancelAnimationFrame(st.live.raf);
  st.live = null;
}

function paintLive(c, st) {
  const L = st.live;
  const e = liveAt(L);
  const y0 = c.convertToPixel({ yAxisIndex: 0 }, 0);
  const dy = c.convertToPixel({ yAxisIndex: 0 }, 1) - y0;
  for (const m of c.getModel().getSeries()) {
    const a = L.from.get(m.id), b = L.to.get(m.id);
    if (!a || !b) continue;
    const view = c.getViewOfSeriesModel(m);
    const d = m.getData();
    const n = d.count();
    for (const shape of [view?._polyline, view?._polygon]) {
      if (!shape) continue;
      // ECharts lays out a fresh points array on each update; keep it for its x positions
      if (shape.shape.points !== shape.__liveOut) shape.__liveFresh = shape.shape.points;
      const fresh = shape.__liveFresh;
      if (fresh?.length !== n * 2) continue;
      const out = new Float32Array(fresh);
      for (let i = 0; i < n; i++) {
        const r = d.getRawIndex(i);
        if (a[r] == null || b[r] == null || Number.isNaN(out[2 * i + 1])) continue;
        out[2 * i + 1] = y0 + dy * (a[r] + (b[r] - a[r]) * e);
      }
      shape.setShape({ points: out });
      shape.__liveOut = out;
    }
  }
}

// Moves the zoom range from `from` to `to` ([start, end] dates), a frame at a time like dragging the slider:
// a real scroll, or zoom if the span changes, of whatever is drawn. Calls `done` when it lands.
// yMax: optional { from, to } for the y-axis top (Hours mode), which tweens along with the range; otherwise
// it would step from one whole number to the next each time the window's tallest line changes
function panTo(el, from, to, { ms, easing }, done, yMax) {
  const c = chart(el);
  const st = rollingState.get(el);
  c.setOption({ animationDurationUpdate: 0 }); // each frame is a plain redraw, not a tween
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    const e = easeInOut(t);
    const startValue = from[0] + (to[0] - from[0]) * e, endValue = from[1] + (to[1] - from[1]) * e;
    if (yMax) {
      const max = yMax.from + (yMax.to - yMax.from) * e;
      c.setOption({ yAxis: { max: () => max }, dataZoom: [{ startValue, endValue }] });
    } else c.dispatchAction({ type: "dataZoom", dataZoomIndex: 0, startValue, endValue });
    if (t < 1) st.panRaf = requestAnimationFrame(tick);
    else {
      st.panRaf = 0;
      done();
    }
  };
  st.panRaf = requestAnimationFrame(tick);
}

// mode "share": stacked bands of each artist's share of listening (the original rolling_window.py).
// mode "hours": the same artists as overlaid lines of hours per week.
//
// Both modes are the *same* series with the same ids; only their values and styles differ. That lets
// ECharts tween every point between the two (morph = true) instead of redrawing. To make that work the
// stacking is done here rather than with ECharts' `stack`: in share mode each series is the line at the
// top of its band (cumulative share) filled down to the axis, drawn top band first so lower bands paint
// over the bottom of higher ones. In hours mode the fills fade out and the lines move to hours per week.
// "Everyone else" flattens to zero and fades out in hours mode, where it would dwarf everyone.
//
// Share mode draws each band as a pale tint of the artist's color (t.shade.band), outlined on both edges
// by two silent overlay lines, its top (t) and bottom (b), drawn above every band and inset slightly so
// neighbors' borders sit side by side. Hours mode hides them.
//
// pins: optional { has(name), unpin(name), toggle(name) } for artists the reader pinned; clicking a band or
// line in the plot calls toggle.
// slots: optional palette slot per artist (aligned with names), so colors can follow the artist; by default
// an artist's color is their position.
// smooth: 0..1, how much each curve is rounded into a spline (the data itself is blurred by the caller).
//
// morph: false to redraw without animation, or true (or a duration in ms, or {ms, easing}) to tween from what's drawn to the
// new data, styles and smoothing. Switching "Everyone else" on or off morphs too, through a stand-in band
// of zero thickness (see withOtherMorph). {ms, live: true} morphs while the zoom range keeps moving (see
// paintLive); it needs the same mode, window and number of series, or it redraws.
export function renderRolling(el, data, names, window, zoom, mode = "share", hasOther = false, morph = false, pins = null, slots = null, smooth = 0) {
  // Any render ends a pan or a live morph in progress
  const prev = rollingState.get(el);
  if (prev?.panRaf) {
    cancelAnimationFrame(prev.panRaf);
    prev.panRaf = 0;
  }
  // Hours mode: lines are matched by series id (their rank), so an artist who moves up or down the ranking
  // would tween through a neighbour's line, and one who stays would seem to regrow. Seat the drawn lines by
  // artist first (an instant, invisible re-draw), so each returning artist's line is its own series and only
  // the artists who change places move into each other's. Share mode's bands are ranked, so it can't.
  if (morph && !morph.pan && mode === "hours" && prev?.mode === "hours" && prev.args && prev.hasOther === hasOther && prev.window === window &&
      prev.names.length === names.length && prev.names.join("\u0000") !== names.join("\u0000")) {
    const n = artistsOf(names, hasOther).length;
    const old = artistsOf(prev.names, hasOther);
    const from = names.slice(0, n).map((a) => old.indexOf(a));
    const free = old.map((_, j) => j).filter((j) => !from.includes(j));
    const seat = from.map((j) => (j >= 0 ? j : free.shift()));
    const [oldData, , , , , , , , oldSmooth] = prev.args;
    const pick = (rows) => rows.map((_, k) => rows[k < n ? seat[k] : k]);
    renderRolling(el, { ...oldData, share: pick(oldData.share), hours: pick(oldData.hours) }, names, window, currentZoom(el), mode, hasOther, false, pins, slots, oldSmooth);
    return renderRolling(el, data, names, window, zoom, mode, hasOther, morph, pins, slots, smooth);
  }
  const liveFrom =
    morph?.live && prev?.mode === mode && prev.hasOther === hasOther && prev.window === window &&
    prev.names.length === names.length && prev.values?.dates === data.dates.length ? liveValues(prev) : null;
  stopLive(prev);
  if (morph?.live && !liveFrom) morph = false;
  // A period change ({ms, easing, pan: true}) first scrolls (or zooms) the plot to the new range with the
  // artists already on screen, as if dragging the zoom slider, then morphs the bands into the new
  // period's artists. That needs the same series on screen; otherwise it redraws.
  if (morph?.pan) {
    const same = prev && prev.mode === mode && prev.hasOther === hasOther && prev.window === window && prev.names.length === names.length;
    const from = same && currentZoom(el);
    // All time has no zoom range of its own; give it the whole timeline so there's a range to travel to
    if (same && !Number.isFinite(zoom?.[0]) && data.dates.length) zoom = [data.dates[0], data.dates[data.dates.length - 1]];
    if (Number.isFinite(from?.[0]) && Number.isFinite(zoom?.[0]) && (from[0] !== zoom[0] || from[1] !== zoom[1])) {
      // Hours: the axis top the final chart will have, to travel to alongside the range
      let yMax = null;
      if (mode === "hours") {
        const idx = data.dates.map((d, i) => i).filter((i) => data.dates[i] >= zoom[0] && data.dates[i] <= zoom[1]);
        const hide = prev.selected;
        let m = 0;
        names.forEach((n, s) => {
          if (hasOther && s === names.length - 1) return;
          if (hide?.[n] === false) return;
          for (const i of idx) if (data.share[s][i] != null) m = Math.max(m, (data.hours[s][i] / window) * 7);
        });
        const now = chart(el).getModel().getComponent("yAxis", 0)?.axis.scale.getExtent()[1];
        if (Number.isFinite(now)) yMax = { from: now, to: Math.max(1, Math.ceil(m)) };
      }
      panTo(el, from, zoom, morph, () => renderRolling(el, data, names, window, zoom, mode, hasOther, true, pins, slots, smooth), yMax);
      return;
    }
    morph = same;
  }
  const { ms, easing = EASE_IN_OUT.echarts } = morph && typeof morph === "object" ? morph : { ms: morph === true ? MORPH_MS : morph || 0 };
  if (ms && withOtherMorph(el, data, names, window, zoom, mode, hasOther, ms, pins, slots, smooth)) return;
  const t = tokens();
  const c = chart(el);
  const share = mode === "share";
  const otherIdx = hasOther ? names.length - 1 : -1;
  // "Everyone else" is always gray, never borrowing the next artist's slot
  const colors = names.map((_, i) => (i === otherIdx ? t.other : t.series[slots?.[i] ?? i]));
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const perWeek = (h) => (h / window) * 7;

  let st = rollingState.get(el);
  if (!st || st.names.join("\u0000") !== names.join("\u0000")) {
    // Keep the old pointer handlers' references, so they're removed below rather than left running
    // against the previous artists alongside the new ones
    const hidden = hiddenNames.get(el);
    // While every unpinned artist is hidden (the key's all box is off), artists who arrive (a new period, a
    // higher count) come in hidden too, so the box stays off. Pinned artists and everyone else are left alone.
    const was = st ? artistsOf(st.names, st.hasOther).filter((n) => !pins?.has(n)) : [];
    const allOff = was.length > 0 && was.every((n) => st.selected[n] === false);
    const fresh = (n, i) => allOff && i !== otherIdx && !st.names.includes(n) && !pins?.has(n);
    st = {
      names,
      selected: Object.fromEntries(names.map((n, i) => [n, !hidden?.has(n) && !fresh(n, i)])),
      zrMove: st?.zrMove,
      zrOut: st?.zrOut,
    };
    rollingState.set(el, st);
  }
  st.hasOther = hasOther;
  st.window = window;
  st.args = [data, names, window, zoom, mode, hasOther, pins, slots, smooth];
  if (Number.isFinite(zoom?.[0])) st.zoom = zoom; // for currentZoom, if hiding every artist loses the range
  const visible = (s) => st.selected[names[s]] !== false;

  // Cumulative share over visible series, rescaled by the visible total at each date so the bands always
  // fill the plot, as if the hidden artists had never played; a hidden series collapses onto the band below it
  const top = names.map(() => new Array(data.dates.length));
  const bottom = names.map(() => new Array(data.dates.length));
  const scale = new Array(data.dates.length).fill(1);
  for (let i = 0; i < data.dates.length; i++) {
    let sum = 0;
    for (let s = 0; s < names.length; s++) if (visible(s)) sum += data.share[s][i] ?? 0;
    scale[i] = sum > 0 ? 1 / sum : 0;
    let run = 0;
    for (let s = 0; s < names.length; s++) {
      const v = data.share[s][i];
      if (v == null) { top[s][i] = bottom[s][i] = null; continue; }
      bottom[s][i] = run;
      if (visible(s)) run += v * scale[i];
      top[s][i] = run;
    }
  }

  // Hours per week for artist s at date i. Where nothing at all was played in the window, share mode has
  // a gap (null); hours leaves the same gap rather than drawing 0, so a morph never tweens between a
  // gap and a value, which draws a vertical stroke at each such date mid-morph.
  const hoursAt = (s, i) => (data.share[s][i] == null ? null : s === otherIdx ? 0 : perWeek(data.hours[s][i]));

  // Share mode outlines every band on both edges in its own color, so at each boundary the two neighbors
  // each show their own border rather than one artist's line standing for both. Each edge line is drawn
  // at twice its visible width, centered on the boundary, then clipped to its own band (clipEdges below):
  // only its inner half shows, so borders keep one width everywhere, even on steep slopes, and meet
  // neighbors' exactly on the boundary. A band too thin to see clips its edges away with it, so absent
  // artists leave no line. Edges break only where the band does (nothing played in the window), in both
  // modes: matching the band's gaps exactly keeps an edge locked to its band through a morph, which
  // ECharts tweens point by point, and a break never tweens into a value (a vertical stroke).
  const edgeData = (s, side) =>
    data.dates.map((d, i) => {
      const lo = bottom[s][i], hi = top[s][i];
      if (lo == null) return [d, null];
      return [d, !share ? hoursAt(s, i) : side === "t" ? hi : lo];
    });
  // Visible widths 1.5px, or 2.5px for lit bands, doubled since half is clipped away; hours mode hides them
  const overlayStyle = (s, on) => ({ width: on ? 5 : 3, color: colors[s], opacity: share ? 1 : 0, cap: "butt", join: "round" });

  // The artists drawn highlighted: the pinned ones, plus the one under the pointer (or hovered in the
  // legend or a list) while there is one. Built into the options below as well as applied on hover, so
  // a re-render or a mode morph keeps the pinned artists lit.
  const base = new Set(names.flatMap((n, k) => (pins?.has(n) && visible(k) && k !== otherIdx ? [k] : [])));
  // Fills are opaque tints, not transparency, because bands overlap down to the axis.
  // Share: lit bands (pinned, or under the pointer) are filled in more strongly (t.shade.hover), and while
  // any band is lit the rest dim slightly (t.shade.dim); with none lit, every band has its resting tint
  const bandFill = (k, lit) =>
    mix(t.surface, colors[k], lit.has(k) ? t.shade.hover : lit.size ? t.shade.dim : t.shade.band);
  // Hours: lit lines thicken and the rest fade, and only a lit line gets a faint fill. The fill is the same
  // tint as a lit share band, at the opacity that gives t.shade.line of the artist's color. Sharing the
  // color means a morph only changes opacity: tweening a band's opaque tint to the artist's full color at
  // low opacity would pass through a stronger fill than either end.
  const hoursFill = colors.map((c) => mix(t.surface, c, t.shade.hover));
  const hoursFillOpacity = t.shade.line / t.shade.hover;
  // Morphing from share to hours, a pinned artist's fill waits until the lines have settled. Its share
  // band fills all the way down to the axis, hidden under the bands below; fading only partway while
  // theirs fade out would bare it across the whole chart mid-morph. It fades out with them and back in
  // once the morph is done (below).
  const holdFill = morph && !share && st.mode === "share";
  const renderToken = (st.renderToken = (st.renderToken ?? 0) + 1);
  const lineLook =(k, lit) => ({
    width: lit.has(k) ? 3 : 2,
    opacity: !share && k === otherIdx ? 0 : !lit.size || lit.has(k) ? 1 : 0.2,
  });

  const series = names
    .map((name, s) => {
      const hide = !share && s === otherIdx;
      return {
        id: `s${s}`,
        name,
        type: "line",
        showSymbol: false,
        symbol: "none",
        smooth,
        color: colors[s],
        // Lower bands paint over the bottom of the ones above them. That order has to be explicit:
        // ECharts paints series in the order their views were created, so artists added later (raising
        // the artist count) would otherwise paint over everything below them
        z: (share ? 2 : 3) + (names.length - s) / 100,
        // Share: hidden; the edge overlays draw each band's borders instead (see edgeData)
        lineStyle: {
          ...(share ? { width: 2, opacity: 0 } : lineLook(s, base)),
          color: colors[s],
          cap: "round",
          join: "round",
        },
        // Every series ignores the pointer; the plot works out what's under it from the data (see zrMove).
        silent: true,
        // Hours mode keeps an invisible fill, so the hovered line's shading and the morph back into
        // bands can fade it in rather than have it appear
        areaStyle: {
          color: share ? bandFill(s, base) : hoursFill[s],
          opacity: share ? 1 : !hide && base.has(s) && !holdFill ? hoursFillOpacity : 0,
          origin: "start",
        },
        // Share mode: ECharts' hover emphasis clears itself on stacked areas, so bands are faded by
        // hand instead (see focusBand below). Hours mode: built-in emphasis on the hovered line.
        emphasis: share
          ? { disabled: true, areaStyle: null, lineStyle: null }
          : { disabled: false, focus: "series", areaStyle: null, lineStyle: { width: 3 } },
        blur: share
          ? { areaStyle: null, lineStyle: null }
          : { areaStyle: null, lineStyle: { opacity: hide ? 0 : 0.2 } },
        data: data.dates.map((d, i) => [d, share ? top[s][i] : hoursAt(s, i)]),
      };
    })
    // Top band first, matching the paint order above
    .reverse()
    .concat(
      names.flatMap((name, s) =>
        ["t", "b"].map((side) => ({
          id: `${side}${s}`,
          name, // shares the band's legend entry, so hiding an artist hides its outline too
          type: "line",
          silent: true,
          showSymbol: false,
          symbol: "none",
          smooth,
          color: colors[s],
          z: 4,
          lineStyle: overlayStyle(s, base.has(s)),
          areaStyle: null,
          emphasis: { disabled: true },
          data: edgeData(s, side),
        }))
      )
    );

  // The band (share) or line (hours) under the pointer, set by the mouse handlers below
  let focused = null;
  const sIdx = (p) => Number(p.seriesId.slice(1));
  const bands = (params) => params.filter((p) => p.seriesId[0] === "s");
  const shareTooltip = (params) => {
    params = bands(params);
    if (!params.length || params[0].value[1] == null) return "";
    const i = params[0].dataIndex;
    const rows = params
      .map((p) => ({ p, share: data.share[sIdx(p)][i] * scale[i], hours: data.hours[sIdx(p)][i] }))
      // Drop anyone who would read as 0%
      .filter((r) => r.share >= 0.005)
      // Top band first, so the rows read in the same order as the bands under the pointer
      .sort((a, b) => sIdx(b.p) - sIdx(a.p))
      .map((r) => row(r.p.color, (r.share * 100).toFixed(0) + "%", `${r.p.seriesName} · ${fmtHours(r.hours)}`, sIdx(r.p) === focused));
    return `<div style="color:${t.muted};margin-bottom:4px">${window} days around ${fmtDate(params[0].value[0])}</div>${rows.join("")}`;
  };
  const hoursTooltip = (params) => {
    params = bands(params);
    if (!params.length) return "";
    const rows = params
      .filter((p) => sIdx(p) !== otherIdx && p.value[1] >= 0.05)
      .sort((a, b) => b.value[1] - a.value[1])
      .map((p) => row(p.color, `${p.value[1].toFixed(1)} h`, p.seriesName, sIdx(p) === focused));
    return `<div style="color:${t.muted};margin-bottom:4px">Hours per week, ${window} days around ${fmtDate(params[0].value[0])}</div>${rows.join("")}`;
  };

  st.mode = mode;

  // Clip each band's edge lines to the band itself, so only their inner halves show (see edgeData). The
  // clip is ECharts' own area polygon for the band, built from its top edge and the top edge of the
  // visible band below (or the axis). Its shape reads those edges live from the drawn shapes, and zrender
  // rebuilds a clip from its shape every time it draws the clipped line, so the clip follows the bands
  // through morphs, re-stacks and zoom-slider drags without lagging or dropping. The clips are re-linked
  // right after each update, before it's painted, in case ECharts replaced a shape or the stacking
  // changed; a line already linked to the same shapes is left alone. This reaches into ECharts internals
  // like setOptionFaded; without them the borders are just unclipped, twice as wide.
  const clipEdges = () => {
    if (!share) return;
    const shapes = drawnShapes(c);
    let below = null;
    for (let k = 0; k < names.length; k++) {
      if (!visible(k)) continue;
      const band = shapes.get(`s${k}:area`);
      if (!band) continue;
      const floorBand = below == null ? null : shapes.get(`s${below}:area`) ?? null;
      below = k;
      for (const side of ["t", "b"]) {
        const line = shapes.get(`${side}${k}:line`);
        if (!line || (line.__clipOf?.[0] === band && line.__clipOf[1] === floorBand)) continue;
        const clip = new band.constructor({});
        clip.shape = {
          get points() { return band.shape.points; },
          get stackedOnPoints() { return floorBand ? floorBand.shape.points : band.shape.stackedOnPoints; },
        };
        // zrender skips drawing a line whose clip has zero area, judged from a cached bounding box that a
        // live shape never refreshes; a band that's flat for a moment mustn't hide its border for good
        clip.isZeroArea = () => false;
        line.setClipPath(clip);
        line.__clipOf = [band, floorBand];
      }
    }
  };
  for (const ev of ["finished", "datazoom"]) {
    c.off(ev);
    c.on(ev, clipEdges);
  }
  c.on("datazoom", () => zoomHooks.get(el)?.());

  // What each series shows, by data index, for the next live morph to start from
  st.values = new Map(series.map((s) => [s.id, s.data.map((p) => p[1])]));
  st.values.dates = data.dates.length;
  st.tweens = !liveFrom && ms > 0;

  setOptionFaded(
    c,
    {
      // No animation on first draw or data changes; only morphs between modes tween
      animation: true,
      animationDuration: 0,
      // A live morph moves the points itself (paintLive); its colors still fade
      animationDurationUpdate: liveFrom ? 0 : ms,
      animationEasingUpdate: easing,
      animationThreshold: 100000, // the default (2000 points) would silently disable the morph
      grid: { left: 48, right: 16, top: 12, bottom: 28 },
      // Hidden: it only holds which artists are shown. The visible key is HTML in the period bar (main.js paintArtistKey), so
      // hovering it never puts ECharts' own highlight states on the bands.
      legend: { show: false, data: names, selected: st.selected },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        // The readout covers every artist at the date; highlighting is only for the one under the pointer
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 }, triggerEmphasis: false },
        formatter: share ? shareTooltip : hoursTooltip,
      },
      // triggerEmphasis has to be off on the axis's own pointer too (the tooltip's alone isn't enough),
      // or every hover puts all the shapes in ECharts' highlight state, which breaks the hand-drawn focus
      axisPointer: { triggerEmphasis: false },
      xAxis: { type: "time", ...baseAxis(t), splitLine: { show: false }, axisPointer: { triggerEmphasis: false } },
      yAxis: {
        type: "value",
        min: 0,
        // Function form in both modes so a merge always replaces the previous mode's bound
        max: share ? () => 1 : (v) => Math.max(1, Math.ceil(v.max)),
        // null (not undefined) so a merge clears share mode's fixed 25% step
        interval: share ? 0.25 : null,
        splitNumber: 4,
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: share ? (v) => `${Math.round(v * 100)}%` : (v) => `${v} h` },
      },
      // The range is chosen in the page's period brush (main.js), which moves it with setZoom. A hidden
      // slider is still a dataZoom, so the plot shows exactly that range. Never an "inside" one: it
      // swallows wheel events even with wheel zoom off, which stops the page scrolling over the chart
      dataZoom: [{ type: "slider", show: false, startValue: zoom?.[0], endValue: zoom?.[1] }],
      series,
    },
    // Morphs merge by series id, so points tween instead of redrawing, while fills and lines fade
    { notMerge: !morph },
    ms,
    easing
  );
  clipEdges();
  if (liveFrom) {
    const L = (st.live = { from: liveFrom, to: st.values, t0: performance.now(), ms });
    paintLive(c, st); // before the new values are ever painted
    const tick = () => {
      if (st.live !== L) return;
      paintLive(c, st);
      if (liveAt(L) < 1) L.raf = requestAnimationFrame(tick);
      else st.live = null;
    };
    L.raf = requestAnimationFrame(tick);
  }
  // The held-back pinned fills fade in once the morph has finished, unless the chart re-rendered since
  if (holdFill && base.size) {
    setTimeout(() => {
      if (st.renderToken !== renderToken) return;
      setOptionFaded(c, {
        animationDurationUpdate: 0,
        series: [...base].map((k) => ({ id: `s${k}`, areaStyle: { opacity: hoursFillOpacity } })),
      }, undefined, 300);
    }, ms);
  }

  // Share mode: highlight the band under the pointer by filling it in more strongly (t.shade.hover),
  // dimming every other band a little (t.shade.dim). The hovered band's edge overlays draw its whole
  // border, bottom included.
  const lit = () => (focused == null ? base : new Set([...base, focused]));
  const focusBand = (sIndex) => {
    if (sIndex === focused) return;
    focused = sIndex;
    focusHooks.get(el)?.(focused == null ? null : names[focused]);
    const on = lit();
    setOptionFaded(c, {
      animationDurationUpdate: 0,
      series: names.flatMap((_, k) => [
        { id: `s${k}`, areaStyle: { color: bandFill(k, on) } },
        { id: `t${k}`, lineStyle: overlayStyle(k, on.has(k)) },
        { id: `b${k}`, lineStyle: overlayStyle(k, on.has(k)) },
      ]),
    }, undefined, FADE_MS);
    clipEdges();
  };
  // Hours mode: thicken one line and fade the rest, by restyling directly (ECharts' own blur state is
  // cleared on every pointer move over empty plot space, which is all of it once lines are silent).
  // Only a lit line gets a faint fill (hoursFillOpacity); nothing is filled at rest.
  const focusLine = (k) => {
    if (k === focused) return;
    focused = k;
    focusHooks.get(el)?.(focused == null ? null : names[focused]);
    const on = lit();
    setOptionFaded(c, {
      animationDurationUpdate: 0,
      series: names.map((_, j) => ({
        id: `s${j}`,
        lineStyle: lineLook(j, on),
        areaStyle: { opacity: j !== otherIdx && on.has(j) ? hoursFillOpacity : 0 },
      })),
    }, undefined, FADE_MS);
  };

  // Highlight an artist from outside the plot (legend, top lists): their band in share mode, their
  // line in hours mode. null, or an artist not in the chart, clears it.
  st.focusArtist = (name) => {
    let k = name == null ? -1 : names.indexOf(name);
    if (!share && k === otherIdx) k = -1; // "Everyone else" isn't drawn in hours mode
    (share ? focusBand : focusLine)(k < 0 ? null : k);
  };

  // Show or hide an artist as the legend's box does
  st.toggleArtist = (name) => c.dispatchAction({ type: "legendToggleSelect", name });

  // The tooltip formats before the pointer handler runs, so redraw it once the focused series is known
  const retip = (x, y) => c.dispatchAction({ type: "showTip", x, y });

  // Plot hover, worked out from the data rather than from which shape is under the pointer (every
  // series is silent, so ECharts never applies its own highlight states, which break overlapping bands):
  // share mode focuses the band the pointer is inside; hours mode focuses the topmost line at that date.
  const zr = c.getZr();
  if (st.zrMove) {
    zr.off("mousemove", st.zrMove);
    zr.off("globalout", st.zrOut);
    zr.off("click", st.zrClick);
  }
  let fromPlot = false; // only clear focus the plot set, not a legend or list hover's
  const focus = share ? focusBand : focusLine;
  // The band or line under a pixel: its index, null for none, or undefined when the pixel is off the plot
  const pick = (px) => {
    if (!c.containPixel({ gridIndex: 0 }, px)) return undefined;
    const [t0, y] = c.convertFromPixel({ gridIndex: 0 }, px);
    // Nearest date (dates are sorted)
    let lo = 0, hi = data.dates.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (data.dates[mid] < t0) lo = mid; else hi = mid;
    }
    const i = Math.abs(data.dates[hi] - t0) < Math.abs(data.dates[lo] - t0) ? hi : lo;
    let best = null;
    if (share) {
      for (let k = 0; k < names.length; k++) {
        if (visible(k) && bottom[k][i] != null && y >= bottom[k][i] && y <= top[k][i] && top[k][i] > bottom[k][i]) best = k;
      }
    } else {
      let bestV = 0.05; // ignore near-silence, which would just pick an arbitrary flat line
      names.forEach((_, k) => {
        if (k === otherIdx || !visible(k)) return;
        const v = perWeek(data.hours[k][i]);
        if (v > bestV) { bestV = v; best = k; }
      });
    }
    return best;
  };
  // "Everyone else" can't be pinned, so it isn't offered as clickable
  const pinnable = (k) => k != null && k !== otherIdx;
  st.zrMove = (e) => {
    const px = [e.offsetX, e.offsetY];
    const best = pick(px);
    if (best === undefined) {
      if (fromPlot) focus(null);
      fromPlot = false;
      zr.setCursorStyle("default");
      return;
    }
    fromPlot = true;
    zr.setCursorStyle(pins && pinnable(best) ? "pointer" : "default");
    if (best !== focused) {
      focus(best);
      retip(...px);
    }
  };
  st.zrOut = () => {
    if (fromPlot) focus(null);
    fromPlot = false;
    zr.setCursorStyle("default");
  };
  // Clicking the band or line under the pointer pins it, or unpins it if it's already pinned
  st.zrClick = (e) => {
    const best = pick([e.offsetX, e.offsetY]);
    if (pins?.toggle && pinnable(best)) pins.toggle(names[best]);
  };
  zr.on("mousemove", st.zrMove);
  zr.on("globalout", st.zrOut);
  zr.on("click", st.zrClick);

  // Showing or hiding artists re-stacks the bands around them, as a morph
  const restack = () => {
    const [d, n, w, , m, o, p, sl, sm] = st.args;
    renderRolling(el, d, n, w, currentZoom(el), m, o, true, p, sl, sm);
  };
  // Several at once in a single re-stack, rather than one morph per artist
  st.showAll = (list, show) => {
    for (const name of list) if (name in st.selected) st.selected[name] = show;
    restack();
  };

  // (legendToggleSelect fires legendselectchanged; other legend actions fire the other two)
  for (const ev of ["legendselectchanged", "legendselected", "legendunselected"]) {
    c.off(ev);
    c.on(ev, (e) => {
      st.selected = { ...e.selected };
      restack();
    });
  }
  const hidden = hiddenNames.get(el) ?? new Set();
  for (const n of names) st.selected[n] === false ? hidden.add(n) : hidden.delete(n);
  hiddenNames.set(el, hidden);
  selectionHooks.get(el)?.(artistsOf(names, hasOther).filter((n) => st.selected[n] === false));
}

// Show or hide an artist in a rolling chart from elsewhere on the page (what unticking their legend box does)
export function toggleArtist(el, name) {
  rollingState.get(el)?.toggleArtist?.(name);
}

// Show or hide several artists in a rolling chart at once (what its "all" box does)
export function showArtists(el, list, show) {
  rollingState.get(el)?.showAll?.(list, show);
}

// Highlight an artist in a rolling chart from elsewhere on the page; null clears.
export function focusArtist(el, name) {
  rollingState.get(el)?.focusArtist?.(name);
}

// Total hours per month (or per `span` months), stacked: the month's top artist on top of each bar, filled in strongly and captioned
// above it where there's room; below them the chart's other artists in a lighter tint; and at the base everyone
// else in gray. Artists with less than FOLD of a month are folded into the gray, so small slices don't clutter
// it, unless they're lit (pinned, or hovered anywhere on the page, through focusMonthly): then they show, filled
// in and outlined, while the rest dim. Hovering a month lists its top five. names/slots are the chart's artists
// and their palette slots; pins is {has, toggle}; hover(name|null) reports the pointer; off holds deselected
// artists (never lit).
const FOLD = 0.03;
const monthlyState = new WeakMap();
export function renderMonthly(el, rows, names = [], slots = [], pins = null, hover = () => {}, off = new Set(), span = 1) {
  const t = tokens();
  const short = (d) => d.toLocaleDateString(undefined, { month: "short" });
  // A bar's period: "Mar 2024", "Jan–Jun 2024" or "2024"
  const label = (d) =>
    span === 12
      ? String(d.getFullYear())
      : span > 1
        ? `${short(d)}–${short(new Date(d.getFullYear(), d.getMonth() + span - 1, 1))} ${d.getFullYear()}`
        : d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  // One year of months: label every month. Years: every bar. Otherwise: each January with its year.
  const oneYear = span === 1 && rows.length <= 13;
  const tick = (r) =>
    oneYear ? short(r.month) : span === 12 || r.month.getMonth() === 0 ? String(r.month.getFullYear()) : "";
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
  const st = { names, rows, span, t, off, pins, colorOf, hovered: prev?.hovered ?? null, last: fresh ? null : prev.last };
  monthlyState.set(el, st);
  // Caption styles: a dot in the top artist's color (gray if they're not in the chart), then the name
  const rich = { n: { color: t.secondary, fontSize: 11, align: "center" }, o: { color: t.other, fontSize: 9, align: "center" } };
  slots.forEach((s) => (rich[`s${s}`] = { color: t.series[s], fontSize: 9, align: "center" }));
  const plain = (s) => String(s).replace(/[{}|]/g, " "); // rich text reads these as markup
  const bar = { type: "bar", stack: "month", barCategoryGap: rows.length <= 20 ? "30%" : "12%" };
  const looks = monthlySeries(st);
  setOptionFaded(
    c,
    {
      animationDuration: ENTER_MS,
      animationDurationUpdate: MORPH_MS,
      animationEasingUpdate: EASE_IN_OUT.echarts,
      grid,
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "shadow", shadowStyle: { color: t.grid, opacity: 0.35 } },
        formatter: (ps) => {
          const r = rows[ps[0].dataIndex];
          const head = `<div style="margin-bottom:4px"><b>${label(r.month)}</b> <span style="opacity:.75">${fmtHours(r.hours)}</span></div>`;
          if (!r.hours) return head;
          const lit = litSet(st);
          const pct = (h) => `${Math.round((h / r.hours) * 100)}%`;
          // Lit artists outside the month's top five follow it
          const extra = names
            .map((n, k) => ({ name: n, hours: r.by[k] }))
            .filter((a) => lit.has(a.name) && a.hours > 0 && !r.top.some((x) => x.name === a.name));
          return head + [...r.top, ...extra].map((a) => row(colorOf(a.name), pct(a.hours), a.name, lit.has(a.name))).join("");
        },
      },
      xAxis: {
        type: "category",
        data: rows.map(tick),
        ...baseAxis(t),
        axisLabel: { color: t.muted, interval: 0 },
        axisPointer: { triggerEmphasis: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => `${v} h` },
      },
      series: [
        { ...looks[0], name: "Everyone else", ...bar, silent: true },
        ...[...names, ...names].map((n, j) => ({ ...looks[j + 1], name: n, ...bar, cursor: pins ? "pointer" : "default" })),
        {
          ...looks[2 * names.length + 1],
          name: "Top artist",
          ...bar,
          // Topmost, so it carries the caption (from a zero-height bar when the top artist is in the chart)
          label: {
            show: caption,
            position: "top",
            distance: 6,
            width: slotW - 6,
            overflow: "truncate",
            align: "center",
            rich,
            formatter: (p) => {
              const top = rows[p.dataIndex].top[0];
              if (!top) return "";
              return `{${slotOf.has(top.name) ? `s${slotOf.get(top.name)}` : "o"}|●} {n|${plain(top.name)}}`;
            },
          },
        },
      ],
    },
    // Colors and outlines fade with the bars' morph rather than snapping before it
    { notMerge: fresh },
    fresh ? 0 : dur(MORPH_MS)
  );
  // Only the chart's artists are pinnable (and shared with the rest of the page). The gray top series names its
  // artist per bar.
  const artistOf = (p) => (p.seriesId === "top" ? p.data?.name : p.seriesName);
  settleMonthly(el, st, looks);
  c.off("mouseover");
  c.off("mouseout");
  c.off("click");
  c.on("mouseover", (p) => names.includes(artistOf(p)) && hover(artistOf(p)));
  c.on("mouseout", () => hover(null));
  c.on("click", (p) => names.includes(artistOf(p)) && pins?.toggle(artistOf(p)));
}

// The artists in the spotlight: the pinned ones, and the one hovered
function litSet(st) {
  const lit = new Set(st.names.filter((n) => st.pins?.has(n) && !st.off.has(n)));
  if (st.hovered != null) lit.add(st.hovered);
  return lit;
}

// The series' ids, data and styles, bottom to top: the gray remainder (rest), each chart artist's slices (m{k}),
// each chart artist's top-of-the-month block (t{k}), then the top block of a month whose top artist isn't in the
// chart (top, gray). Giving every artist their own top series keeps a region theirs when they stop being on
// top (deselected, say), so it shrinks away instead of turning into someone else's. A small artist's slice is
// folded into the gray unless they're lit, so lighting one grows their slices out of it.
function monthlySeries(st) {
  const { t, names, rows, colorOf } = st;
  const lit = litSet(st);
  const fill = (col, on, dim, base) => mix(t.surface, col, on ? 0.5 : dim ? 0.1 : base);
  // A hairline in the surface color between slices, or the artist's color around a lit one
  const edge = (col, on) => (on ? { borderColor: col, borderWidth: 1.5 } : { borderColor: t.surface, borderWidth: 1 });
  const radius = { borderRadius: [1.5, 1.5, 0, 0] };
  // A zero-height bar still strokes its outline, so an emptied bar keeps it only while it shrinks (settleMonthly
  // takes it off after)
  const items = (id, values, extra = () => ({})) =>
    values.map((v, i) => ({ value: v, ...extra(i), ...(v > 0 || st.last?.get(id)?.[i] > 0 ? {} : { itemStyle: { borderWidth: 0 } }) }));
  const tops = rows.map((r) => r.top[0]?.name);
  const shown = names.map((n, k) => rows.map((r, i) => n !== tops[i] && r.by[k] > 0 && (lit.has(n) || r.by[k] >= FOLD * r.hours)));
  const rest = rows.map((r, i) => {
    const slices = names.reduce((s, _n, k) => s + (shown[k][i] ? r.by[k] : 0), 0);
    return Math.max(0, r.hours - slices - (r.top[0]?.hours ?? 0));
  });
  const slices = names.map((n, k) => {
    const on = lit.has(n);
    const col = colorOf(n);
    return {
      id: `m${k}`,
      itemStyle: { color: fill(col, on, lit.size && !on, 0.25), ...edge(col, on && "lit") },
      data: items(`m${k}`, rows.map((r, i) => (shown[k][i] ? r.by[k] : 0))),
    };
  });
  // Always drawn like a pinned artist, so lighting another doesn't dim them
  const topBlocks = names.map((n, k) => ({
    id: `t${k}`,
    itemStyle: { color: fill(colorOf(n), true), ...edge(colorOf(n), true), ...radius },
    data: items(`t${k}`, rows.map((r, i) => (tops[i] === n ? r.by[k] : 0))),
  }));
  // A top artist outside the chart has no color of their own: a lighter gray than the rest, without an outline
  const uncharted = rows.map((r, i) => (tops[i] != null && !names.includes(tops[i]) ? r.top[0].hours : 0));
  const top = { id: "top", itemStyle: { color: mix(t.surface, t.other, 0.6), ...edge(t.other, false), ...radius }, data: items("top", uncharted, (i) => ({ name: tops[i] })) };
  // The gray never dims either: it's the rest of the month, whoever is lit
  const gray = { id: "rest", itemStyle: { color: mix(t.surface, t.other, 0.35), ...edge(t.other, false) }, data: rest };
  return [gray, ...slices, ...topBlocks, top];
}

// Note what's on screen once `series` is set, and once any emptied bars have shrunk away, take their outlines off
function settleMonthly(el, st, series) {
  const was = st.last;
  st.last = new Map(series.filter((s) => s.id !== "rest").map((s) => [s.id, s.data.map((d) => d.value)]));
  clearTimeout(st.settle);
  const emptied = [...st.last].some(([id, vs]) => vs.some((v, i) => v === 0 && was?.get(id)?.[i] > 0));
  if (!emptied) return;
  st.settle = setTimeout(() => {
    if (monthlyState.get(el) !== st) return;
    const next = monthlySeries(st);
    instances.get(el)?.setOption({ series: next }, undefined, true);
    settleMonthly(el, st, next);
  }, MORPH_MS);
}

// Light one artist (and dim the rest) from a hover elsewhere on the page; null clears
export function focusMonthly(el, name) {
  const st = monthlyState.get(el);
  const c = instances.get(el);
  if (!st || !c) return;
  const next = name != null && st.names.includes(name) && !st.off.has(name) ? name : null;
  if (next === st.hovered) return;
  st.hovered = next;
  const series = monthlySeries(st);
  setOptionFaded(c, { series }, undefined, dur(FADE_MS)); // faded, as hover in the other charts is
  settleMonthly(el, st, series);
}

// When you listened: one small share stack graph per weekday, across the hours of the day, drawn like the rolling
// chart's Share mode (bands bottom up in rank order, a pale tint of each artist's color under an outline). With
// includeOther, the rest of the time is a gray "Everyone else" band on top; without, the shares are among the artists
// shown. grid is clockBy's, by the hour; the hours are smoothed around the week's clock (late Sunday runs into Monday
// morning) so a band doesn't jump between neighbouring hours. Pins and hover work as in renderMonthly (focusClock
// lights an artist from elsewhere): names/slots are the artists and their palette slots, off the deselected ones
// (already left out of grid's plays, so shares are of what's shown). sigma is the smoothing, in hours.
const clockState = new WeakMap();
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourLabel = (h) => (h % 24 === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

// Gaussian blur of a 168-hour ring
function blurRing(v, sigma) {
  if (!(sigma > 0)) return v;
  const n = v.length, r = Math.ceil(sigma * 3);
  const w = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  return v.map((_, i) => w.reduce((s, wj, j) => s + wj * v[(i + j - r + n) % n], 0));
}

export function renderClock(el, grid, names = [], slots = [], pins = null, hover = () => {}, off = new Set(), includeOther = true, sigma = 0.5) {
  const t = tokens();
  const all = [...names, "Everyone else"];
  const colors = [...names.map((n, k) => t.series[slots[k]]), t.other];
  const otherIdx = names.length;
  const c = chart(el);
  const prev = clockState.get(el);
  const fresh = !prev || prev.names.join("\u0000") !== names.join("\u0000");

  // Hours on the week's ring (168 hours from Monday midnight) for each series, then smoothed
  const ring = all.map((_, k) =>
    grid.flatMap((row) => row.map((e) => (k < otherIdx ? e.by[k] : includeOther ? Math.max(0, e.hours - e.by.reduce((x, y) => x + y, 0)) : 0)))
  );
  const smooth = ring.map((v) => blurRing(v, sigma));
  // Each hour's value sits at the middle of the hour; points go on the hour (0..24 each day), halfway between two
  const at = (v, d, h) => (v[(d * 24 + h - 1 + 168) % 168] + v[(d * 24 + h) % 168]) / 2;
  const hours = all.map((_, k) => DAYS.map((_, d) => Array.from({ length: 25 }, (_, h) => at(smooth[k], d, h))));
  const total = DAYS.map((_, d) => Array.from({ length: 25 }, (_, h) => all.reduce((s, _n, k) => s + hours[k][d][h], 0)));
  // Each band's share, and its bottom and top in the stack (for hover)
  const share = all.map((_, k) => DAYS.map((_, d) => total[d].map((tot, h) => (tot > 1e-9 ? hours[k][d][h] / tot : 0))));
  const bottom = all.map(() => DAYS.map(() => new Array(25).fill(0)));
  DAYS.forEach((_, d) => {
    for (let h = 0; h < 25; h++) {
      let acc = 0;
      all.forEach((_, k) => {
        bottom[k][d][h] = acc;
        acc += share[k][d][h];
      });
    }
  });

  const st = { names, all, colors, t, off, pinned: new Set(names.filter((n) => pins?.has(n) && !off.has(n))), hovered: prev?.hovered ?? null };
  st.zrMove = prev?.zrMove;
  st.zrOut = prev?.zrOut;
  st.zrClick = prev?.zrClick;
  clockState.set(el, st);

  // A row per weekday, each its own grid, with the hour labels under the last. Laid out in pixels from the chart's
  // height (the card sets it in CSS)
  const top = 8, bottomPad = 28, gap = 28;
  const each = ((el.clientHeight || 640) - top - bottomPad + gap) / 7;
  const grids = DAYS.map((_, d) => ({ left: 48, right: 16, top: top + d * each, height: each - gap }));

  const tip = (params) => {
    if (!params.length) return "";
    const d = params[0].axisIndex ?? 0;
    const h = Math.round(params[0].axisValue);
    const rows = all
      .map((n, k) => ({ k, s: share[k][d][h], hrs: hours[k][d][h] }))
      .filter((r) => r.s >= 0.005 && !off.has(all[r.k]))
      .sort((a, b) => b.k - a.k)
      .map((r) => row(colors[r.k], (r.s * 100).toFixed(0) + "%", all[r.k], all[r.k] === st.hovered));
    return `<div style="color:${t.muted};margin-bottom:4px">${DAYS[d]} around ${hourLabel(h)}</div>${rows.join("")}`;
  };

  setOptionFaded(
    c,
    {
      animation: true,
      animationDuration: ENTER_MS,
      animationDurationUpdate: MORPH_MS,
      animationEasingUpdate: EASE_IN_OUT.echarts,
      grid: grids,
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 }, triggerEmphasis: false },
        formatter: tip,
      },
      axisPointer: { triggerEmphasis: false, link: [{ xAxisIndex: "all" }] },
      xAxis: DAYS.map((_, d) => ({
        type: "value",
        gridIndex: d,
        min: 0,
        max: 24,
        interval: 3,
        ...baseAxis(t),
        axisLine: { show: false },
        splitLine: { show: false },
        axisLabel: { show: d === 6, color: t.muted, formatter: (v) => hourLabel(v) },
        axisPointer: { triggerEmphasis: false },
      })),
      yAxis: DAYS.map((day, d) => ({
        type: "value",
        gridIndex: d,
        min: 0,
        max: 1,
        ...baseAxis(t),
        axisLine: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        name: day,
        nameLocation: "middle",
        nameRotate: 0,
        nameGap: 14,
        nameTextStyle: { color: t.muted, align: "right" },
      })),
      series: DAYS.flatMap((_, d) =>
        all.map((n, k) => ({
          id: `c${d}_${k}`,
          name: n,
          type: "line",
          xAxisIndex: d,
          yAxisIndex: d,
          silent: true,
          symbol: "none",
          smooth: 0.3,
          // Stacked by hand, as in the rolling chart: each band is its top edge filled down to the axis, and the
          // bands below paint over it
          z: 2 + all.length - k,
          ...clockLook(st, k),
          data: share[k][d].map((s, h) => [h, bottom[k][d][h] + s]),
        }))
      ),
    },
    // Outlines and fills fade with the morph (deselecting an artist), rather than snapping before it
    { notMerge: fresh },
    fresh ? 0 : dur(MORPH_MS)
  );

  // Hover from the data, as in the rolling chart: the band under the pointer, in the row under it
  const zr = c.getZr();
  if (st.zrMove) {
    zr.off("mousemove", st.zrMove);
    zr.off("globalout", st.zrOut);
    zr.off("click", st.zrClick);
  }
  const pick = (px) => {
    const d = DAYS.findIndex((_, i) => c.containPixel({ gridIndex: i }, px));
    if (d < 0) return undefined;
    const [x, y] = c.convertFromPixel({ gridIndex: d }, px);
    const h = Math.max(0, Math.min(24, Math.round(x)));
    for (let k = 0; k < all.length; k++) {
      if (off.has(all[k])) continue;
      if (y >= bottom[k][d][h] && y <= bottom[k][d][h] + share[k][d][h] && share[k][d][h] > 0) return all[k];
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

// The style of artist k's bands: lit (pinned or hovered), dim (something else is lit) or at rest, as in the
// rolling chart's Share mode
function clockLook(st, k) {
  const { t, names, colors } = st;
  const col = colors[k];
  // A deselected artist has no share, so no outline either (a flat line would still draw)
  if (k < names.length && st.off.has(names[k])) return { lineStyle: { width: 0, opacity: 0 }, areaStyle: { color: mix(t.surface, col, t.shade.band), opacity: 1 } };
  const lit = new Set([...st.pinned, ...(st.hovered != null ? [st.hovered] : [])]);
  const rest = k === names.length; // the gray series is never lit
  const on = !rest && lit.has(names[k]);
  const dim = lit.size && !on;
  return {
    lineStyle: { color: dim ? mix(t.surface, col, 0.4) : col, width: on ? 2 : 1, opacity: 1 },
    areaStyle: { color: mix(t.surface, col, on ? t.shade.hover : dim ? t.shade.dim : t.shade.band), opacity: 1 },
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
  setOptionFaded(c, { series: DAYS.flatMap((_, d) => st.all.map((n, k) => ({ id: `c${d}_${k}`, ...clockLook(st, k) }))) }, undefined, dur(FADE_MS));
}

// Contributors by total hours, with the viewer's bin picked out in the accent.
export function renderHistogram(el, hours, yours) {
  const t = tokens();
  const max = Math.max(...hours, yours ?? 0);
  const step = [50, 100, 250, 500, 1000, 2500].find((s) => max / s <= 24) ?? 5000;
  const bins = new Array(Math.floor(max / step) + 1).fill(0);
  for (const h of hours) bins[Math.floor(h / step)]++;
  const you = yours == null ? -1 : Math.floor(yours / step);
  const range = (i) => `${(i * step).toLocaleString()}–${((i + 1) * step).toLocaleString()} h`;

  chart(el).setOption(
    {
      animationDuration: ENTER_MS,
      grid: { left: 40, right: 16, top: 24, bottom: 32 },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p) =>
          `<b>${p.value} ${p.value === 1 ? "person" : "people"}</b> <span style="opacity:.75">${range(p.dataIndex)}</span>` +
          (p.dataIndex === you ? `<div style="opacity:.75">You're here</div>` : ""),
      },
      xAxis: {
        type: "category",
        data: bins.map((_, i) => (i * step).toLocaleString()),
        ...baseAxis(t),
        splitLine: { show: false },
      },
      yAxis: { type: "value", minInterval: 1, ...baseAxis(t), axisLine: { show: false } },
      series: [
        {
          type: "bar",
          barMaxWidth: 24,
          data: bins.map((v, i) => ({
            value: v,
            itemStyle: { color: i === you ? t.accent : t.other, borderRadius: [4, 4, 0, 0] },
          })),
          // A marker rather than a bar label, so it shows even when no one else is in your bin
          markLine: you < 0 ? undefined : {
            silent: true,
            symbol: "none",
            lineStyle: { color: t.accent, width: 2, type: "solid" },
            label: { formatter: "You", color: t.primary, fontWeight: 600 },
            data: [{ xAxis: you }],
          },
        },
      ],
    },
    { notMerge: true }
  );
}

// Share of listening by hour of day: viewer vs community.
export function renderHourLines(el, community, yours) {
  const t = tokens();
  const labels = Array.from({ length: 24 }, (_, h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`));
  const series = [{ name: "Community", data: community, color: t.muted }];
  if (yours) series.push({ name: "You", data: yours, color: t.accent });

  chart(el).setOption(
    {
      animationDuration: ENTER_MS,
      grid: { left: 40, right: 16, top: 40, bottom: 32 },
      legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 14, itemHeight: 2, itemStyle: { borderWidth: 0 }, textStyle: { color: t.secondary } },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 } },
        formatter: (params) =>
          `<div style="color:${t.muted};margin-bottom:4px">${labels[params[0].dataIndex]}</div>` +
          params.map((p) => row(p.color, (p.value * 100).toFixed(1) + "%", p.seriesName)).join(""),
      },
      xAxis: { type: "category", data: labels, boundaryGap: false, ...baseAxis(t), splitLine: { show: false } },
      yAxis: {
        type: "value",
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => `${Math.round(v * 100)}%` },
      },
      series: series.map((s) => ({
        name: s.name,
        type: "line",
        color: s.color,
        data: s.data,
        showSymbol: false,
        symbolSize: 8,
        lineStyle: { width: 2, color: s.color, cap: "round", join: "round" },
        itemStyle: { color: s.color, borderColor: t.surface, borderWidth: 2 },
      })),
    },
    { notMerge: true }
  );
}


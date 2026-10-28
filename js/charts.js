// ECharts renderers. Colors come from the CSS tokens so light/dark stay in one place (style.css).

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
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`--series-${i}`)),
    seq: [0, 1, 2, 3, 4, 5].map((i) => v(`--seq-${i}`)),
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

// Rolling chart fills, as the share of the artist's color mixed into the surface (bands) or as opacity
// (hours): every band at rest, the hovered band, and the fill under the hovered hours line
const BAND_SHADE = 0.05;
const HOVER_FILL = 0.2;
const LINE_SHADE = 0.05;

// Legend selections per rolling chart, kept across morphs and reset when the artist list changes.
const rollingState = new WeakMap();

// ECharts applies style changes instantly, and re-rendering every frame is too slow (~20ms) to tween
// them, so fades animate the drawn shapes directly: note each series' fill and line as drawn, apply the
// new options, then animate every shape from the old look to the new. This reaches into ECharts
// internals (each series view's _polygon and _polyline, as of 5.6); without them, changes just snap.
const pickStyle = (st) =>
  Object.fromEntries(["fill", "stroke", "opacity", "lineWidth"].filter((k) => st[k] != null).map((k) => [k, st[k]]));
function drawnShapes(c) {
  const shapes = new Map();
  for (const m of c.getModel()?.getSeries() ?? []) {
    const v = c.getViewOfSeriesModel?.(m);
    if (v?._polygon) shapes.set(`${m.id}:area`, v._polygon);
    if (v?._polyline) shapes.set(`${m.id}:line`, v._polyline);
  }
  return shapes;
}
function setOptionFaded(c, option, opts, ms) {
  const shapes = drawnShapes(c);
  const before = new Map([...shapes].map(([k, e]) => [k, pickStyle(e.style)]));
  // Stop earlier fades first: zrender moves a running animation onto the new style object ECharts
  // swaps in, so one left running would paint its old target over the new look
  for (const e of shapes.values()) e.stopAnimation("fade");
  c.setOption(option, opts);
  if (!ms) return;
  for (const [k, e] of drawnShapes(c)) {
    const to = pickStyle(e.style);
    const from = before.get(k) ?? { ...to, opacity: 0 }; // a shape that just appeared fades in
    // Fading from or to invisible changes only opacity: tweening the color as well would show a
    // blend of the two colors partway, though neither end shows any color at all
    let end = to;
    if (from.opacity === 0) Object.assign(from, { fill: to.fill, stroke: to.stroke });
    else if (to.opacity === 0) end = { ...from, opacity: 0 };
    e.setStyle(from);
    e.animateTo({ style: end }, { duration: ms, easing: "cubicOut", scope: "fade", done: () => e.setStyle(to) });
  }
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
// Share mode draws each band as a 2px line in the artist's color over a pale tint of it (BAND_SHADE).
// Each band also has two silent overlay lines, its top (t) and bottom (b) edge, drawn above every band.
// They're hidden except to outline the hovered band all the way round.
//
// pins: optional { has(name), unpin(name) } for artists the reader pinned; their legend chips get an ×.
export function renderRolling(el, data, names, window, zoom, mode = "share", hasOther = false, morph = false, pins = null) {
  const t = tokens();
  const c = chart(el);
  const share = mode === "share";
  const otherIdx = hasOther ? names.length - 1 : -1;
  // "Everyone else" is always gray, never borrowing the next artist's slot
  const colors = names.map((_, i) => (i === otherIdx ? t.other : t.series[i]));
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const perWeek = (h) => (h / window) * 7;

  let st = rollingState.get(el);
  if (!st || st.names.join("\u0000") !== names.join("\u0000")) {
    // Keep the old pointer handlers' references, so they're removed below rather than left running
    // against the previous artists alongside the new ones
    st = { names, selected: Object.fromEntries(names.map((n) => [n, true])), zrMove: st?.zrMove, zrOut: st?.zrOut };
    rollingState.set(el, st);
  }
  st.args = [data, names, window, zoom, mode, hasOther, pins];
  if (Number.isFinite(zoom?.[0])) st.zoom = zoom; // for currentZoom, if hiding every artist loses the range
  const visible = (s) => st.selected[names[s]] !== false;

  // Fills stay opaque tints, not transparency, because bands overlap down to the axis
  const fills = colors.map((c) => mix(t.surface, c, BAND_SHADE));

  // Cumulative share over visible series; a hidden series collapses onto the band below it
  const top = names.map(() => new Array(data.dates.length));
  const bottom = names.map(() => new Array(data.dates.length));
  for (let i = 0; i < data.dates.length; i++) {
    let run = 0;
    for (let s = 0; s < names.length; s++) {
      const v = data.share[s][i];
      if (v == null) { top[s][i] = bottom[s][i] = null; continue; }
      bottom[s][i] = run;
      if (visible(s)) run += v;
      top[s][i] = run;
    }
  }

  // Edge overlays break off wherever the band is too thin to see, so absent artists leave no line
  const edgeData = (s, side) =>
    data.dates.map((d, i) => {
      if (!share) return [d, s === otherIdx ? 0 : perWeek(data.hours[s][i])];
      const lo = bottom[s][i], hi = top[s][i];
      if (lo == null || hi - lo < 0.002) return [d, null];
      return [d, side === "t" ? hi : lo];
    });
  const overlayStyle = (s, on) => ({ width: 2, color: colors[s], opacity: on && share ? 1 : 0, cap: "round", join: "round" });

  const series = names
    .map((name, s) => {
      const hide = !share && s === otherIdx;
      return {
        id: `s${s}`,
        name,
        type: "line",
        showSymbol: false,
        symbol: "none",
        color: colors[s],
        // Lower bands paint over the bottom of the ones above them. That order has to be explicit:
        // ECharts paints series in the order their views were created, so artists added later (raising
        // the artist count) would otherwise paint over everything below them
        z: (share ? 2 : 3) + (names.length - s) / 100,
        // Share: the line on each band's top edge is its border with the band above
        lineStyle: { width: 2, color: colors[s], opacity: hide ? 0 : 1, cap: "round", join: "round" },
        // Every series ignores the pointer; the plot works out what's under it from the data (see zrMove).
        silent: true,
        // Hours mode keeps an invisible fill, so the hovered line's shading and the morph back into
        // bands can fade it in rather than have it appear
        areaStyle: { color: share ? fills[s] : colors[s], opacity: share ? 1 : 0, origin: "start" },
        // Share mode: ECharts' hover emphasis clears itself on stacked areas, so bands are faded by
        // hand instead (see focusBand below). Hours mode: built-in emphasis on the hovered line.
        emphasis: share
          ? { disabled: true, areaStyle: null, lineStyle: null }
          : { disabled: false, focus: "series", areaStyle: null, lineStyle: { width: 3 } },
        blur: share
          ? { areaStyle: null, lineStyle: null }
          : { areaStyle: null, lineStyle: { opacity: hide ? 0 : 0.2 } },
        data: data.dates.map((d, i) => [d, share ? top[s][i] : hide ? 0 : perWeek(data.hours[s][i])]),
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
          color: colors[s],
          z: 4,
          lineStyle: overlayStyle(s, false),
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
      .map((p) => ({ p, share: data.share[sIdx(p)][i], hours: data.hours[sIdx(p)][i] }))
      // Drop anyone who would read as 0%
      .filter((r) => r.share >= 0.005)
      .sort((a, b) => b.share - a.share)
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

  setOptionFaded(
    c,
    {
      // No animation on first draw or data changes; only morphs between modes tween
      animation: true,
      animationDuration: 0,
      animationDurationUpdate: morph ? 750 : 0,
      animationEasingUpdate: "cubicInOut",
      animationThreshold: 100000, // the default (2000 points) would silently disable the morph
      grid: { left: 48, right: 16, top: 12, bottom: 72 },
      // Hidden: it only holds which artists are shown. The visible legend is HTML (renderLegend), so
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
      // Slider only: an "inside" dataZoom swallows wheel events even with wheel zoom off,
      // which stops the page scrolling while the pointer is over the chart
      dataZoom: [
        {
          type: "slider",
          startValue: zoom?.[0],
          endValue: zoom?.[1],
          bottom: 12,
          height: 32,
          borderColor: t.grid,
          fillerColor: "rgba(127,127,127,0.12)",
          handleStyle: { color: t.surface, borderColor: t.axis },
          moveHandleStyle: { color: t.axis },
          textStyle: { color: t.muted },
          dataBackground: { lineStyle: { color: t.axis }, areaStyle: { color: t.grid } },
          selectedDataBackground: { lineStyle: { color: t.accent }, areaStyle: { color: t.accent, opacity: 0.15 } },
        },
      ],
      series,
    },
    // Morphs merge by series id, so points tween instead of redrawing, while fills and lines fade
    { notMerge: !morph },
    morph ? 750 : 0
  );

  // Share mode: highlight the band under the pointer by emptying every other band down to its outline
  // and filling the hovered one in (HOVER_FILL), strongly enough to stand out even when the bands are
  // unshaded. The hovered band's edge overlays draw its whole border, bottom included.
  const focusFill = (k, sIndex) => (sIndex == null ? fills[k] : sIndex === k ? mix(t.surface, colors[k], HOVER_FILL) : t.surface);
  const focusBand = (sIndex) => {
    if (sIndex === focused) return;
    focused = sIndex;
    setOptionFaded(c, {
      animationDurationUpdate: 0,
      series: names.flatMap((_, k) => [
        { id: `s${k}`, areaStyle: { color: focusFill(k, sIndex) } },
        { id: `t${k}`, lineStyle: overlayStyle(k, k === sIndex) },
        { id: `b${k}`, lineStyle: overlayStyle(k, k === sIndex) },
      ]),
    }, undefined, 200);
  };
  // Hours mode: thicken one line and fade the rest, by restyling directly (ECharts' own blur state is
  // cleared on every pointer move over empty plot space, which is all of it once lines are silent).
  // With LINE_SHADE on, only the focused line gets a faint fill; nothing is filled at rest.
  const focusLine = (k) => {
    if (k === focused) return;
    focused = k;
    setOptionFaded(c, {
      animationDurationUpdate: 0,
      series: names.map((_, j) => {
        const gone = j === otherIdx;
        const on = k == null || j === k;
        return {
          id: `s${j}`,
          lineStyle: { width: j === k ? 3 : 2, opacity: gone ? 0 : on ? 1 : 0.2 },
          areaStyle: { opacity: !gone && j === k ? LINE_SHADE : 0 },
        };
      }),
    }, undefined, 200);
  };

  // Highlight an artist from outside the plot (legend, top lists): their band in share mode, their
  // line in hours mode. null, or an artist not in the chart, clears it.
  st.focusArtist = (name) => {
    let k = name == null ? -1 : names.indexOf(name);
    if (!share && k === otherIdx) k = -1; // "Everyone else" isn't drawn in hours mode
    (share ? focusBand : focusLine)(k < 0 ? null : k);
  };

  // The tooltip formats before the pointer handler runs, so redraw it once the focused series is known
  const retip = (x, y) => c.dispatchAction({ type: "showTip", x, y });

  // Plot hover, worked out from the data rather than from which shape is under the pointer (every
  // series is silent, so ECharts never applies its own highlight states, which break overlapping bands):
  // share mode focuses the band the pointer is inside; hours mode focuses the topmost line at that date.
  const zr = c.getZr();
  if (st.zrMove) {
    zr.off("mousemove", st.zrMove);
    zr.off("globalout", st.zrOut);
  }
  let fromPlot = false; // only clear focus the plot set, not a legend or list hover's
  const focus = share ? focusBand : focusLine;
  st.zrMove = (e) => {
    const px = [e.offsetX, e.offsetY];
    if (!c.containPixel({ gridIndex: 0 }, px)) {
      if (fromPlot) focus(null);
      fromPlot = false;
      return;
    }
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
    fromPlot = true;
    if (best !== focused) {
      focus(best);
      retip(...px);
    }
  };
  st.zrOut = () => { if (fromPlot) focus(null); fromPlot = false; };
  zr.on("mousemove", st.zrMove);
  zr.on("globalout", st.zrOut);

  // Showing or hiding artists re-stacks the bands around them, as a morph
  const restack = () => {
    const [d, n, w, , m, o, p] = st.args;
    renderRolling(el, d, n, w, currentZoom(el), m, o, true, p);
  };
  renderLegend(el, names, colors, visible, otherIdx, {
    hover: (name) => st.focusArtist(name),
    toggle: (name) => c.dispatchAction({ type: "legendToggleSelect", name }),
    // Several at once in a single re-stack, rather than one morph per artist
    showAll: (list, show) => {
      for (const name of list) st.selected[name] = show;
      restack();
    },
    pins,
  });

  // (legendToggleSelect fires legendselectchanged; other legend actions fire the other two)
  for (const ev of ["legendselectchanged", "legendselected", "legendunselected"]) {
    c.off(ev);
    c.on(ev, (e) => {
      st.selected = { ...e.selected };
      restack();
    });
  }
}

// HTML legend in the Artists panel above a rolling chart: hover highlights an artist, click shows/hides
// them. The top artists sit above the search, led by a small checkbox that shows or hides them
// together; pinned ones sit below it, each outlined in its artist's color with an × that unpins it.
// "Everyone else" isn't listed: it's a switch in the panel's corner.
function renderLegend(el, names, colors, visible, otherIdx, { hover, toggle, showAll, pins }) {
  const card = el.closest(".card");
  const item = (name, k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "legend-item";
    b.title = name;
    b.setAttribute("aria-pressed", visible(k));
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = colors[k];
    const label = document.createElement("span");
    label.className = "name";
    label.textContent = name; // artist names come from user files
    b.append(sw, label);
    b.addEventListener("pointerenter", () => hover(name));
    b.addEventListener("pointerleave", () => hover(null));
    b.addEventListener("click", () => toggle(name));
    if (!pins?.has(name)) return b;
    // A sibling, not a child: buttons can't nest
    const x = document.createElement("button");
    x.type = "button";
    x.className = "legend-unpin";
    x.textContent = "×";
    x.setAttribute("aria-label", `Unpin ${name}`);
    x.title = "Unpin";
    x.addEventListener("click", () => {
      hover(null);
      pins.unpin(name);
    });
    const wrap = document.createElement("span");
    wrap.className = "legend-pin";
    wrap.style.setProperty("--c", colors[k]);
    wrap.append(b, x);
    return wrap;
  };
  const shown = names.map((name, k) => [name, k]).filter(([, k]) => k !== otherIdx);
  const pinned = shown.filter(([name]) => pins?.has(name));
  card.querySelector(".pinned-legend").replaceChildren(...pinned.map(([n, k]) => item(n, k)));
  const top = shown.filter(([name]) => !pins?.has(name));
  // Checked when every unpinned artist is shown, mixed when some are; a click shows them all, or hides
  // them all once they're all shown
  const on = top.filter(([, k]) => visible(k)).length;
  const all = document.createElement("button");
  all.type = "button";
  all.className = "legend-item legend-all";
  all.setAttribute("role", "checkbox");
  all.setAttribute("aria-checked", on === top.length ? "true" : on ? "mixed" : "false");
  all.title = on === top.length ? "Hide all top artists" : "Show all top artists";
  all.setAttribute("aria-label", all.title);
  all.addEventListener("click", () => showAll(top.map(([name]) => name), on !== top.length));
  card.querySelector(".top-legend").replaceChildren(...(top.length ? [all] : []), ...top.map(([n, k]) => item(n, k)));
}

// Highlight an artist in a rolling chart from elsewhere on the page; null clears.
export function focusArtist(el, name) {
  rollingState.get(el)?.focusArtist?.(name);
}

export function renderMonthly(el, rows) {
  const t = tokens();
  const label = (d) => d.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  // One year: label every month. Longer: label each January with its year.
  const oneYear = rows.length <= 13;
  const tick = (r) =>
    oneYear ? r.month.toLocaleDateString(undefined, { month: "short" }) : r.month.getMonth() === 0 ? String(r.month.getFullYear()) : "";
  chart(el).setOption(
    {
      animationDuration: 400,
      grid: { left: 48, right: 16, top: 16, bottom: 32 },
      tooltip: {
        ...tooltipBase(t),
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1 } },
        formatter: (params) => `<b>${fmtHours(params[0].value)}</b> <span style="opacity:.75">${label(rows[params[0].dataIndex].month)}</span>`,
      },
      xAxis: {
        type: "category",
        data: rows.map(tick),
        ...baseAxis(t),
        boundaryGap: false,
        axisLabel: { color: t.muted, interval: 0 },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        ...baseAxis(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v) => `${v} h` },
      },
      series: [
        {
          type: "line",
          // Dots only when there are few enough months to tell apart
          showSymbol: oneYear,
          symbol: "circle",
          symbolSize: 8,
          color: t.accent,
          lineStyle: { width: 2, color: t.accent, cap: "round", join: "round" },
          itemStyle: { color: t.accent, borderColor: t.surface, borderWidth: 2 },
          areaStyle: { color: t.accent, opacity: 0.1 },
          emphasis: { scale: 1.25 },
          data: rows.map((r) => r.hours),
        },
      ],
    },
    { notMerge: true }
  );
}

export function renderClock(el, grid) {
  const t = tokens();
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`));
  const data = [];
  let max = 0;
  grid.forEach((row, d) => row.forEach((v, h) => { data.push([h, d, v]); max = Math.max(max, v); }));

  chart(el).setOption(
    {
      animationDuration: 400,
      grid: { left: 48, right: 16, top: 8, bottom: 56 },
      tooltip: {
        ...tooltipBase(t),
        trigger: "item",
        formatter: (p) => `<b>${fmtHours(p.value[2])}</b> <span style="opacity:.75">${days[p.value[1]]} ${hours[p.value[0]]}</span>`,
      },
      xAxis: { type: "category", data: hours, ...baseAxis(t), axisLine: { show: false }, splitLine: { show: false } },
      yAxis: { type: "category", data: days, inverse: true, ...baseAxis(t), axisLine: { show: false }, splitLine: { show: false } },
      visualMap: {
        min: 0,
        max,
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemHeight: 160,
        itemWidth: 10,
        text: [fmtHours(max), "0 h"],
        textStyle: { color: t.muted },
        inRange: { color: t.seq },
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 4 },
          emphasis: { itemStyle: { borderColor: t.primary, borderWidth: 1 } },
        },
      ],
    },
    { notMerge: true }
  );
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
      animationDuration: 400,
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
      animationDuration: 400,
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


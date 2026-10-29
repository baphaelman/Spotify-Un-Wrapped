// Shared chart motion: durations and the helpers that tween what ECharts would otherwise snap.
// Chart renderers import from here rather than choosing their own timings, so every graph moves alike.

export const MORPH_MS = 750; // data or layout changes: points tween between old and new
export const FADE_MS = 200; // hover and highlight restyles

// ECharts applies style changes instantly, and re-rendering every frame is too slow (~20ms) to tween
// them, so fades animate the drawn shapes directly: note each series' fill and line as drawn, apply the
// new options, then animate every shape from the old look to the new. This reaches into ECharts
// internals (each series view's _polygon and _polyline, as of 5.6); without them, changes just snap.
const pickStyle = (st) =>
  Object.fromEntries(["fill", "stroke", "opacity", "lineWidth"].filter((k) => st[k] != null).map((k) => [k, st[k]]));

export function drawnShapes(c) {
  const shapes = new Map();
  for (const m of c.getModel()?.getSeries() ?? []) {
    const v = c.getViewOfSeriesModel?.(m);
    if (v?._polygon) shapes.set(`${m.id}:area`, v._polygon);
    if (v?._polyline) shapes.set(`${m.id}:line`, v._polyline);
  }
  return shapes;
}

// setOption, then fade every drawn shape from its old style to its new one over `ms`. Also tweens the
// curve rounding (`shape.smooth`), which ECharts would otherwise swap instantly while the points move.
export function setOptionFaded(c, option, opts, ms) {
  const shapes = drawnShapes(c);
  const before = new Map([...shapes].map(([k, e]) => [k, { style: pickStyle(e.style), smooth: +e.shape.smooth || 0 }]));
  // Stop earlier fades first: zrender moves a running animation onto the new style object ECharts
  // swaps in, so one left running would paint its old target over the new look
  for (const e of shapes.values()) e.stopAnimation("fade");
  c.setOption(option, opts);
  if (!ms) return;
  for (const [k, e] of drawnShapes(c)) {
    const to = pickStyle(e.style);
    const was = before.get(k);
    const from = was ? { ...was.style } : { ...to, opacity: 0 }; // a shape that just appeared fades in
    // Fading from or to invisible changes only opacity: tweening the color as well would show a
    // blend of the two colors partway, though neither end shows any color at all
    let end = to;
    if (from.opacity === 0) Object.assign(from, { fill: to.fill, stroke: to.stroke });
    else if (to.opacity === 0) end = { ...from, opacity: 0 };
    e.setStyle(from);
    e.animateTo({ style: end }, { duration: ms, easing: "cubicOut", scope: "fade", done: () => e.setStyle(to) });
    const smoothTo = +e.shape.smooth || 0;
    if (was && was.smooth !== smoothTo) {
      e.setShape({ smooth: was.smooth });
      e.animateTo({ shape: { smooth: smoothTo } }, { duration: ms, easing: "cubicInOut", scope: "fade", done: () => e.setShape({ smooth: smoothTo }) });
    }
  }
}

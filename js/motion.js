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
export function setOptionFaded(c, option, opts, ms, easing = "cubicInOut") {
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
      e.animateTo({ shape: { smooth: smoothTo } }, { duration: ms, easing, scope: "fade", done: () => e.setShape({ smooth: smoothTo }) });
    }
  }
}

// Steps a value through keyframes by chaining short morphs: `apply(t, segMs)` is called at the start of
// each of `steps` equal segments with t in (0, 1], already eased, and should morph to that value over
// segMs with a linear easing. For changes where tweening each point straight between the ends would look
// wrong, like a blur radius, which should sweep through every radius in between. A newer sweep (or
// cancel()) stops the one before; returns when it finished via the promise.
let sweepToken = 0;
export const cancelSweep = () => void sweepToken++;
export function sweep(apply, ms = MORPH_MS, steps = 8, ease = (t) => t * t * (3 - 2 * t)) {
  const token = ++sweepToken;
  const segMs = ms / steps;
  const start = performance.now();
  return new Promise((resolve) => {
    const step = (k) => {
      if (token !== sweepToken) return resolve(false);
      apply(ease(k / steps), segMs);
      if (k === steps) return setTimeout(() => resolve(token === sweepToken), segMs);
      // Aim for the next segment's slot on the clock, so the time apply() takes doesn't pile up
      setTimeout(() => step(k + 1), Math.max(0, start + (k * ms) / steps - performance.now()));
    };
    step(1);
  });
}

// ---------- Page motion (DOM, not charts) ----------

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
// A duration, or 0 when the visitor asked for less motion
export const dur = (ms) => (reduced.matches ? 0 : ms);
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Counts a number up or down inside `el`. Remembers where it got to (el._num), so an interrupted count
// carries on from what's showing; pass `from` for an element that was just rebuilt.
export function tweenNumber(el, to, { format = (n) => Math.round(n).toLocaleString(), from, ms = MORPH_MS } = {}) {
  cancelAnimationFrame(el._raf);
  const start = from ?? el._num ?? to;
  const total = dur(ms);
  if (start === to || !total) {
    el._num = to;
    el.textContent = format(to);
    return;
  }
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / total);
    el._num = t === 1 ? to : start + (to - start) * easeInOut(t);
    el.textContent = format(el._num);
    if (t < 1) el._raf = requestAnimationFrame(tick);
  };
  el._num = start;
  el.textContent = format(start);
  el._raf = requestAnimationFrame(tick);
}

// FLIP: `before` is Map(key -> DOMRect) measured before the DOM changed, `els` is Map(key -> element)
// after. Elements that were there glide from their old spot; new ones rise in, staggered.
export function flip(before, els, { ms = MORPH_MS, stagger = 18 } = {}) {
  const total = dur(ms);
  if (!total) return;
  let n = 0;
  for (const [key, el] of els) {
    const was = before.get(key);
    if (!was) {
      el.animate(
        [{ opacity: 0, transform: "translateY(10px) scale(0.97)" }, { opacity: 1, transform: "none" }],
        { duration: total * 0.6, delay: Math.min(n++ * stagger, 240), easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" }
      );
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: total, easing: "cubic-bezier(.65,0,.35,1)" });
  }
}

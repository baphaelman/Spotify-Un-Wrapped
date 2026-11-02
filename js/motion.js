// The page's motion: its timings, its two easings, and the helpers that tween what ECharts would otherwise
// snap. Every animation takes its duration and easing from here (or, in CSS, from the matching --motion-*
// and --ease-* tokens in style.css), never a number of its own, so everything moves alike. The rules for
// choosing are under "Motion" in CLAUDE.md.

// Durations, by what is moving. Keep them in step with the --motion-* tokens in style.css.
export const FADE_MS = 200; // a highlight: hover, focus, a menu opening. Eases out
export const GROW_MS = 250; // a small reflow: a row of chips appearing, a dialog. Eases out
export const CHASE_MS = 450; // a morph that follows a moving input (a dragged period window), each cut short by the next. Eases out
export const ENTER_MS = 550; // something appearing for the first time: the dashboard, a chart's first draw. Eases out
export const MORPH_MS = 750; // the data changes: bands, bars, list rows, numbers and the mix bar move from old to new. In-out
export const PAN_MS = 900; // the view travels to another period of the same length. In-out; a different length adds time (scaledMs)
export const STAGGER_MS = 18; // between items entering one after another, up to STAGGER_MAX_MS in all
export const STAGGER_MAX_MS = 240;

// How long a change takes, by how big it is. `from` and `to` are the old and new value of anything that scales
// (a period's length, days per slice, a blur radius): the size of the change is the number of doublings between
// them, so 15 → 30 days and 30 → 60 are alike, and each doubling adds `perOctave` ms to the `base` time, up to
// `max`. A small change takes its tier's time; a big one takes longer, so it never rushes. Values at or below 0
// count as `floor` (a blur radius of 0). Zero under reduced motion.
const OCTAVE_MS = 380; // added per doubling
const SCALED_MAX_MS = 2200; // the longest any one movement takes
export function scaledMs(from, to, base = MORPH_MS, perOctave = OCTAVE_MS, floor = 1) {
  const octaves = Math.abs(Math.log2(Math.max(to, floor) / Math.max(from, floor)));
  return dur(Math.min(SCALED_MAX_MS, base + perOctave * octaves));
}
// How many keyframes a sweep of `ms` wants: about one per 94 ms (the default's eight over MORPH_MS), so a slower
// sweep keeps its steps as fine
export const sweepSteps = (ms) => Math.max(8, Math.round(ms / 94));

// The range [lo, hi] a fraction e of the way from range a to range b, as one steady zoom: scale and position
// both change in constant proportion, so a zoom reads as a constant rate rather than rushing at the start
// (moving the two ends linearly does, when the spans differ a lot). It is a zoom about the one point that
// stays put between a and b (the shared right edge, for a window resized from its right end). The chart's
// pan and the period bar's window frame both take their place from it, so they always agree.
export function travel(a, b, e) {
  if (e >= 1) return [b[0], b[1]];
  const sa = a[1] - a[0], sb = b[1] - b[0];
  if (!(sa > 0 && sb > 0) || Math.abs(Math.log(sb / sa)) < 0.05) return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
  const p = ((a[0] - a[0]) * (b[1] - a[0]) - (a[1] - a[0]) * (b[0] - a[0])) / (sb - sa); // the fixed point, from a[0]
  const k = Math.exp(Math.log(sb / sa) * e);
  return [a[0] + p + (0 - p) * k, a[0] + p + (sa - p) * k];
}

// The hover/pin rule (docs/motion.md): how lit an item is, given the pinned items (only those drawn) and the
// hovered one (null for none). A hover only glances: a lighter shade, and the others dim a little. A pin commits:
// a deeper shade, the only stronger outline, and the others dim more; hovering a pin deepens it again. Each look
// names a --shade-* token (rest is --shade-band) and, for the dimmed two, a --fade-* one, so every graph, chip
// and card shows the same steps.
export function litLook(pinned, hovered, item) {
  const pin = pinned.has(item), hover = hovered != null && item === hovered;
  if (pin) return hover ? "pinHover" : "pin";
  if (hover) return "hover";
  return pinned.size ? "dim" : hovered != null ? "dimHover" : "rest";
}
export const SHADE_TOKENS = { rest: "band", hover: "hover", pin: "pin", pinHover: "pin-hover", dim: "dim", dimHover: "dim-hover" };
export const isLitLook = (look) => look === "hover" || look === "pin" || look === "pinHover";
export const isPinLook = (look) => look === "pin" || look === "pinHover";

// The two easings. In-out for things that travel on their own from one state to another; out for anything
// answering the pointer or arriving, so it responds at once and settles. Each as a JS function, an
// ECharts/zrender name and a CSS curve.
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const EASE_IN_OUT = { js: easeInOut, echarts: "cubicInOut", css: "cubic-bezier(.65,0,.35,1)" };
export const EASE_OUT = { js: easeOut, echarts: "cubicOut", css: "cubic-bezier(.2,.7,.2,1)" };

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
    // Bars: one rect per data item
    if (m.subType === "bar") {
      const data = m.getData();
      for (let i = 0; i < data.count(); i++) {
        const el = data.getItemGraphicEl(i);
        if (el) shapes.set(`${m.id}:${i}`, el);
      }
    }
    // Dots: each symbol's path, by name (a few hundred at most; bigger layers fade as a whole, see dimRest)
    if (m.subType === "scatter" && m.getData().count() <= 300) {
      const data = m.getData();
      for (let i = 0; i < data.count(); i++) {
        const el = data.getItemGraphicEl(i)?.childAt?.(0);
        if (el) shapes.set(`dot:${m.id}:${data.getName(i)}`, el);
      }
    }
  }
  return shapes;
}

// setOption, then fade every drawn shape from its old style to its new one over `ms`. Also tweens the
// curve rounding (`shape.smooth`), which ECharts would otherwise swap instantly while the points move.
export function setOptionFaded(c, option, opts, ms, easing = EASE_IN_OUT.echarts) {
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
    // A new dot grows in on ECharts' own entrance; faded in as well, a render cutting the fade short would leave it
    // invisible (ECharts doesn't set a dot's opacity again)
    if (!was && k.startsWith("dot:")) continue;
    const from = was ? { ...was.style } : { ...to, opacity: 0 }; // a shape that just appeared fades in
    // Fading from or to invisible changes only opacity: tweening the color as well would show a
    // blend of the two colors partway, though neither end shows any color at all
    let end = to;
    if (from.opacity === 0) Object.assign(from, { fill: to.fill, stroke: to.stroke });
    else if (to.opacity === 0) end = { ...from, opacity: 0 };
    e.setStyle(from);
    e.animateTo({ style: end }, { duration: ms, easing: EASE_OUT.echarts, scope: "fade", done: () => e.setStyle(to) });
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
// (Its default easing is a gentler in-out, smoothstep: the segments between keyframes are linear, and a cubic
// would make the middle ones jump.)
// Each keyframe is morphed to by the time the next one starts, on the clock. Where drawing a keyframe takes this
// machine more than half a segment (a long period's chart), the sweep skips ahead to the keyframe that leaves as long
// again for drawing the tween to it, rather than queueing every keyframe and stretching out: fewer, longer segments,
// and the sweep keeps its length.
export function sweep(apply, ms = MORPH_MS, steps = 8, ease = (t) => t * t * (3 - 2 * t)) {
  const token = ++sweepToken;
  const segMs = ms / steps;
  const start = performance.now();
  let k = 0;
  let cost = 0; // what the last keyframe took to draw
  return new Promise((resolve) => {
    const step = () => {
      if (token !== sweepToken) return resolve(false);
      const now = performance.now();
      k = Math.min(steps, Math.max(k + 1, Math.round((now + Math.max(segMs, 2 * cost) - start) / segMs)));
      const due = start + k * segMs; // when this keyframe should be reached, and the next begin
      apply(ease(k / steps), Math.max(segMs / 2, due - now));
      cost = performance.now() - now;
      if (k === steps) return setTimeout(() => resolve(token === sweepToken), Math.max(0, due - performance.now()));
      setTimeout(step, Math.max(0, due - performance.now()));
    };
    step();
  });
}

// ---------- Page motion (DOM, not charts) ----------

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
// A duration, or 0 when the visitor asked for less motion
export const dur = (ms) => (reduced.matches ? 0 : ms);

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
export function flip(before, els, { ms = MORPH_MS, stagger = STAGGER_MS } = {}) {
  const total = dur(ms);
  if (!total) return;
  let n = 0;
  for (const [key, el] of els) {
    const was = before.get(key);
    if (!was) {
      el.animate(
        [{ opacity: 0, transform: "translateY(10px) scale(0.97)" }, { opacity: 1, transform: "none" }],
        { duration: dur(ENTER_MS), delay: Math.min(n++ * stagger, STAGGER_MAX_MS), easing: EASE_OUT.css, fill: "backwards" }
      );
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: total, easing: EASE_IN_OUT.css });
  }
}

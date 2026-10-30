# Motion: the full rules

CLAUDE.md has the tiers and the short form of each rule. This is the long form, with the worked examples
behind them. Read it before adding or changing an animation.

Everything on the page moves on one set of timings, so a single action reads as one movement. Durations
and easings live in `js/motion.js` and, mirrored, as the `--motion-*` and `--ease-*` tokens at the top of
`css/style.css` (keep the two in step). **Never write a duration or easing literal:** pick the tier that
matches what is moving.

| Tier | ms | Easing | For |
|---|---|---|---|
| `FADE_MS` / `--motion-fade` | 200 | out | A highlight: hover, focus, a pressed or hovered control, a menu opening |
| `GROW_MS` / `--motion-grow` | 250 | out | A small reflow: a row of chips appearing, a dialog, re-blurring after a zoom |
| `CHASE_MS` | 450 | out | A morph following a moving input (a dragged period window), each cut short by the next |
| `ENTER_MS` / `--motion-enter` | 550 | out | First appearance: the dashboard rising in, a chart's first draw, a new list row |
| `MORPH_MS` / `--motion-morph` | 750 | in-out | The data changes: bands, bars, list rows, numbers, the mix bar, the bar's timeline |
| `PAN_MS` | 900 | in-out | The view travels to another period of the same length |
| `scaledMs` | 900 – 2200 | in-out | A change that has a size: the view zooming to a period of another length (from `PAN_MS`), days per slice, a blur radius (from `MORPH_MS`) |
| `--motion-theme` | 350 | CSS `ease` | Colors cross-fading when the theme flips (CSS only) |

- **Two easings.** In-out (`EASE_IN_OUT`, `--ease-in-out`) for things that travel on their own from one
  state to another. Out (`EASE_OUT`, `--ease-out`) for anything that answers the pointer or arrives, so it
  responds at once and settles. Each comes as a JS function, an ECharts name and a CSS curve. The only
  other is `sweep`'s smoothstep, because its linear segments would make a cubic jump.
- **Nothing snaps.** Every change on screen tweens: positions, sizes, colors, outlines, opacity. Only a
  drag tracks the pointer directly. ECharts applies style changes instantly, so restyle charts with
  `setOptionFaded` (`FADE_MS` for hover, `MORPH_MS` alongside a data morph), never a bare `setOption`.
  Highlights are restyles, never ECharts' emphasis states (see the rolling chart's hover rules).
- **One action, one tier, one start.** Everything an action changes (the charts, the period bar's
  timeline, the lists, the stats, the mix bar) moves at the same tier and starts together. A preset is
  the exception by design: the view pans first (`PAN_MS`, longer when the length changes), then the new artists morph in. So is
  the bar's timeline when its bands change shape and its ends move too: the bands morph first, then the ends
  travel, each at the tier (`setBrushBands`).
- **Things come and go by shrinking or fading, not by appearing.** A hidden artist collapses to zero
  thickness; a series that leaves fades its outline as it goes. Series can't tween in or out, so keep them
  in place with no thickness (see `withOtherMorph`, the timeline's `hidden` bands).
- **Interruptions carry on from what's on screen.** A new animation starts from the current frame, not
  the old target. A quick one (a hover) never cuts short a slower one in flight: it lasts until that one
  would have ended (see `setBrushBands`).
- **Staggers** step `STAGGER_MS` (18 ms) per item, up to `STAGGER_MAX_MS` (240 ms) in all. The CSS
  entrance staggers are hand-set within the same range.
- **Controls the page moves glide too.** When code (not the reader's hand) changes a control, its thumb, fill
  and number travel with the change on the same tier and curve as the graphs: the slice slider's
  `glideWindow` lifts the range input's step and walks a fractional value along the sweep's curve, with its
  number counting through the sizes in between. A drag is the pointer's, so it never glides.
- **Time follows the size of the change.** A change that has a size (a period's length, days per slice, a blur
  radius) takes `scaledMs(from, to, base)`: the base tier plus 380 ms per doubling between the old and new
  value, up to 2.2 s, so 3 months → 2 years and 15 → 75 days both take longer than a small step and never
  rush. Everything riding the change (the slider's thumb, the bar's backdrop, a sweep's keyframes through
  `sweepSteps`) takes that same time. Use it for any new variable that interpolates; don't hand-pick a duration.
- **A zoom is steady, not linear.** Moving a range's two ends linearly rushes the first half of a big zoom;
  `travel` (`motion.js`) zooms at a constant rate about the point that stays put, and both the chart and the
  bar's frame take their place from it.
- **Things that travel together share one clock.** A CSS transition and a per-frame JS tween with the same
  duration and curve still drift apart (the frame trailed the chart by ~9% mid-pan). When two things must stay
  in step, drive both from one tick: the chart's pan reports its eased progress (`morph.onFrame`) and the
  period bar's window frame is placed from it (`glideBrushRange`, with its own easing off).
- **Few beats, each with a purpose.** Fold everything that can start together into one beat, and chain only
  what must follow. A period button that changes the slice size is three: the window frame and the chart pan
  or zoom to the new period *together* (one clock, so the frame always sits over what the chart shows);
  then the artists morph in at the old slice size; then the slice size sweeps (with its slider and the
  bar's backdrop). A beat starts where the last ended (a token drops a click's chain when a newer click
  arrives). Order beats so each draws data that exists there: the slice size changes last, because swept
  while the old artists were still on screen they'd have nothing in the new period and leave it blank.
  A transition that starts while its element has them switched off (the timeline's `.morphing` state)
  snaps instead of gliding.
- **Reduced motion:** wrap every JS duration in `dur()` (0 when the visitor asked for less motion), and
  give every CSS animation an entry in the `prefers-reduced-motion` blocks.

# The rolling chart (`renderRolling` in `js/charts.js`)

Read this before touching `renderRolling`. These rules were learned the hard way; most of them guard
against an ECharts behaviour that breaks the hand-made stacking or the morphs.

It has two modes, **Share** (stacked bands) and **Hours** (overlaid lines of hours per week), which can
morph into each other. The page draws Share in `#chart-rolling` and Hours in its own card below
(`#chart-rolling-hours`, `linkStrip`, without the albums or songs). Every render of the main chart
re-renders the strip with the same args in hours mode (its selection copied), `setZoom` and `panTo` move
both on one clock, and hover in either lights the artist in the other (`tellFocus`). The page only ever
talks to the main chart. Both cards have a Days per slice slider; `#window` is the one read, and
`windowSliders` in `rollingview.js` keeps the other in step.

- **Both modes are the same series with the same ids (`s0`…).** A mode switch is a *merge*
  `setOption`, so ECharts tweens every point. Any other re-render uses `notMerge`.
- **Stacking is done by hand, not with ECharts' `stack`.** Each band is the line at its cumulative top,
  filled down to the axis, and lower bands paint over the bottom of higher ones. That paint order is set
  with each series' `z`, not left to series order: ECharts paints in the order it created each series'
  view, so artists added later (raising the artist count) would paint over everything below them. A
  hidden artist collapses onto the band below it.
- **The Hours view keeps an invisible fill (`opacity: 0`) under every line,** so the hovered line's
  shading and the morph back into bands fade in. A fill created mid-update would appear at full
  strength in its final shape.
- **`morph` is `false`, `true`/ms, or `{ms, easing}`.** Re-renders that keep the same series and point
  count can morph. Where a straight point-to-point tween would only crossfade, **sweep** instead
  (`motion.js`): smoothify steps through blur radii, and the window slider steps through window sizes,
  drawing each step on the same date points (`rolling`'s `gridWindow`, the smaller window's) so counts match.
  A bigger window has fewer points, so the range shown shrinks with it: the window sweep moves the range on its
  own clock over one fixed, unfiltered set of points (`cutTo`, `data.free`), then hands over to the final chart's. Toggling
  "Everyone else" morphs through a zero-thickness band (`withOtherMorph`), since series can't tween in or out.
- **A change of artists (a pin from outside the chart, the artist count, a new period's) comes and goes
  (`withArtistMorph`).** It's drawn on the union of the old and new artists: the old picture again (instantly), then
  the morph, then the new artists alone. Share bands grow from no thickness or shrink to none; an arriving hours
  line draws in from left to right (`paintReveals`, a clip rect on its shapes) while a leaving one sinks to 0 and
  fades. Share needs the artists who stay to keep their order, so a re-ranked period still morphs band into band.
  An interrupted change starts from the rows on screen (`flightData`), so a dragged artist count keeps up.
  Pins and the count pass a morph (`dur(MORPH_MS)`), so a pin's outline and shade fade in with the period bar's.
- **Long periods draw about one point per pixel (`strideFor`, `thin`).** Every stride-th day from the epoch is kept
  (plus the ends), a power of two, so every series and every sweep step share the same points. The outermost render
  picks the stride for everything inside it; a morph to another stride first redraws what's on screen at the new one
  (`restride`), which only happens at a period's wide end, where it hardly shows. A pan takes the finer of its two
  ends before it sets off. Code inside `renderRolling` sees thinned data; `sourceOf` gets back the full set.
- **In a merge, set unwanted options to `null`, not `undefined`,** or the other mode's values stick
  (for example `yAxis.interval`).
- **Colors follow the artist, not the stack position.** `assignSlots` in `rollingview.js` gives each artist a
  palette slot, remembers it in `state.colorSlots`, and passes the slots to `renderRolling` (`slots`).
  Pinned artists are placed first, so they keep their color for as long as they're pinned. A newcomer avoids a
  slot an artist leaving the chart just gave up while another is free, so the two don't read as one band. Stack
  order is still rank, so don't use the series index as a color index.
- **Ridgelines (the strip only, `setRidges`).** The Hours card's "Separate artists" puts each hours line on a
  baseline of its own: the same series, values `base + hours × scale` and `areaStyle.origin` at the baseline (both
  tween, so the switch is a plain merge morph), filled with the share bands' tints and z-ordered so each ridge covers
  the ones above it. The y axis counts pixels (`plotH`); the tallest peak in range is `RIDGE_PEAK` px, and the top
  baseline sits that far below the plot's top. Rows follow rank, or mid artist change `artistCtx.rows` (the old
  artists, then the new). The strip's grid is placed from the top (`top` + `height`) so `sizeStrip` can grow its canvas
  at once and shrink it after the morph while the card's frame glides; names are HTML (`paintRidgeNames`). A pan holds
  the ridges' scale (no `yMax` travel); the artist morph after it rescales.
- **Overlay series `t{k}`/`b{k}`** draw each band's top and bottom outline, thicker only while it's pinned (a hover only shades).
- **The chart has no slider of its own.** Its `dataZoom` is hidden (`show: false`) and driven from the
  period brush; `clampZoom` trims a range to the points that exist (the chart has none before the first
  window fills).
- **A preset or step change is two steps (`morph.pan`, `panTo`).** First the zoom range travels to the new
  period, a frame at a time via `dispatchAction` (like dragging the slider), with the old artists still
  on screen, so it reads as a real scroll or zoom; then the bands morph into the new period's artists.
  Don't let ECharts tween the zoom and the data together: with the point set changing (a filtered
  window), its point diff doesn't animate zooming out, and the artist change blurs into the movement.
- **`setOptionFaded`** tweens style changes by animating ECharts' internal `_polygon`/`_polyline`
  shapes directly (re-rendering each frame costs ~20ms, too slow to tween). This depends on ECharts
  internals (as of 5.6). Two traps: stop running fades *before* `setOption`, because zrender moves a
  running animation onto the new style object and it paints its old target back; and when either end
  of a fade is invisible, tween only opacity, or the color blend shows partway.

- **Parts (Whole · Albums · Songs).** `data.parts` (from `agg.rolling`'s `split`) splits each band into its albums or
  songs, as series `p{k}_{j}` that exist only while split. Which ones (`agg.topParts`, `agg.PARTS`): each at least `cut`
  of the listening of the artists shown, and at most `cap` in the whole chart, biggest first across every band. So
  showing fewer artists, or deselecting some, splits the rest more finely, and one artist alone can have many. When
  artists are shown or hidden the chart asks the page first (`pins.restack`), which redraws with the new parts in the
  same morph instead of a plain re-stack. Each band has as many slots as it has parts; a morph to
  more slots first redraws what's on screen with the extra ones empty, and a morph to fewer keeps them until it lands,
  then trims them. In share mode they stack up from the band's floor, each painting just above its band's z; in
  hours mode they're thin lines. An empty slot has no thickness, so showing more or fewer of an artist's parts (pins,
  hover) is only a restyle. Turning the split on or off swells the parts up from the band's floor or shrinks them back
  (`withSplitMorph`). Hovering a part lights it with its artist; clicking it opens its own view with it pinned
  (`pins.openPart`, `openPart` in `main.js`).

## Hover: hard-won rules

- **Every series is `silent`, and hover is worked out from the data.** A zrender `mousemove` handler
  (`st.zrMove`) converts the pointer to a date and value. Share mode focuses the band containing the
  pointer; Hours mode focuses the **topmost** line at that date. When the artist list changes and `st`
  is rebuilt, carry `zrMove`/`zrOut` over so the old handlers get removed, or they keep running
  against the previous artists.
- **Focus is drawn by restyling, never by ECharts highlight states.** Those states break the hand-made
  stacking: a highlighted band shows all the way down to the axis. Keep `triggerEmphasis: false` on the
  **x-axis's** `axisPointer` (setting it on the tooltip alone does nothing), or every hover puts every
  shape into the highlight state.
- **The legend is HTML, and there's one for the whole page:** the artist key in the sticky period bar
  (`paintArtistKey` in `key.js`), beside the search that pins, and the Artists slider on the bar's first row.
  Its last chip, "Everyone else", flips the hidden `#include-other` checkbox. No graph has a key of its own. Which artists are shown is
  `st.selected`; ECharts' legend is hidden and always shows every series. Hover calls `focusArtist`; a box click
  goes through `toggleArtist`/`showArtists`, which set `st.selected` and re-stack the bands as a morph.
- **A hidden artist is still drawn:** its band with no thickness, its outlines and parts with none, its hours line on 0
  and faded out. So hiding or showing one morphs like any other change. Never hide a series through ECharts'
  legend (`legendToggleSelect`, `selected: false`): it redraws at once with the series gone and the stored
  styles, which flickers the colors before the morph. Hovering a hidden artist's chip lights nothing. Repaint the key wherever the chart's
  artists, pins or selection change (the rolling chart's followers, `onSelectionChange`, `liveTail`).
- **Clicking the plot toggles the hovered artist's pin** (`st.zrClick`, through `pins.toggle`). It uses
  the same `pick` as hover, so the clicked band is always the one that was highlighted. "Everyone else"
  isn't pinnable. Zrender only fires `click` after a `mousedown`, which matters when scripting tests.
- **`focusArtist(el, name)`** (exported) lets the page highlight an artist from outside the chart. The
  period bar's artist key, the artist search and the mix bar use it.
- **The page must scroll when the wheel is over a chart.** Never add an `inside` dataZoom: it swallows
  wheel events. Zoom only through the period brush.

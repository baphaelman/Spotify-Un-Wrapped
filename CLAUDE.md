# Spotify (Un)Wrapped

Static site: users drop their Spotify streaming-history export and get interactive charts, all computed
in the browser. An opt-in Community tab pools anonymous summaries in Supabase. Live at
https://baphaelman.github.io/Spotify-Un-Wrapped/ (GitHub Pages, deployed from `main` by `.github/workflows/pages.yml`, which copies `index.html`, `css/` and `js/`
and runs `dev/stamp.py` on the copy to add `?v=<hash>` to every asset URL, so a deploy can't be shown with
a stale cached stylesheet or script. The files in git stay unstamped.)
`rolling_window.py` is the original pandas/Plotly prototype the main chart is ported from.

## Ground rules

- **No build step, no Node.** Plain ES modules plus ECharts 5.6.0 and JSZip from cdnjs, loaded in
  `index.html`. Run it with `python3 -m http.server` (modules don't load over `file://`).
- **The owner cares most about smooth, beautiful interaction.** Check visual changes in a real render
  (see Testing), and ask before major changes.
- **Artist and track names come from user files.** Put them in the DOM with `textContent`, and escape
  them (`esc`) in tooltip HTML.
- **Colors live as CSS tokens in `css/style.css`** (`--series-1..10`, `--seq-*`, surfaces, inks), with
  light and dark blocks. `charts.js` reads them via `tokens()`. A user-chosen palette (`PALETTES` in
  `main.js`, stored in localStorage) overrides `--series-*` on `<body>`.
- **Commit when a change seems to work, before handing back to the owner.** You don't need to ask
  first. Small commits with clear messages, so any change can be undone. **Don't push unless asked:**
  pushing `main` deploys the live site.
- **Several agents work on this project at once, so each one works in its own worktree** (see below).
- **Chart palette rules:** at most 10 categorical colors; color follows the artist, never the rank;
  "Everyone else" is always the gray `--other`.

## Working alongside other agents

The owner runs up to three agents on this project at once. Each agent works on its own branch in its
own folder, so no agent sees another's half-finished edits.

- **At the start of a task, call `EnterWorktree`** with a short name for the task (for example
  `artist-search`). This creates `.claude/worktrees/<name>/` on a new branch from local `main`.
  `.claude/settings.json` sets `worktree.baseRef: head` because `origin/main` lags behind local `main`.
  Skip this step only if `git worktree list` shows you're already in one.
- **Use your own server port** (see "Showing changes to the owner").
- **Commit on your branch** whenever something works (see Ground rules).
- **Merge into `main` only when the owner approves.** In the worktree, run `git rebase main`, fix any
  conflicts, re-test, then run `git -C "<main checkout>" merge --ff-only <branch>`. To find the main
  checkout path, run `git worktree list` and use the first row. If the merge refuses, tell the owner
  and don't force it.
- **After merging,** remove the worktree with `ExitWorktree` (`remove`) if you created it in this
  session. Otherwise, from the main checkout, run `git worktree remove <path>` and `git branch -d <branch>`.

## Showing changes to the owner

Whenever the owner asks for a change, finish it, start a live server and send them the link in your
reply. They judge the result in their own browser, so don't hand back without a link.

1. **Build the test site:** `python3 dev/harness.py` (`dev/site/` isn't in git, so each worktree needs
   its own). `dev/site/` links to your `css/` and `js/`, so later edits to those show on a browser
   refresh. Only `index.html` changes need the harness re-run.
2. **Pick your own port.** The main folder uses 8765. In a worktree, pick 8766 or higher after checking
   that `lsof -i :<port>` shows nothing, so agents don't collide.
3. **Start it in the background:** `(cd dev/site && python3 -m http.server <port> >/dev/null 2>&1 &)`
4. **Check it responds** (`curl -sI http://localhost:<port>/test.html | head -1`), then send the link:
   - `http://localhost:<port>/test.html`: loads the owner's history automatically, so they see the
     change with real data. Add a hash to land on the right view (`#hours`, `#community`, `#n5`; see
     `dev/harness.py`).
   - Say in one line what to look at and what to try (for example "hover a band in Hours mode").
5. **Leave the server running** while the owner reviews and asks for tweaks, and re-use the same port
   and link. Tell them to refresh (Cmd+Shift+R if it looks stale). Stop only your own server
   (`pkill -f "http.server <port>"`) once the work is merged or the owner says they're done.

## Files

- `js/parse.js`: reads a zip, folder or JSON files into `{t, ms, artist, track, album, skipped}`.
  Handles both the extended and the older account-data export.
- `js/aggregate.js`: pure functions for top lists, monthly totals, the 7×24 clock and `rolling()`, a
  port of the Python script that uses prefix sums.
- `js/charts.js`: every ECharts renderer. Most of the complexity is in `renderRolling`.
- `js/motion.js`: the page's motion (see Motion below). The timing tiers and easings, `setOptionFaded`
  (style and curve-rounding tweens for line and bar series) and `sweep` (steps a value through keyframes
  with chained morphs). It also holds the DOM helpers `tweenNumber`,
  `flip` (FLIP glide keyed by name) and `dur` (0 under reduced motion). The mix bar (`mix.js`) keeps one
  segment and legend entry per artist and animates `left`/`width` itself, so a period change slides the
  artists that stay, grows newcomers and collapses leavers. Top lists and stat tiles keep rows/tiles
  matched across renders the same way (`lists.js`).
- `js/main.js`: tabs, the sticky period bar (opens on the most recent year), sliders, palette menu,
  sharing, theme. **The period is `state.range`, `{lo, hi}` day indices (inclusive), not a year.** The
  dropdown's years and "All time" are presets that set it (`presetRange`); anything else the brush picks
  shows as "Custom". Every graph, list and stat reads `rangePlays()` / `state.range`.
- `js/brush.js`: the sticky bar's timeline (the rolling chart's stack graph in miniature over the whole
  history, drawn by `paintBrush` in `main.js` from the same data, artists and colors, with pinned or hovered
  artists lit and the rest dimmed; and a draggable window and edges). The 3m/6m/1y buttons rescale the
  window with its right edge fixed (`resized`). The timeline starts where the chart's data does for the artists shown (`start` in `setBrushBands`), so a smaller
  window can cut off more of the empty left; it only moves between drags. The window can still reach the real first day: dragging the left edge to the end snaps to it. It owns no state beyond the window: it reports a range through `setupBrush`'s callback and is
  moved by `setBrushRange`. Drags go through `liveRender` in `main.js`, which slides the rolling chart's
  range every frame (`setZoom`) but redraws artists, lists, stats and the mix bar at most every ~90 ms, or
  3x the last redraw's cost, so dragging stays smooth.
- `js/lists.js`: ranked lists and stat tiles.
- `js/store.js`: the parsed plays persist in IndexedDB, so return visits skip the upload. "Forget my
  data" clears them.
- `js/summary.js`, `js/api.js`, `js/config.js`, `js/community.js`: the community pool.
- `supabase/schema.sql`: the pool's tables and functions. Paste into the Supabase SQL editor to apply
  changes; it's safe to re-run.
- `dev/`: test tools (see Testing).

## Motion

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
| `ZOOM_MS` | 1400 | in-out | The view travels to a period of another length |
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
  the exception by design: the view pans first (`PAN_MS`/`ZOOM_MS`), then the new artists morph in.
- **Things come and go by shrinking or fading, not by appearing.** A hidden artist collapses to zero
  thickness; a series that leaves fades its outline as it goes. Series can't tween in or out, so keep them
  in place with no thickness (see `withOtherMorph`, the timeline's `hidden` bands).
- **Interruptions carry on from what's on screen.** A new animation starts from the current frame, not
  the old target. A quick one (a hover) never cuts short a slower one in flight: it lasts until that one
  would have ended (see `setBrushBands`).
- **Staggers** step `STAGGER_MS` (18 ms) per item, up to `STAGGER_MAX_MS` (240 ms) in all. The CSS
  entrance staggers are hand-set within the same range.
- **Reduced motion:** wrap every JS duration in `dur()` (0 when the visitor asked for less motion), and
  give every CSS animation an entry in the `prefers-reduced-motion` blocks.

## The rolling chart (`renderRolling`): read this before touching it

It has two modes on one canvas, **Share** (stacked bands) and **Hours** (overlaid lines of hours per
week), and switching between them morphs.

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
  drawing each step on the final chart's date points (`rolling`'s `gridWindow`) so counts match. Toggling
  "Everyone else" morphs through a zero-thickness band (`withOtherMorph`), since series can't tween in or out.
- **In a merge, set unwanted options to `null`, not `undefined`,** or the other mode's values stick
  (for example `yAxis.interval`).
- **Colors follow the artist, not the stack position.** `assignSlots` in `main.js` gives each artist a
  palette slot, remembers it in `state.colorSlots`, and passes the slots to `renderRolling` (`slots`).
  Pinned artists are placed first, so they keep their color for as long as they're pinned. Stack order is
  still rank, so don't use the series index as a color index.
- **Overlay series `t{k}`/`b{k}`** draw the hovered band's top and bottom outline.
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

### Hover: hard-won rules

- **Every series is `silent`, and hover is worked out from the data.** A zrender `mousemove` handler
  (`st.zrMove`) converts the pointer to a date and value. Share mode focuses the band containing the
  pointer; Hours mode focuses the **topmost** line at that date. When the artist list changes and `st`
  is rebuilt, carry `zrMove`/`zrOut` over so the old handlers get removed, or they keep running
  against the previous artists.
- **Focus is drawn by restyling, never by ECharts highlight states.** Those states break the hand-made
  stacking: a highlighted band shows all the way down to the axis. Keep `triggerEmphasis: false` on the
  **x-axis's** `axisPointer` (setting it on the tooltip alone does nothing), or every hover puts every
  shape into the highlight state.
- **The legend is HTML (`renderLegend`).** The ECharts legend is hidden and only holds which artists
  are shown. Hover calls `focusArtist`; a click dispatches `legendToggleSelect`, which re-stacks the
  bands as a morph.
- **Clicking the plot toggles the hovered artist's pin** (`st.zrClick`, through `pins.toggle`). It uses
  the same `pick` as hover, so the clicked band is always the one that was highlighted. "Everyone else"
  isn't pinnable. Zrender only fires `click` after a `mousedown`, which matters when scripting tests.
- **`focusArtist(el, name)`** (exported) lets the page highlight an artist from outside the chart. The
  Top artists and Top tracks rows use it.
- **The page must scroll when the wheel is over a chart.** Never add an `inside` dataZoom: it swallows
  wheel events. Zoom only through the period brush.

## Community pool

- **Supabase project `qvsoxqeuvpnryitechsf`.** The publishable key in `js/config.js` is meant to be
  public.
- **The browser can only call these functions:** `submit_summary`, `delete_summary`, `is_shared`,
  `community_stats` and `artist_ranks`. RLS is on with no policies, so direct table access is refused.
- **The shared summary** (`summary.js`) holds totals, the top 500 artists and tracks with hours, and
  the 168-cell clock. Nothing else leaves the browser.
- **Submission key:** sha256 of the user's first 200 plays. Re-uploading replaces the old summary, and
  only someone with the data can delete it.
- **Minimum crowd of 5:** nothing is shown below 5 contributors, and an artist or track appears only
  once 5 contributors have it.
- **Known gap:** there's no rate limiting or bot check. Cloudflare Turnstile is the plan if spam shows
  up.
- **Fake data:** `python3 dev/seed_community.py seed|cleanup` adds or removes 12 fake contributors
  (keys from `"synthetic-test-<i>"`). `cleanup` never touches real submissions.

## Testing

You need a real browser render to see visual or hover changes. Headless Brave is installed (no Chrome
or Node).

```sh
python3 dev/harness.py                      # rebuild dev/site after any index.html change
(cd dev/site && python3 -m http.server 8765 &)
python3 dev/shot.py "http://localhost:8765/test.html?v=$RANDOM#hours" /tmp/out.png 1280 1900
HOVER_SEL="#top-artists li:nth-child(3)" python3 dev/shot.py ...   # also HOVER, EVAL, FRAMES, WHEEL
```

- **`test.html`** loads the owner's history from `../spotify/datas/Spotify Extended Streaming History`.
  Its hash actions are documented in `dev/harness.py`.
- **`EVAL`** is handy for inspecting chart state, for example how many shapes are stuck in a highlight
  state:
  `getZr().storage.getDisplayList(true).filter(e => e.currentStates?.length)`.
- **Headless frames don't show how smooth an animation feels.** Ask the owner to judge smoothness in a
  real browser.
- **Keep screenshots cheap:** crop them, or take only what proves the change.

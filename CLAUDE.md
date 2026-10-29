# Spotify (Un)Wrapped

Static site: users drop their Spotify streaming-history export and get interactive charts, all computed
in the browser. An opt-in Community tab pools anonymous summaries in Supabase. Live at
https://baphaelman.github.io/Spotify-Un-Wrapped/ (GitHub Pages, served from `main`, root folder).
`rolling_window.py` is the original pandas/Plotly prototype the main chart is ported from.

## Ground rules

- **No build step, no Node.** Plain ES modules plus ECharts 5.6.0 and JSZip from cdnjs, loaded in
  `index.html`. Run it with `python3 -m http.server` (modules don't load over `file://`).
- **The owner cares most about smooth, beautiful interaction.** Check visual changes in a real render
  (see Testing), and ask before major changes.
- **Artist and track names come from user files.** Put them in the DOM with `textContent`, and escape
  them (`esc`) in tooltip HTML.
- **Colors live as CSS tokens in `css/style.css`** (`--series-1..8`, `--seq-*`, surfaces, inks), with
  light and dark blocks. `charts.js` reads them via `tokens()`. A user-chosen palette (`PALETTES` in
  `main.js`, stored in localStorage) overrides `--series-*` on `<body>`.
- **Commit when a change seems to work, before handing back to the owner.** You don't need to ask
  first. Small commits with clear messages, so any change can be undone. **Don't push unless asked:**
  pushing `main` deploys the live site.
- **Several agents work on this project at once, so each one works in its own worktree** (see below).
- **Chart palette rules:** at most 8 categorical colors; color follows the artist, never the rank;
  "Everyone else" is always the gray `--other`.

## Working alongside other agents

The owner runs up to three agents on this project at once. Each agent works on its own branch in its
own folder, so no agent sees another's half-finished edits.

- **At the start of a task, call `EnterWorktree`** with a short name for the task (for example
  `artist-search`). This creates `.claude/worktrees/<name>/` on a new branch from local `main`.
  `.claude/settings.json` sets `worktree.baseRef: head` because `origin/main` lags behind local `main`.
  Skip this step only if `git worktree list` shows you're already in one.
- **Use your own server port.** The main folder uses 8765. In a worktree, pick 8766 or higher after
  checking that `lsof -i :<port>` shows nothing. Run `python3 dev/harness.py` first, since `dev/site/`
  isn't in git. Stop only your own server (`pkill -f "http.server <your port>"`).
  Give the owner the `http://localhost:<port>/` link so they can check it in a real browser.
- **Commit on your branch** whenever something works (see Ground rules).
- **Merge into `main` only when the owner approves.** In the worktree, run `git rebase main`, fix any
  conflicts, re-test, then run `git -C "<main checkout>" merge --ff-only <branch>`. To find the main
  checkout path, run `git worktree list` and use the first row. If the merge refuses, tell the owner
  and don't force it.
- **After merging,** remove the worktree with `ExitWorktree` (`remove`) if you created it in this
  session. Otherwise, from the main checkout, run `git worktree remove <path>` and `git branch -d <branch>`.

## Files

- `js/parse.js`: reads a zip, folder or JSON files into `{t, ms, artist, track, album, skipped}`.
  Handles both the extended and the older account-data export.
- `js/aggregate.js`: pure functions for top lists, monthly totals, the 7×24 clock and `rolling()`, a
  port of the Python script that uses prefix sums.
- `js/charts.js`: every ECharts renderer. Most of the complexity is in `renderRolling`.
- `js/motion.js`: shared chart motion. Durations (`MORPH_MS`, `FADE_MS`), `setOptionFaded` (style and
  curve-rounding tweens) and `sweep` (steps a value through keyframes with chained morphs). New charts
  should take their timings and animation helpers from here.
- `js/main.js`: tabs, the sticky period bar (opens on the most recent year), sliders, palette menu,
  sharing, theme.
- `js/lists.js`: ranked lists and stat tiles.
- `js/store.js`: the parsed plays persist in IndexedDB, so return visits skip the upload. "Forget my
  data" clears them.
- `js/summary.js`, `js/api.js`, `js/config.js`, `js/community.js`: the community pool.
- `supabase/schema.sql`: the pool's tables and functions. Paste into the Supabase SQL editor to apply
  changes; it's safe to re-run.
- `dev/`: test tools (see Testing).

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
  wheel events. Zoom only through the slider.

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

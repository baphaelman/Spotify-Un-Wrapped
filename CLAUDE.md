# Spotify (Un)Wrapped

Static site: users drop their Spotify streaming-history export and get interactive charts, all computed in the
browser. An opt-in Community tab pools anonymous summaries in Supabase. Live at
https://baphaelman.github.io/Spotify-Un-Wrapped/, deployed from `main` by `.github/workflows/pages.yml` (which runs
`dev/stamp.py` on a copy to add `?v=<hash>` to asset URLs; the files in git stay unstamped).
`rolling_window.py` is the original pandas/Plotly prototype the main chart is ported from.

## Ground rules

- **No build step, no Node.** Plain ES modules plus ECharts 5.6.0 and JSZip from cdnjs. Serve over HTTP (modules
  don't load over `file://`).
- **The owner cares most about smooth, beautiful interaction,** and about token use. Ask before major changes: for
  anything architectural (rebuilding a chart's series, a new render path), propose a plan or options first, don't build.
- **Spend tokens like they're the owner's:** few, cropped screenshots; numbers over pictures where a tool gives them
  (`dev/motion_check.py`); if a bug won't reproduce in 2–3 tries, stop and ask instead of hunting.
- **Artist and track names come from user files:** `textContent` in the DOM, `esc` in tooltip HTML.
- **Colors are CSS tokens in `css/style.css`** (`--series-1..10`, `--seq-*`, surfaces, inks), light and dark.
  `charts.js` reads them via `tokens()`; a palette from `PALETTES` (`theme.js`) overrides `--series-*` on `<body>`.
- **Chart palette:** at most 10 categorical colors; color follows the artist, never the rank; "Everyone else" is
  always the gray `--other`.
- **Commit when a change seems to work,** without asking: small commits, clear messages. **Don't push unless asked:**
  pushing `main` deploys the live site.
- **Options the owner passes over stay under "Visual tweaks"** when they need little code of their own: a number goes
  in `TUNES` (`tune.js`) as a slider on its card; a button or choice stays in the markup with `class="tweak-only"` and
  `hidden`, shown only while the settings panel's switch is on. Off, the page is exactly as chosen. Don't keep anything
  that needs its own code path or rendering, and say which options you kept.
- **README:** `README.md` is the owner's first-person tour, one `###` section per graph in page order. Adding,
  renaming or removing a graph updates its section in the same change (what it shows and does, not how). Ask before
  adding screenshots (`docs/images/`).

## Worktrees, servers and merging

Several agents work at once, each on its own branch and folder.

- **Start each task with `EnterWorktree`** (a short name, e.g. `artist-search`), unless `git worktree list` shows
  you're already in one. It branches from local `main` (`worktree.baseRef: head`; `origin/main` lags).
- **Show every change with a live link.** `python3 dev/harness.py` builds `dev/site/` (re-run after `index.html`
  changes; `css/` and `js/` are linked). Pick a free port from 8766 up (`lsof -i :<port>`; 8765 is the main folder's),
  start `(cd dev/site && python3 -m http.server <port> >/dev/null 2>&1 &)`, check it with `curl -sI`, and send
  `http://localhost:<port>/test.html` (loads the owner's history; hash actions like `#hours`, `#community`, `#n5` are
  in `dev/harness.py`) with one line on what to look at. Keep the server and port while the owner reviews.
- **"Merge" (or "merge and push") means the `merge` skill:** rebase, check, merge from the main checkout, clean up.
  Only on the owner's say-so.
- **Quick tweak mode** ("tweaker", copy, spacing, sizes, a color): edit, commit, reply with the link. No screenshots or
  exploration; read only the lines you change. If it turns out to touch chart logic or motion, treat it as a normal change.

## Files

All in `js/` unless noted; each file's own comments have the details.

- `parse.js`: zip, folder or JSON → `{t, ms, artist, track, album, skipped, id}`.
- `aggregate.js`: pure functions: top lists, monthly totals, the 7×24 clock, `rolling()`.
- `charts.js`: every ECharts renderer; most complexity is in `renderRolling`.
- `motion.js`: timing tiers and easings, `setOptionFaded`, `sweep`, `travel`, `tweenNumber`, `flip`, `dur`, `litLook`.
- `state.js`: `state`, small readers (`rangePlays`, `shownPlays`, `presetRange`…), `hooks`. **The period is
  `state.range`, `{lo, hi}` inclusive day indices, not a year;** presets set it, a brush pick shows as "Custom".
- `main.js`: entry point: loading, tabs, controls, sharing, the view switch, `renderAll` / `renderDependents`.
- `period.js`: the sticky bar's period controls and live dragging (`liveRender`). `brush.js`: its timeline and window.
- `rollingview.js`: the page's side of the rolling chart (`renderRollingChart`, `chartArtists`, `assignSlots`, pins,
  sweeps) and the graphs that follow its artists (`paintBrush`, mix bar, monthly, clock).
- `key.js`: the bar's artist key (`paintArtistKey`) and the search that pins. `guide.js`: the "How the page works" guide.
- `theme.js`: palettes and light/dark. `tune.js`: the Visual tweaks sliders (`TUNES`) and `.tweak-only`; imports nothing.
- `views.js`: plays as each view sees them (`keyedPlays`). `genres.js`, `families.js`: the Genres view's data.
- `race.js`: "Top … over time". `mix.js`: the mix bar. `lists.js`: ranked lists and stat tiles. `store.js`: IndexedDB.
- `covers.js`: pictures (see below). `summary.js`, `api.js`, `config.js`, `community.js`, `supabase/schema.sql`: the
  community pool. `feedback.js`: "Missing something?" and the owner's inbox (`#inbox`).

**Imports are one-way:** `tune.js` → `state.js` → `views.js`, `theme.js`, `rollingview.js` → `key.js` → `period.js` →
`main.js`. A call the other way goes through `hooks`, filled by `main.js` at startup.

## Read the doc before touching its area

- **`docs/motion.md`** before adding or changing any animation.
- **`docs/rolling-chart.md`** before touching `renderRolling` or its hover, pins or morphs.
- **`docs/genres.md`** before the Genres view, `genres.js` or `supabase/functions/genres`. Genres never cost Spotify
  calls, and artists with no genre are left out of that view entirely.
- **`docs/pictures.md`** before `covers.js` or `supabase/functions/artist-image`. **The Spotify app is in development
  mode and bursts earn day-long lockouts that blank every visitor's pictures:** never bulk-fetch or loop pictures,
  and remember each `test.html` load costs Spotify calls for uncached pictures (use `OFFLINE=1` when pictures don't matter).
- **`docs/backend.md`** before deploying an edge function or touching the community pool.

## Motion

One set of timings in `js/motion.js`, mirrored as `--motion-*` / `--ease-*` in `css/style.css` (keep them in step).
**Never write a duration or easing literal;** pick the tier for what's moving.

| Tier | ms | Easing | For |
|---|---|---|---|
| `FADE_MS` | 200 | out | A highlight: hover, focus, a pressed control, a menu opening |
| `GROW_MS` | 250 | out | A small reflow: chips appearing, a dialog, re-blurring after a zoom |
| `CHASE_MS` | 450 | out | A morph following a moving input (a dragged window), each cut short by the next |
| `ENTER_MS` | 550 | out | First appearance: the dashboard, a chart's first draw, a new list row |
| `MORPH_MS` | 750 | in-out | The data changes: bands, bars, rows, numbers, the mix bar, the timeline |
| `PAN_MS` | 900 | in-out | The view travels to another period of the same length |
| `scaledMs` | 900–2200 | in-out | A change with a size: a zoom, days per slice, a blur radius |
| `--motion-theme` | 350 | CSS `ease` | Colors cross-fading on a theme flip |

- **Nothing snaps;** only a drag tracks the pointer. Restyle with `setOptionFaded`, never a bare `setOption` or
  ECharts' emphasis states. Things come and go by shrinking or fading (keep series in place with no thickness).
- **One action, one tier, one start;** chain only what must follow. Interruptions carry on from what's on screen,
  and a quick animation never cuts short a slower one. Things that travel together share one tick, and controls the
  page moves (a slider's thumb and number) glide on the same tier as the graphs.
- **Hover vs pin:** hover shades lightly and dims others a little; a pin shades deeper, alone outlines, dims more;
  a hovered pin is deeper still. Take each look from `litLook` and the `--shade-*`, `--fade-*`, `--lit-*`,
  `--dim-item*` tokens. Applies to every graph, chip, row, card and the mix bar.
- **Staggers** step `STAGGER_MS` (18) up to `STAGGER_MAX_MS` (240). **Reduced motion:** wrap JS durations in `dur()`
  and give CSS animations a `prefers-reduced-motion` entry.

**The rolling chart:** colors follow the artist (`assignSlots`), never the series index. One artist key for the whole
page, in the period bar (`paintArtistKey`); repaint it when the chart's artists, pins or selection change.
`focusArtist(el, name)` highlights an artist from anywhere. Never add an `inside` dataZoom: the page must scroll
over charts, and zoom goes through the brush.

## Testing

Headless Brave is installed (no Chrome or Node).

```sh
python3 dev/shot.py "http://localhost:<port>/test.html?v=$RANDOM#hours" /tmp/out.png 1280 1900
# env: HOVER_SEL / HOVER, CLICK_JS + CLICK_TIMES (frames after an action), EVAL (+ PROFILE=1), WHEEL, OFFLINE=1
python3 dev/motion_check.py <port> [slice|slice-back|smooth|drag|preset|custom ...]
```

- **`motion_check.py`** prints frame times (lag) and the biggest one-frame jump (a cut) for the slow actions, offline.
  Use it before and after any performance or animation change instead of judging from screenshots; its header
  explains the numbers. `custom --setup "<js>" --action "<js>"` measures anything else.
- **`EVAL`** inspects chart state, e.g. shapes stuck in a highlight:
  `getZr().storage.getDisplayList(true).filter(e => e.currentStates?.length)`.
- **Headless frames don't show how smooth an animation feels;** the owner judges that in a real browser.

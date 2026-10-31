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
  `theme.js`, stored in localStorage) overrides `--series-*` on `<body>`.
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
- **Check the rebased branch before merging,** because other agents merge too and a bad rebase has
  reached `main` before (conflict markers in `index.html`, a page that threw on load):
  1. `git grep -nE '^(<{7}|={7}|>{7})( |$)' -- index.html css js` must print nothing.
  2. `python3 dev/harness.py`, then
     `python3 dev/shot.py "http://localhost:<port>/test.html?v=$RANDOM" /tmp/merge.png 1280 900`
     must end with the title `DONE` and print no uncaught exceptions.
  If either fails, fix it on your branch first. After merging, if the owner looks at `main` on 8765,
  re-run `python3 dev/harness.py` in the main checkout, since its `dev/site/index.html` is a copy.
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

### Quick tweak mode

When the owner says you're their "tweaker" or asks for quick tweaks (copy, spacing, sizes, a color),
go fast: make the edit, commit, reply with the link. Skip screenshots and exploration, and read only
the lines you're changing. Still use a worktree and your own server, and still run the pre-merge
check when they say "merge". If a tweak turns out to touch chart logic or motion, say so and handle
it as a normal change.

## Files

All in `js/` unless noted. Read a file's own comments for the details.

- `parse.js`: reads a zip, folder or JSON files into `{t, ms, artist, track, album, skipped, id}` (extended and older export).
- `aggregate.js`: pure functions: top lists, monthly totals, the 7×24 clock, `rolling()` (a port of `rolling_window.py`).
- `charts.js`: every ECharts renderer. Most of the complexity is in `renderRolling` (see below).
- `motion.js`: the timing tiers and easings, `setOptionFaded`, `sweep`, `travel`, and the DOM helpers `tweenNumber`, `flip`, `dur`.
- `state.js`: the shared `state` and small readers (`rangePlays`, `shownPlays`, `presetRange`…), and `hooks`.
  **The period is `state.range`, `{lo, hi}` day indices (inclusive), not a year.** Years and "All time" are
  presets that set it; anything else the brush picks shows as "Custom". Every graph, list and stat reads it.
- `main.js`: the entry point: loading, tabs, the controls panel, sharing, the Artists/Tracks/Albums switch, and the
  orchestration every change goes through (`renderAll`, `renderDependents`).
- `period.js`: the sticky bar's period controls: presets, ‹ › steps, length buttons, the year menu, live dragging (`liveRender`).
- `rollingview.js`: the page's side of the rolling chart (`renderRollingChart`, `chartArtists`, `assignSlots`,
  pins, the slice/smoothing sweeps) and the graphs that follow its artists (`paintBrush`, the mix bar, monthly, clock).
- `key.js`: the period bar's artist key (`paintArtistKey`) and the artist search that pins.
- `guide.js`: the guide behind the ? in the top bar ("How the page works"): small copies of the bar's controls that mirror them, and the ring
  that lights the real control while a guide row is hovered.
- `theme.js`: the palettes (`PALETTES`), the palette menu, the light/dark flip.
- `brush.js`: the sticky bar's timeline and its draggable window. It owns no state beyond the window.
- `views.js`: the plays as each view (Genres, Artists, Albums, Tracks) sees them (`keyedPlays`): the view's item in
  `artist`, the real artist in `by`, and what each item is called and pictured by.
- `genres.js`, `families.js`: the Genres view's data: each artist's genres from our `genres` edge function, and the
  broad families they're grouped into (see Genres below).
- `mix.js`: the listening mix bar; `lists.js`: ranked lists and stat tiles; `store.js`: plays kept in IndexedDB.
- `covers.js`: the pictures in the mix's key (see Pictures below).
- `summary.js`, `api.js`, `config.js`, `community.js`, `supabase/schema.sql`: the community pool (see below).
- `feedback.js`: the "Missing something?" requests, and the owner's inbox (open the site with `#inbox`).
- `dev/`: test tools (see Testing). `docs/`: the long-form rules this file points to.

**Keep imports one-way:** `state.js`, then `views.js`, `theme.js` and `rollingview.js`, then `key.js`, then `period.js`,
then `main.js`. Each imports only from modules before it; a call the other way goes through `hooks`, which
`main.js` fills at startup.

## Pictures and the Spotify rate limit: read before testing pictures

`covers.js` looks pictures up by up to five of an item's track IDs through the edge function
`supabase/functions/artist-image`, deployed as `smooth-endpoint` (Spotify Web API; credentials in the
function's secrets; JWT verification off). It tries each track, then a search by name, then the other kind
of picture, and skips Spotify's ~1 KB blank placeholder. Answers are cached in localStorage
(`unwrapped-pictures`). The owner redeploys by pasting the file into the Supabase dashboard (no CLI here),
and a deployed function can't be renamed.

**The Spotify app behind `smooth-endpoint` is in development mode, with a small, unpublished request
allowance, and bursts earn long lockouts.** On 2026-10-29 an idle warm-up (about 150 lookups per page load,
each several API calls) plus repeated test loads got the app a 429 with `Retry-After: 83512` (about 23
hours). While locked out, every picture is blank for every visitor.

- **Never bulk-fetch pictures:** no warm-ups, prefetching or scripts that loop over artists or albums
  against the function. Look up only what's on screen (the key already waits for the bar to hold still).
- **Each page load of `test.html` costs real Spotify calls** for any picture not already cached. The cache
  is per origin, so keep one port and one profile for a task, take few screenshots, and don't loop them.
- **Check whether the app is locked out** with one request:
  `curl -s "https://qvsoxqeuvpnryitechsf.supabase.co/functions/v1/smooth-endpoint?kind=album&tracks=4cOdK2wGLETKBW3PvgPWqT"`.
  `{"error":"busy","wait":N}` means locked out for N more seconds; the page then stops asking for that visit
  (waits under 2 minutes it holds and retries).
- **Don't work around a lockout** (new Spotify apps, other keys, spoofed clients). Wait it out and tell the
  owner. A shared server-side cache table (each picture looked up once for everyone) is the planned fix.

## Motion

Everything on the page moves on one set of timings, so a single action reads as one movement. Durations
and easings live in `js/motion.js` and, mirrored, as the `--motion-*` and `--ease-*` tokens at the top of
`css/style.css` (keep the two in step). **Never write a duration or easing literal:** pick the tier that
matches what is moving. **Read `docs/motion.md` before adding or changing an animation:** it has the long
form of each rule below, with the worked examples.

| Tier | ms | Easing | For |
|---|---|---|---|
| `FADE_MS` / `--motion-fade` | 200 | out | A highlight: hover, focus, a pressed or hovered control, a menu opening |
| `GROW_MS` / `--motion-grow` | 250 | out | A small reflow: a row of chips appearing, a dialog, re-blurring after a zoom |
| `CHASE_MS` | 450 | out | A morph following a moving input (a dragged period window), each cut short by the next |
| `ENTER_MS` / `--motion-enter` | 550 | out | First appearance: the dashboard rising in, a chart's first draw, a new list row |
| `MORPH_MS` / `--motion-morph` | 750 | in-out | The data changes: bands, bars, list rows, numbers, the mix bar, the bar's timeline |
| `PAN_MS` | 900 | in-out | The view travels to another period of the same length |
| `scaledMs` | 900 – 2200 | in-out | A change that has a size: a zoom to another length, days per slice, a blur radius |
| `--motion-theme` | 350 | CSS `ease` | Colors cross-fading when the theme flips (CSS only) |

- **Two easings:** in-out for things that travel on their own, out for anything that answers the pointer or arrives.
- **Nothing snaps.** Every change tweens; only a drag tracks the pointer directly. Restyle charts with
  `setOptionFaded`, never a bare `setOption`, and never with ECharts' emphasis states.
- **One action, one tier, one start,** except where a later step must wait for an earlier one (a preset pans,
  then the artists morph in). Fold what can start together into one step and chain only what must follow.
- **Things come and go by shrinking or fading,** never by appearing. Series can't tween in or out, so keep
  them in place with no thickness.
- **Interruptions carry on from what's on screen,** and a quick animation never cuts short a slower one in flight.
- **Controls the page moves glide too** (a slider's thumb and number), on the same tier as the graphs.
- **Time follows the size of the change:** use `scaledMs` for anything that interpolates a size, and give
  everything riding that change the same time.
- **Things that travel together share one clock:** drive both from one tick, not two matching tweens.
- **Staggers** step `STAGGER_MS` (18 ms) per item, up to `STAGGER_MAX_MS` (240 ms) in all.
- **Reduced motion:** wrap every JS duration in `dur()`, and give every CSS animation an entry in the
  `prefers-reduced-motion` blocks.

## The rolling chart

**Read `docs/rolling-chart.md` before touching `renderRolling` or its hover, pins or morphs.** It's the
page's main chart, Share (stacked bands), with Hours (lines) drawn from it in its own card below, and its stacking, colors and
hover are hand-built around ECharts quirks. The rules that reach beyond the chart:

- **Colors follow the artist, not the stack position** (`assignSlots`), so never use a series index as a color index.
- **There's one artist key for the whole page,** in the sticky period bar (`paintArtistKey`). No graph has its
  own. Repaint it wherever the chart's artists, pins or selection change.
- **`focusArtist(el, name)`** highlights an artist in the chart from anywhere on the page.
- **The page must scroll when the wheel is over a chart.** Never add an `inside` dataZoom; zoom only
  through the period brush.

## Community pool

- **Supabase project `qvsoxqeuvpnryitechsf`.** The publishable key in `js/config.js` is meant to be
  public.
- **The browser can only call these functions:** `submit_summary`, `delete_summary`, `is_shared`,
  `community_stats` and `artist_ranks`, plus the feedback ones (`submit_feedback`, and `list_feedback`,
  `set_feedback_done`, `delete_feedback`, which need the owner's admin key). RLS is on with no policies, so direct
  table access is refused.
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

## Genres

**Read `docs/genres.md` before touching the Genres view, `genres.js` or `supabase/functions/genres`.** The rules
that reach beyond it:

- **Genres never cost Spotify calls.** They come from MusicBrainz (Last.fm as a fallback) through the `genres` edge
  function, which answers from the shared `artist_genres` table and queues unknown names (`genre_queue`, worked by
  pg_cron once a minute). Only that worker calls MusicBrainz.
- **Artists with no genre (yet) are left out of the Genres view entirely,** so no graph, list, key or search has
  them. A genre's band splits into its artists.
- **Testing without the network:** `dev/harness.py` seeds the page's genre cache from `dev/genre_cache.json` when
  it exists (written by `dev/genre_coverage.py`, gitignored), and `OFFLINE=1 python3 dev/shot.py ...` cuts the page
  off from Supabase.

## Testing

You need a real browser render to see visual or hover changes. Headless Brave is installed (no Chrome
or Node).

```sh
python3 dev/harness.py                      # rebuild dev/site after any index.html change
(cd dev/site && python3 -m http.server 8765 &)
python3 dev/shot.py "http://localhost:8765/test.html?v=$RANDOM#hours" /tmp/out.png 1280 1900
HOVER_SEL=".mix-legend-item:nth-child(3)" python3 dev/shot.py ...   # also HOVER, EVAL, FRAMES, WHEEL
```

- **`test.html`** loads the owner's history from `../spotify/datas/Spotify Extended Streaming History`.
  Its hash actions are documented in `dev/harness.py`.
- **`EVAL`** is handy for inspecting chart state, for example how many shapes are stuck in a highlight
  state:
  `getZr().storage.getDisplayList(true).filter(e => e.currentStates?.length)`.
- **Headless frames don't show how smooth an animation feels.** Ask the owner to judge smoothness in a
  real browser.
- **Keep screenshots cheap:** crop them, or take only what proves the change.

# Arrivals: how a thumbnail becomes its card

Opening a gallery tile is one flight (`MORPH_MS`, in-out; gallery.js "The flight between a tile and its card"). The
card is pinned in its place, scaled down over the tile and clipped to the tile's frame, and grows. Closing plays the
same keyframes in reverse. Esc or Back midway reverses from wherever it is.

A card **crossfades** by default: it fades in over the flying thumbnail (0–40%), and the thumbnail fades out (40–70%).
The two are different drawings.

A card with an **arrival** (`ARRIVALS` in `js/arrivals.js`) flies **solid** instead. Its plot is the thumbnail from
the first frame and morphs into itself on the flight's beat, while everything around it fades in. Every Month is the
first one.

## The hook

`ARRIVALS[cardId] = (card, thumb, to, ms) => boolean`:

- `thumb`: the thumbnail's element (`.gal-thumb`) as drawn now. For an ECharts one, `echarts.getInstanceByDom(thumb)`.
- `to`: `"thumb"` (the card's plot in the thumbnail's form) or `"card"` (its own).
- It morphs the plot from what's on screen to `to` over `ms`, in-out, or draws it at once when `ms` is 0.
- It returns false when it can't (the thumbnail doesn't match the card's data), and that flight crossfades.

The flight calls it like this:

| When | Calls |
|---|---|
| Opening | `("thumb", 0)`, then `("card", MORPH_MS)` |
| Closing | `("thumb", MORPH_MS)` as it starts, then `("card", 0)` once it lands, so the card waits off screen as itself |
| Turned back midway | the other way, over the time flown so far |

What the solid flight does for you (gallery.js):

- **Placement.** In the first frame, the card's plot (gallery.js `PLOT`, narrowed to the ECharts grid) is as wide as
  the thumbnail and sits on the thumbnail's baseline (an ECharts thumbnail's grid bottom, gallery.js `baseline()`). The tile is usually squatter than the plot, so the arrival
  stretches its first frame vertically by `(thumb aspect h/w) / (plot aspect h/w)` (Every Month: `look.stretch`).
- **The card's chrome.** The card's frame and everything beside the plot fade in over 0–40% (reversed on close). For
  an ECharts plot, its DOM overlays and every drawn shape that isn't a series' fade too: axes, guides, labels,
  through zrender opacity. A plot of HTML elements or its own canvas is all plot: the arrival fades whatever in it
  doesn't morph.
- **The thumbnail.** It fades out over 0–25% of an open (and in over the last 25% of a close), over shapes that match
  it, and the card draws above the tile.
- **It rides on the card** (gallery.js `riding()`): scaled evenly with it, so in the card's own pixels it keeps the
  tile's size all flight (its height there is `Th.height / s`, s the card's starting scale). An arrival that reshapes
  its plot (squashes or stretches it) holds the thumbnail's form *in the card's pixels* while the thumbnail shows and
  does its growing in between. Top … View and Hours per week (`rollingArrival`) squash by `k = k0 + (1 − k0)·p²`, k0
  the tile's height over the plot's in the card's pixels and p the card's progress read from its transform: the p²
  keeps them within 2px at both ends. A curve tuned to a thumbnail that stretched (its height following p) drifts
  2–7px at the ends.

## Every Month, the worked example

- **Thumbnail:** `thumbs.js` `THUMBS["monthly-card"]`, the "crowns" design: each month's hours, the top item on top
  in its color, the rest one gray.
- **Arrival:** `morphMonthly` (`charts/monthly.js`). The thumbnail's form is the card's own series, with the slices
  zeroed into the gray, the thumbnail's colors and bar gap, and values scaled by `cardMax / thumbMax × stretch`.
  - The y-axis is held at the card's own extent, so axes and captions are identical in both forms and only fade.
  - `clip: false` lets stretched bars stand above the plot meanwhile.
  - The morph is one `setOptionFaded` with in-out for both shapes and colors (its last argument).
  - `renderMonthly` keeps `st.dress(looks)`, so the arrival rebuilds the real series without re-rendering the card.
- **Thumbnails follow their card's choices.** `otherOn(cardId)` (thumbs.js) reads the card's "Everyone else" toggle,
  and a toggle's change redraws the thumbnails. Without that, Every Month with Everyone else off flew from
  everyone's months to only the chart's artists. Apply the same to any setting that changes what the card shows.

## Lists of rows: Top … over time, All your …, Skips and picks

- **Placement.** A list hangs from its top, so the flight sets these plots' top on the thumbnail's (gallery.js `HANG`),
  not their baseline.
- **Thumbnails are the card's rows** in its columns at 96px: Top … over time at its playhead (the card waits halfway
  through the period, `raceNow`), All your … from the card's own totals, Skips and picks from its last data
  (`skipsNow`), each following its Everyone else.
- **`flyRows`** (`js/rowfly.js`, imports only motion.js): each bar, name and number the thumbnail also draws starts on
  the thumbnail's shape (read by `thumbShapes` from its ECharts bars and labels) and glides to its own place, through
  the CSS `translate` and `scale` properties, so a card's own `transform` keeps working. Bars stretch; text scales
  evenly, anchored at its edge. Each part animates only what it needs, on the compositor (`translate`, `scale`,
  `opacity`); a `clip-path` repaints every frame, so text is clipped only where it would run into a bar (Skips' long
  names). Ranks and rows the thumbnail lacks fade with the chrome, moving with their row (`row`); rows past the
  thumbnail's last keep its offset, so the rest of the list stays together under it. The card's own entrance animations are finished first, and clipping boxes
  between the parts and the card open for the flight.
- **An overlaid ECharts bar lines up by its top edge**, so a clear bar carrying a label is as thick as the bar it rides on.

## Plots that aren't ECharts

- **Inside your top … is SVG** (`.sun-svg`; the thumbnail's `.thumb-sun` carries its radius `R` and slice `ids`), not
  ECharts. To the flight it's a plot of elements: all plot, so `arriveSunburst` fades its labels itself.
- **Every play and Every day draw on their own canvas,** and so do their thumbnails (every.js `paintRasterThumb`,
  `paintCalendarThumb`): a canvas over the empty ECharts one thumbs.js gives the tile, drawn from the same per-artist
  paths as the card at the tile's size. The pattern:
  - **A signature** of what a drawing shows (period, artists, slots, pins, Everyone else) is kept per thumbnail
    (`thumbSigs`) and per card (`v.sig`). The arrival flies only when they're equal.
  - **Unequal, the entry repaints the tile now** (`paintThumb`) and tries again, so a stale thumbnail never makes the
    flight crossfade. Pins, unpins and the Everyone else toggles already repaint the tiles as they happen (`renderMix`
    calls `paintThumbs`), so that repaint is only a fallback: on a click it would be a visible pop.
  - **The card is readied first** (`readyFlight`): drawn now rather than waiting on a period that changed while it was
    away, whole, and without a crossfade's copy over it.
  - **The marks move by one transform** from the thumbnail's box to the plot's (`fly`); labels and guides fade in.
  - Measure them with `dev/flight_every.js` (below): flight_check sees a canvas only as one box.

## Measuring

**`dev/flight_check.js`** prints a flight in numbers:

```sh
EVAL="$(sed -e s/__CARD__/monthly-card/ -e 's/__PLOT__/#chart-monthly/' dev/flight_check.js)" OFFLINE=1 \
  python3 dev/shot.py "http://localhost:<port>/test.html?v=$RANDOM" /tmp/x.png 1280 1000
```

It reports:
- **Shapes:** the union box of the thumbnail's and the plot's series shapes on screen, at 20, 120, 250, 500 and
  800 ms of an open and 20, 400, 600, 735 and 900 ms of a close.
- **Opacities:** the thumbnail's and the card header's.
- **The round trip:** scroll and tile top must come back equal.
- **Turning back:** Esc midway through an open, and a tile click midway through a close.
- **Errors**, if any.

**Its boxes ignore clipping:** they're the shapes' bounds, not what the card's `clip-path` or the grid's clip lets
show, so a box can stand past what's visible (a stretched bar above the plot, the tile's frame cutting a corner).

Under zsh, pass the card and selector as literal words, not through an unquoted variable: zsh doesn't word-split it.

**Every Month's numbers:**
- **Boxes:** at 20 ms the two boxes agree within 1px (`467,491,346,89` vs `467,492,346,89`); through 250 ms within
  3px. The close lands within 1px.
- **Per column:** a finer check of each column's top and top color found all 10 columns within 1px and one RGB
  unit, with Everyone else on and off. Write the equivalent for your graph (bars, rows, lines, cells).

**Per row** (`dev/rows_check.js`, for a list): every animation paused and sought to 20 and 120 ms of an open and 650
and 745 ms of a close, each card bar's left, width and top against the thumbnail's (in order, top to bottom):

```sh
EVAL="$(sed -e s/__CARD__/skips-card/ -e 's/__BAR__/#skips-list .skips-bar/' dev/rows_check.js)" OFFLINE=1 \
  python3 dev/shot.py "http://localhost:<port>/test.html?v=$RANDOM" /tmp/x.png 1280 1000
```

The three lists: within 0.4px at 20 ms and exact at 745 ms, with Everyone else on and off. In between they travel by
design. Their frames: median 16.7 ms, at most one slow frame on a close (as Every Month). motion_check samples
canvases, so pass the thumbnail's (`--charts thumb-race-card`).

**Per band** (`dev/band_check.js`, for areas and lines): each series' top edge in the thumbnail and in the plot,
compared at the thumbnail's points, and its fill, at given ms of an open (`__AT__`; `__SETUP__` sets the card's
choices first). Top … View and Hours per week: within 0.6px through 200 ms, fills equal.

**Every play, Every day** (`dev/flight_every.js`, `__OTHER__` its Everyone else toggle): the thumbnail's box cut into
40 bands across, each band's marks compared in the two canvases (height, amount drawn, mean color), with Everyone
else on and off.

**Top … View and Hours per week's boxes:** within 2px at 20, 120 and 250 ms of an open and 600 ms of a close.

**`motion_check custom`** gives frame times and cuts, for open and close:

```sh
T='document.getElementById("thumb-monthly-card").closest(".gal-tile")'
python3 dev/motion_check.py <port> custom --setup "$T.scrollIntoView({block:'center'})" --action "$T.click()" --seconds 1.2 --charts chart-monthly
python3 dev/motion_check.py <port> custom --setup "$T.scrollIntoView({block:'center'}); $T.click()" --action "document.querySelector('.gal-back').click()" --seconds 1.2 --charts chart-monthly
```

Every Month: median 16.7 ms, at most one 50 ms frame (the crossfade has the same). The jumps it reports, about 18%
on the first frame of an open and about 25% about 800 ms into a close, are the card's canvas switching while off
screen: the plot's first frame, and the card put back to itself after landing. A jump anywhere else is a real cut.

## Working on one graph alongside the others

Several sessions work at once, each in its own worktree branched from `worktree-gallery`. To merge cleanly:

**Yours to change:**
- Your slot in `arrivals.js`: imports and entries are both slotted by group, with a comment between slots.
- Your entries in `THUMBS` and `OVERLAYS` (thumbs.js).
- Your group's line in `STRETCH`.
- Your chart's own files, and your own line in `charts.js`'s re-exports.

**Not yours; flag to the owner instead:**
- gallery.js (the flight, `PLOT`, `chromeOf`, `fadeCanvas`, `arrive`) and the hook's signature.
- `digest()` in thumbs.js. If your thumbnail needs data it lacks, compute it beside your `THUMBS` entry, memoized
  on `d.key`.
- `otherOn`, `paintThumb` / `paintThumbs`, and `motion.js`.

**Re-score STRETCH** (0 to 1: how well the thumbnail looks a column and a half wide) once your thumbnails are final.

**Landing:** commit per graph. When the owner says so:
1. Rebase onto `worktree-gallery`, resolving conflicts by keeping the other graphs' slots.
2. From the gallery worktree, `git merge --ff-only <your branch>`.

It's never into main, and not with the `merge` skill (that one targets main). After it lands, run flight_check in
the gallery worktree on your cards and on Every Month: the flight still lands exactly, and the round trip returns to
the same scroll.

## Gotchas

- **zrender `traverse`** skips a node's children when the callback returns something truthy: write
  `(e) => void set.add(e)`.
- **Paints wait for the screen.** Thumbnails paint only near the screen (`paintThumb(id)` paints one now), and a
  card's paint waits while it's away (`putOff`), running as it opens (`bringBack`, before it's measured).
- **Private ECharts API.** `fadeCanvas` and flight_check use ECharts' `_chartsViews`, which is fine on the pinned
  5.6.0.
- **`getOption().series` has null holes** after a `replaceMerge` takes a series away: `filter(Boolean)` before
  reading it (Rank race, When you listened).
- **A tile taller than its plot overflows the card's canvas.** A thumbnail's shapes, placed on the plot's baseline,
  can stand above the card's canvas when the tile is squatter than they are tall; whatever is past the canvas is cut,
  `clip: false` or not. Check it and return false (When you listened does: it crossfades instead).
- **Drawing at once over a running morph.** A card's held paint (`bringBack`) can still be morphing when
  `("thumb", 0)` lands; ECharts, given data it already has, leaves the shapes partway. End the running animations
  first (`stopLines` in charts/clock.js). Every Month doesn't need it: per column, its plot lands exactly in the
  thumbnail's form even right after its Everyone else changes.
- **A thumbnail repaints on `CHASE_MS`.** Opened within 450 ms of a change the tiles follow (a period drag, a toggle),
  the flight starts on a thumbnail still moving toward what the card's first frame already shows (Every Month: up to
  34px per column). Measure with the change well before the click.
- **Pictures cost Spotify calls.** Each `test.html` load fetches uncached pictures; use `OFFLINE=1` unless pictures
  are what you're checking.

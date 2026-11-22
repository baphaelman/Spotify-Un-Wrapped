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
  the thumbnail and sits on the thumbnail's baseline. The tile is usually squatter than the plot, so the arrival
  stretches its first frame vertically by `(thumb aspect h/w) / (plot aspect h/w)` (Every Month: `look.stretch`).
- **The card's chrome.** The card's frame and everything beside the plot fade in over 0–40% (reversed on close). For
  an ECharts plot, its DOM overlays and every drawn shape that isn't a series' fade too: axes, guides, labels,
  through zrender opacity. A plot of HTML elements or its own canvas is all plot: the arrival fades whatever in it
  doesn't morph.
- **The thumbnail.** It fades out over 0–25%, over shapes that match it, and the card draws above the tile.

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

Under zsh, pass the card and selector as literal words, not through an unquoted variable: zsh doesn't word-split it.

**Every Month's numbers:**
- **Boxes:** at 20 ms the two boxes agree within 1px (`467,491,346,89` vs `467,492,346,89`); through 250 ms within
  3px. The close lands within 1px.
- **Per column:** a finer check of each column's top and top color found all 10 columns within 1px and one RGB
  unit, with Everyone else on and off. Write the equivalent for your graph (bars, rows, lines, cells).

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
- **Pictures cost Spotify calls.** Each `test.html` load fetches uncached pictures; use `OFFLINE=1` unless pictures
  are what you're checking.

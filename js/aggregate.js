// Pure aggregations over the normalized plays list. All dates are in the viewer's local time.

const DAY = 86400000;
const HOUR = 3600000;

// Days since epoch for the local calendar date of t.
export function dayIndex(t) {
  const d = new Date(t);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

export function dayToDate(i) {
  const d = new Date(i * DAY);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function years(plays) {
  return [...new Set(plays.map((p) => new Date(p.t).getFullYear()))].sort();
}

// First index whose play is at or after time t (plays are sorted by time)
function lowerBound(plays, t) {
  let lo = 0, hi = plays.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (plays[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The plays on days lo..hi (day indices, inclusive)
export function filterRange(plays, lo, hi) {
  return plays.slice(lowerBound(plays, dayToDate(lo).getTime()), lowerBound(plays, dayToDate(hi + 1).getTime()));
}

function sumBy(plays, keyFn) {
  const m = new Map();
  for (const p of plays) {
    const k = keyFn(p);
    const e = m.get(k) || { hours: 0, plays: 0 };
    e.hours += p.ms / HOUR;
    e.plays += p.w ?? 1; // a genre view's play shared across genres counts its share
    m.set(k, e);
  }
  return m;
}

export function topArtists(plays, n) {
  return [...sumBy(plays, (p) => p.artist)]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.hours - a.hours)
    .slice(0, n);
}

// The parts an item's band splits into (see topParts): its albums, its songs, or (a genre's) its artists
export const partOf = (kind) =>
  kind === "album" ? (p) => p.album || "Unknown album" : kind === "artist" ? (p) => p.by ?? p.artist : (p) => p.track;
const PART_OF_ITEM = 0.05; // of the item's own hours
const PART_OF_ALL = 0.0015; // of all the listening in the plays
export const MAX_PARTS = 4;

// For each of `artists`, the albums or songs (kind) prominent enough to draw as their own part of its band:
// at least PART_OF_ITEM of the item's hours and PART_OF_ALL of everyone's, up to MAX_PARTS, biggest first
export function topParts(plays, artists, kind) {
  const subOf = partOf(kind);
  const want = new Set(artists);
  const by = new Map(); // item -> part -> ms
  const own = new Map(); // item -> ms
  let total = 0;
  for (const p of plays) {
    total += p.ms;
    if (!want.has(p.artist)) continue;
    const name = subOf(p);
    own.set(p.artist, (own.get(p.artist) ?? 0) + p.ms);
    if (name == null) continue;
    if (!by.has(p.artist)) by.set(p.artist, new Map());
    const m = by.get(p.artist);
    m.set(name, (m.get(name) ?? 0) + p.ms);
  }
  return artists.map((a) =>
    [...(by.get(a) ?? [])]
      .filter(([, ms]) => ms >= PART_OF_ITEM * own.get(a) && ms >= PART_OF_ALL * total)
      .sort((x, y) => y[1] - x[1])
      .slice(0, MAX_PARTS)
      .map(([name]) => name)
  );
}

// A track view's or album view's plays (main.js keyedPlays) have the track or album in `artist` and the artist
// in `by`. Tracks are always told apart by their real artist; `key` is what the view calls the track's first
// play (its artist, the track itself or its album), and `album` that play's album.
const artistOf = (p) => p.by ?? p.artist;

export function topTracks(plays, n) {
  const first = new Map();
  const sums = sumBy(plays, (p) => {
    const k = p.track + "\u0000" + artistOf(p);
    if (!first.has(k)) first.set(k, p);
    return k;
  });
  return [...sums]
    .map(([k, v]) => {
      const [name, artist] = k.split("\u0000");
      return { name, artist, key: first.get(k).artist, album: first.get(k).album, ...v };
    })
    .sort((a, b) => b.hours - a.hours)
    .slice(0, n);
}

export function summary(plays) {
  const hours = plays.reduce((s, p) => s + p.ms, 0) / HOUR;
  const days = new Set(plays.map((p) => dayIndex(p.t)));
  return {
    hours,
    plays: plays.length,
    artists: new Set(plays.map(artistOf)).size,
    tracks: new Set(plays.map((p) => p.track + "\u0000" + artistOf(p))).size,
    activeDays: days.size,
    first: new Date(plays[0].t),
    last: new Date(plays[plays.length - 1].t),
  };
}

// How many months each bar of the monthly chart covers, so a long period doesn't crowd into slivers: the shortest
// of a month, 3 months, 6 months, a year or 2 years that keeps it to MAX_BARS bars (blocks align to the year, as
// in monthly)
const SPANS = [1, 3, 6, 12, 24];
const MAX_BARS = 18;
export function monthSpan(plays) {
  if (!plays.length) return 1;
  const k = (t) => new Date(t).getFullYear() * 12 + new Date(t).getMonth();
  const lo = k(plays[0].t), hi = k(plays[plays.length - 1].t);
  return SPANS.find((s) => Math.floor(hi / s) - Math.floor(lo / s) + 1 <= MAX_BARS) ?? SPANS[SPANS.length - 1];
}

// [{ month: Date, hours, by, top }] with empty months filled in, in blocks of `span` calendar months (one of SPANS,
// aligned to the year; `month` is the block's first). `by` is the hours each of `artists` contributed that block,
// in the same order; whatever is left of `hours` is everyone else. `top` is the block's `n` biggest artists of
// all, as [{ name, hours }].
export function monthly(plays, artists = [], n = 5, span = 1) {
  const col = new Map(artists.map((a, i) => [a, i]));
  const m = new Map();
  for (const p of plays) {
    const d = new Date(p.t);
    const k = Math.floor((d.getFullYear() * 12 + d.getMonth()) / span);
    let e = m.get(k);
    if (!e) m.set(k, (e = { hours: 0, by: new Array(artists.length).fill(0), each: new Map() }));
    const h = p.ms / HOUR;
    e.hours += h;
    e.each.set(p.artist, (e.each.get(p.artist) || 0) + h);
    const i = col.get(p.artist);
    if (i !== undefined) e.by[i] += h;
  }
  const keys = [...m.keys()];
  if (!keys.length) return [];
  const lo = Math.min(...keys), hi = Math.max(...keys);
  const out = [];
  for (let k = lo; k <= hi; k++) {
    const e = m.get(k);
    const top = e ? [...e.each].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, hours]) => ({ name, hours })) : [];
    out.push({ month: new Date(Math.floor((k * span) / 12), (k * span) % 12, 1), hours: e?.hours || 0, by: e?.by || new Array(artists.length).fill(0), top });
  }
  return out;
}

// 7 x 24 matrix of hours: [weekday (Mon=0)][hour].
export function clock(plays) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const p of plays) {
    const d = new Date(p.t);
    grid[(d.getDay() + 6) % 7][d.getHours()] += p.ms / HOUR;
  }
  return grid;
}

// The week in blocks of `block` hours (24 / block of them a day), with each of `artists`' hours picked out:
// [weekday (Mon=0)][block] = { hours, by }, where whatever is left of `hours` is everyone else.
export function clockBy(plays, artists = [], block = 3) {
  const col = new Map(artists.map((a, i) => [a, i]));
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 / block }, () => ({ hours: 0, by: new Array(artists.length).fill(0) })));
  for (const p of plays) {
    const d = new Date(p.t);
    const e = grid[(d.getDay() + 6) % 7][Math.floor(d.getHours() / block)];
    const h = p.ms / HOUR;
    e.hours += h;
    const i = col.get(p.artist);
    if (i !== undefined) e.by[i] += h;
  }
  return grid;
}

// Hours per day for each artist (plus "Everyone else" last, if included), as prefix sums so any span of days
// is O(1). The rolling chart and the mix bar both read from this, so they always agree.
// Each artist's row is worked out once per set of plays and kept, so a new artist set (as when dragging the
// period window reshuffles the top artists) costs only the rows it hasn't seen.
const tables = new WeakMap(); // plays → { first, last, len, byArtist: artist → their plays, rows: artist → prefix, parts, everyone }
export function dailyTable(plays, artists, includeOther) {
  let tb = tables.get(plays);
  if (!tb) {
    // (no plays at all, as in the genres view before any genres are known: no days)
    const first = plays.length ? dayIndex(plays[0].t) : 0;
    const last = plays.length ? dayIndex(plays[plays.length - 1].t) : -1;
    const byArtist = new Map();
    for (const p of plays) {
      const list = byArtist.get(p.artist);
      if (list) list.push(p);
      else byArtist.set(p.artist, [p]);
    }
    tb = { first, last, len: last - first + 1, byArtist, rows: new Map(), parts: new Map() };
    tb.everyone = prefixOf(tb, plays);
    tables.set(plays, tb);
  }
  const prefix = artists.map((a) => {
    let row = tb.rows.get(a);
    if (!row) tb.rows.set(a, (row = prefixOf(tb, tb.byArtist.get(a) ?? [])));
    return row;
  });
  if (includeOther) {
    // Everyone else: everyone, less the artists shown
    const rest = Float64Array.from(tb.everyone);
    for (const row of prefix) for (let i = 0; i <= tb.len; i++) rest[i] -= row[i];
    prefix.push(rest);
  }
  return { first: tb.first, last: tb.last, len: tb.len, prefix, tb };
}

// One album's or song's (kind) row within an artist's, kept like the artists' own
function partPrefix(tb, artist, kind, name) {
  const key = [artist, kind, name].join("\u0000");
  let row = tb.parts.get(key);
  if (!row) {
    const subOf = partOf(kind);
    tb.parts.set(key, (row = prefixOf(tb, (tb.byArtist.get(artist) ?? []).filter((p) => subOf(p) === name))));
  }
  return row;
}

// Hours per day of some plays, as prefix sums over the table's days
function prefixOf({ first, len }, plays) {
  const out = new Float64Array(len + 1);
  for (const p of plays) out[dayIndex(p.t) - first + 1] += p.ms / HOUR;
  for (let i = 0; i < len; i++) out[i + 1] += out[i];
  return out;
}

// Each series' hours over the days [from, to] (day indices, inclusive, clipped to the data), and their sum
export function rangeHours(table, from, to) {
  const a = Math.max(0, from - table.first), b = Math.min(table.len, to - table.first + 1);
  const hours = table.prefix.map((pre) => (b > a ? pre[b] - pre[a] : 0));
  return { hours, total: hours.reduce((x, y) => x + y, 0) };
}

const START_MIN_SHARE = 0.2; // of the median window's hours, for the chart to begin


// The index of the first point whose window holds at least a fifth of the typical window's listening (the
// median over points with any), or -1 if nothing was played
export function leadIn(totals) {
  const played = totals.filter((x) => x > 0).sort((a, b) => a - b);
  const typical = played[Math.floor(played.length / 2)];
  return typical ? totals.findIndex((x) => x >= typical * START_MIN_SHARE) : -1;
}

// Port of rolling_window.py: a centered rolling sum of daily hours per artist,
// converted to each artist's share of listening at that point in time.
// Edges where the window doesn't fully fit are dropped (pandas min_periods=window).
//
// gridWindow: the window that decides which dates get a point (default: `window` itself). A different one
// gives the points of another window's chart, filled in with this window; where this window sticks out
// past the data, it's cut off there. That lets a chart tween between window sizes with the same points
// throughout.
//
// split: optional { kind, names }, each artist's parts (names[s], from topParts) to work out alongside them.
// They come back as `parts` ({ kind, names, hours, share }, rows by artist, then part); a part's share is of
// the same total as the artists', so the parts sit inside their artist's band.
export function rolling(plays, artists, window, includeOther, gridWindow = window, split = null) {
  const { first, len, prefix, tb } = dailyTable(plays, artists, includeOther);
  const partPre = split ? split.names.map((list, s) => list.map((name) => partPrefix(tb, artists[s], split.kind, name))) : [];
  const partHours = partPre.map((list) => list.map(() => []));
  const partShare = partPre.map((list) => list.map(() => []));
  const nSeries = prefix.length;

  const half = Math.floor(window / 2);
  const gridHalf = Math.floor(gridWindow / 2);
  const everyone = dailyTable(plays, [], true).prefix[0];
  const everyoneTotals = [];
  const dates = [];
  const hours = Array.from({ length: nSeries }, () => []);
  const share = Array.from({ length: nSeries }, () => []);
  for (let gridStart = 0; gridStart + gridWindow <= len; gridStart++) {
    const center = gridStart + gridHalf;
    const start = Math.max(0, center - half), end = Math.min(len, center - half + window);
    const sums = prefix.map((pre) => pre[end] - pre[start]);
    const total = sums.reduce((a, b) => a + b, 0);
    dates.push(dayToDate(first + center).getTime());
    everyoneTotals.push(everyone[gridStart + gridWindow] - everyone[gridStart]);
    for (let s = 0; s < nSeries; s++) {
      hours[s].push(sums[s]);
      share[s].push(total > 0 ? sums[s] / total : null); // null = gap where nothing was played
    }
    partPre.forEach((list, s) => list.forEach((pre, j) => {
      const sum = pre[end] - pre[start];
      partHours[s][j].push(sum);
      partShare[s][j].push(total > 0 ? sum / total : null);
    }));
  }
  // Drop the near-empty stretch at the start: exports often begin with a few stray plays long before
  // the real listening. The chart starts at the first point whose window holds at least a fifth of the
  // typical window's listening (the median over points with any). A chart with nothing is left alone.
  // The totals are all listening, not just the artists drawn, so every artist set (and "Everyone else" on or
  // off) starts on the same date. Charts tween point by point, and shifted dates would pair the wrong points.
  // They are measured on the grid window, not this one, so every step of a window sweep trims the same start.
  const lead = leadIn(everyoneTotals);
  if (lead > 0) {
    dates.splice(0, lead);
    for (const arr of [...hours, ...share, ...partHours.flat(), ...partShare.flat()]) arr.splice(0, lead);
  }
  const parts = split ? { kind: split.kind, names: split.names, hours: partHours, share: partShare } : undefined;
  return { dates, hours, share, parts };
}

// Aggressive extra smoothing for the rolling chart: a Gaussian blur of every series along the time axis,
// on top of the rolling window. strength 1 (low), 2 (med), 3 (high) or 4 (max), or "auto" sets sigma (days) as a fraction of the window, so a wide
// window blurs more; 0 returns the data as is. Gaps
// (null, nothing played) stay gaps and don't leak into their neighbors; every series is blurred with the
// same weights, so shares still add up to 1 wherever there's a value.
const SMOOTHIFY_SIGMA = [0, 0.05, 0.12, 0.275, 0.55]; // x the window, per strength
// The blur radius (days) for a strength, so callers can step through the radii in between
// "auto" scales the blur with how much time is on screen instead: none at a year or less, the high strength
// from three years out, and twice that (the max strength) from six years out, in between on a log scale.
// Returns 0..2, in units of the high strength.
// [visible days, how much of the high strength]: none up to a year, low at two, high at three, max at six
// The same for every view, so switching views never re-smooths the chart.
const AUTO_SPAN = [[365, 0], [730, 0.25], [1095, 1], [2190, 2]];
function interpLog(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    if (x <= x1) return y0 + (y1 - y0) * (Math.log(x / x0) / Math.log(x1 / x0));
  }
  return points[points.length - 1][1];
}
export const autoAmount = (span) => interpLog(AUTO_SPAN, span);
// span: days on screen, for "auto"
export const smoothifySigma = (window, strength, span) =>
  strength === "auto"
    ? autoAmount(span) * Math.max(1, window * SMOOTHIFY_SIGMA[3])
    : strength ? Math.max(1, window * SMOOTHIFY_SIGMA[strength]) : 0;
export const smoothify = (data, window, strength) => blur(data, smoothifySigma(window, strength));

// Gaussian blur of every series with the given sigma in days; below half a day it changes nothing
export function blur({ dates, hours, share, parts }, sigma) {
  if (sigma < 0.5) return { dates, hours, share, parts };
  const r = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * sigma * sigma)));
  const n = dates.length;
  const run = (arr) =>
    arr.map((_, i) => {
      if (arr[i] == null) return null;
      let sum = 0, w = 0;
      for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) {
        if (arr[k] == null) continue;
        const g = kernel[k - i + r];
        sum += arr[k] * g;
        w += g;
      }
      return sum / w;
    });
  const nested = (rows) => rows.map((list) => list.map(run));
  return {
    dates, hours: hours.map(run), share: share.map(run),
    parts: parts && { ...parts, hours: nested(parts.hours), share: nested(parts.share) },
  };
}

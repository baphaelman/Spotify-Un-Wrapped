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

export function filterYear(plays, year) {
  if (year === "all") return plays;
  return plays.filter((p) => new Date(p.t).getFullYear() === Number(year));
}

function sumBy(plays, keyFn) {
  const m = new Map();
  for (const p of plays) {
    const k = keyFn(p);
    const e = m.get(k) || { hours: 0, plays: 0 };
    e.hours += p.ms / HOUR;
    e.plays += 1;
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

export function topTracks(plays, n) {
  return [...sumBy(plays, (p) => p.track + "\u0000" + p.artist)]
    .map(([k, v]) => {
      const [name, artist] = k.split("\u0000");
      return { name, artist, ...v };
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
    artists: new Set(plays.map((p) => p.artist)).size,
    tracks: new Set(plays.map((p) => p.track + "\u0000" + p.artist)).size,
    activeDays: days.size,
    first: new Date(plays[0].t),
    last: new Date(plays[plays.length - 1].t),
  };
}

// [{ month: Date, hours }] with empty months filled in.
export function monthly(plays) {
  const m = sumBy(plays, (p) => {
    const d = new Date(p.t);
    return d.getFullYear() * 12 + d.getMonth();
  });
  const keys = [...m.keys()];
  if (!keys.length) return [];
  const lo = Math.min(...keys), hi = Math.max(...keys);
  const out = [];
  for (let k = lo; k <= hi; k++) {
    out.push({ month: new Date(Math.floor(k / 12), k % 12, 1), hours: m.get(k)?.hours || 0 });
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

// Hours per day for each artist (plus "Everyone else" last, if included), as prefix sums so any span of days
// is O(1). The rolling chart and the mix bar both read from this, so they always agree.
export function dailyTable(plays, artists, includeOther) {
  const first = dayIndex(plays[0].t);
  const last = dayIndex(plays[plays.length - 1].t);
  const len = last - first + 1;
  const idx = new Map(artists.map((a, i) => [a, i]));
  const nSeries = artists.length + (includeOther ? 1 : 0);
  const daily = Array.from({ length: nSeries }, () => new Float64Array(len));
  for (const p of plays) {
    let s = idx.get(p.artist);
    if (s === undefined) {
      if (!includeOther) continue;
      s = artists.length;
    }
    daily[s][dayIndex(p.t) - first] += p.ms / HOUR;
  }
  const prefix = daily.map((arr) => {
    const out = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) out[i + 1] = out[i] + arr[i];
    return out;
  });
  return { first, last, len, prefix };
}

// Each series' hours over the days [from, to] (day indices, inclusive, clipped to the data), and their sum
export function rangeHours(table, from, to) {
  const a = Math.max(0, from - table.first), b = Math.min(table.len, to - table.first + 1);
  const hours = table.prefix.map((pre) => (b > a ? pre[b] - pre[a] : 0));
  return { hours, total: hours.reduce((x, y) => x + y, 0) };
}

// Port of rolling_window.py: a centered rolling sum of daily hours per artist,
// converted to each artist's share of listening at that point in time.
// Edges where the window doesn't fully fit are dropped (pandas min_periods=window).
//
// gridWindow: the window that decides which dates get a point (default: `window` itself). A different one
// gives the points of another window's chart, filled in with this window; where this window sticks out
// past the data, it's cut off there. That lets a chart tween between window sizes with the same points
// throughout.
export function rolling(plays, artists, window, includeOther, gridWindow = window) {
  const { first, len, prefix } = dailyTable(plays, artists, includeOther);
  const nSeries = prefix.length;

  const half = Math.floor(window / 2);
  const gridHalf = Math.floor(gridWindow / 2);
  const dates = [];
  const hours = Array.from({ length: nSeries }, () => []);
  const share = Array.from({ length: nSeries }, () => []);
  for (let gridStart = 0; gridStart + gridWindow <= len; gridStart++) {
    const center = gridStart + gridHalf;
    const start = Math.max(0, center - half), end = Math.min(len, center - half + window);
    const sums = prefix.map((pre) => pre[end] - pre[start]);
    const total = sums.reduce((a, b) => a + b, 0);
    dates.push(dayToDate(first + center).getTime());
    for (let s = 0; s < nSeries; s++) {
      hours[s].push(sums[s]);
      share[s].push(total > 0 ? sums[s] / total : null); // null = gap where nothing was played
    }
  }
  return { dates, hours, share };
}

// Aggressive extra smoothing for the rolling chart: a Gaussian blur of every series along the time axis,
// on top of the rolling window. strength 1 (low), 2 (med) or 3 (high), or "auto" sets sigma (days) as a fraction of the window, so a wide
// window blurs more; 0 returns the data as is. Gaps
// (null, nothing played) stay gaps and don't leak into their neighbors; every series is blurred with the
// same weights, so shares still add up to 1 wherever there's a value.
const SMOOTHIFY_SIGMA = [0, 0.05, 0.12, 0.275]; // x the window, per strength
// The blur radius (days) for a strength, so callers can step through the radii in between
// "auto" scales the blur with how much time is on screen instead: none at a year or less, the high strength
// from three years out, in between on a log scale. Returns 0..1.
const AUTO_SPAN = [[365, 0], [1095, 1]]; // [visible days, how much of the high strength]
export function interpLog(points, x) {
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
export function blur({ dates, hours, share }, sigma) {
  if (sigma < 0.5) return { dates, hours, share };
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
  return { dates, hours: hours.map(run), share: share.map(run) };
}

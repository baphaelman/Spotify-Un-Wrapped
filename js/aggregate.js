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

// Port of rolling_window.py: a centered rolling sum of daily hours per artist,
// converted to each artist's share of listening at that point in time.
// Edges where the window doesn't fully fit are dropped (pandas min_periods=window).
export function rolling(plays, artists, window, includeOther) {
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

  // Prefix sums make every window O(1)
  const prefix = daily.map((arr) => {
    const out = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) out[i + 1] = out[i] + arr[i];
    return out;
  });

  const half = Math.floor(window / 2);
  const dates = [];
  const hours = Array.from({ length: nSeries }, () => []);
  const share = Array.from({ length: nSeries }, () => []);
  for (let start = 0; start + window <= len; start++) {
    const sums = prefix.map((pre) => pre[start + window] - pre[start]);
    const total = sums.reduce((a, b) => a + b, 0);
    dates.push(dayToDate(first + start + half).getTime());
    for (let s = 0; s < nSeries; s++) {
      hours[s].push(sums[s]);
      share[s].push(total > 0 ? sums[s] / total : null); // null = gap where nothing was played
    }
  }
  return { dates, hours, share };
}

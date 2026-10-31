// "Try it with sample data": the site author's own history, stripped to what the page uses (built by
// dev/make_sample.py, which documents the format), so a visitor can look around without an export of their own.
// It's gzipped columnar JSON, unzipped here with DecompressionStream, and turned back into parse.js's plays.
const URL_ = "sample/history.json.gz";

export async function loadSample() {
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`Couldn't load the sample data (${res.status})`);
  const d = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).json();
  const tracks = d.tracks.map(([track, a, al, id]) => ({ track, artist: d.artists[a], album: d.albums[al], id: id || undefined }));
  const skipped = new Set();
  let at = -1;
  for (const gap of d.skip) skipped.add((at += gap));
  const plays = new Array(d.k.length);
  let t = d.t0;
  for (let i = 0; i < plays.length; i++) {
    t += d.dt[i];
    const tr = tracks[d.k[i]];
    plays[i] = { t: t * 1000, ms: d.ms[i], artist: tr.artist, track: tr.track, album: tr.album, skipped: skipped.has(i), id: tr.id };
  }
  return plays;
}

// Turns whatever the user dropped (zip, folder, JSON files) into a flat list of plays:
// { t: epoch ms, ms: ms played, artist, track, album, skipped }

const EXTENDED = /Streaming_History_Audio.*\.json$/i;        // "Extended streaming history"
const ACCOUNT = /StreamingHistory(_music)?_?\d*\.json$/i;     // older "Account data" export

function isHistoryFile(name) {
  const base = name.split("/").pop();
  return EXTENDED.test(base) || (ACCOUNT.test(base) && !/podcast/i.test(base));
}

// Collect File objects from a drop, descending into folders.
export async function filesFromDataTransfer(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  async function walk(entry) {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns results in batches until it returns an empty array
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e);
      }
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

// Returns [{ name, text }] for every streaming-history JSON, unzipping as needed.
async function collectJson(files, onProgress) {
  const out = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name)) {
      onProgress?.(`Unzipping ${file.name}…`);
      const zip = await JSZip.loadAsync(file);
      for (const entry of Object.values(zip.files)) {
        if (!entry.dir && isHistoryFile(entry.name)) {
          out.push({ name: entry.name, text: await entry.async("string") });
        }
      }
    } else if (isHistoryFile(file.name)) {
      out.push({ name: file.name, text: await file.text() });
    }
  }
  return out;
}

function normalizeExtended(r) {
  const artist = r.master_metadata_album_artist_name;
  if (!artist) return null; // podcasts, audiobooks
  return {
    t: Date.parse(r.ts),
    ms: r.ms_played || 0,
    artist,
    track: r.master_metadata_track_name || "Unknown track",
    album: r.master_metadata_album_album_name || "",
    skipped: !!r.skipped,
  };
}

function normalizeAccount(r) {
  if (!r.artistName || r.artistName === "Unknown Artist") return null;
  return {
    t: Date.parse(r.endTime.replace(" ", "T") + "Z"),
    ms: r.msPlayed || 0,
    artist: r.artistName,
    track: r.trackName || "Unknown track",
    album: "",
    skipped: false,
  };
}

export async function parseFiles(files, onProgress) {
  const jsons = await collectJson(files, onProgress);
  if (!jsons.length) {
    throw new Error("No streaming history found. Look for files named Streaming_History_Audio_*.json.");
  }
  const extended = jsons.filter((j) => EXTENDED.test(j.name.split("/").pop()));
  // The account export only covers the last year; if extended history is present it's a superset.
  const use = extended.length ? extended : jsons;
  const normalize = extended.length ? normalizeExtended : normalizeAccount;

  const plays = [];
  for (const [i, j] of use.entries()) {
    onProgress?.(`Reading ${j.name.split("/").pop()} (${i + 1}/${use.length})…`);
    for (const r of JSON.parse(j.text)) {
      const p = normalize(r);
      if (p && !Number.isNaN(p.t)) plays.push(p);
    }
  }
  if (!plays.length) throw new Error("Those files didn't contain any music plays.");
  plays.sort((a, b) => a.t - b.t);
  return plays;
}

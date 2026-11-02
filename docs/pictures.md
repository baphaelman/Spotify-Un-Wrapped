# Pictures

The listening mix's key shows each item's picture: an artist's photo, or an album's cover (a track shows its
album's). `js/covers.js` asks the edge function `smooth-endpoint` (`supabase/functions/artist-image`), which asks
Spotify's Web API. The Spotify app is in development mode, with a small, unpublished allowance, and bursts over it
earn lockouts of up to a day (see CLAUDE.md), so the function is built to spend as few calls as it can:

- **Each picture is looked up once, for everyone.** Answers (a URL, or "" for none) are kept in the `pictures`
  table, keyed `"<kind>:<first track ID>"`, the same key covers.js uses. A "none" is asked about again after 30 days.
- **One allowance for everyone:** `PER_MINUTE` lookups a minute (a lookup is 1 to 6 API calls), counted in
  `picture_budget` by `picture_spend`. A visitor's lookup goes ahead at once while there's room; otherwise the
  picture is queued (`picture_queue`, newest asked first) and the page gets `202 { pending, wait }` and asks again
  after the wait, up to 10 times a visit.
- **The worker:** pg_cron posts to the function once a minute with the header `x-worker-key` (the secret
  `PICTURES_WORKER_KEY`). It works through the queue for about 50 s, one lookup every `60 / PER_MINUTE` s, within
  what the allowance has left. So a picture asked for once is found even after its visitor has left.
- **A lockout is shared:** when Spotify answers 429, `picture_busy` stores its `Retry-After`, and nobody (visitors
  or worker) calls Spotify until it's over. Visitors get `503 { busy, wait }`, which the page already understands.

## Setting it up (Supabase dashboard)

Order matters: the new function reads the tables, so make them first.

1. Run the Pictures part of `supabase/schema.sql` in the SQL editor (`pictures`, `picture_queue`,
   `picture_budget` and their four functions). Safe to re-run.
2. Make up a worker key (for example `openssl rand -hex 24`) and add it under Edge Functions -> Secrets as
   `PICTURES_WORKER_KEY`.
3. Edge Functions -> open `smooth-endpoint` -> paste `supabase/functions/artist-image/index.ts` -> deploy. JWT
   verification stays off.
4. In the SQL editor (pg_cron and pg_net are already on for the genres worker), with your key in place of `<key>`:

   ```sql
   select cron.schedule('pictures-worker', '* * * * *', $$
     select net.http_post(
       url := 'https://qvsoxqeuvpnryitechsf.supabase.co/functions/v1/smooth-endpoint',
       headers := '{"Content-Type": "application/json", "x-worker-key": "<key>"}'::jsonb,
       body := '{}'::jsonb,
       timeout_milliseconds := 10000)
   $$);
   ```

   To check it: the function's logs show `worker: N looked up, ...`, `select count(*) from picture_queue;` shrinks
   and `select count(*) from pictures;` grows. `select * from picture_budget;` shows this minute's count and any
   lockout. To stop it: `select cron.unschedule('pictures-worker');`.

## Rules for agents (moved from CLAUDE.md)

On 2026-10-29 an idle warm-up (about 150 lookups per page load, each several API calls) plus repeated test loads got
the app a 429 with `Retry-After: 83512` (about 23 hours). While locked out, every picture is blank for every visitor.

- **Never bulk-fetch pictures:** no warm-ups, prefetching or scripts that loop over artists or albums against the
  function. Look up only what's on screen (the key already waits for the bar to hold still).
- **Each page load of `test.html` costs real Spotify calls** for any picture not already cached. The cache is per
  origin, so keep one port and one profile for a task, take few screenshots, and don't loop them. `OFFLINE=1` on
  `dev/shot.py` (and `dev/motion_check.py`, always) cuts the page off from Supabase.
- **Check whether the app is locked out** with one request:
  `curl -s "https://qvsoxqeuvpnryitechsf.supabase.co/functions/v1/smooth-endpoint?kind=album&tracks=4cOdK2wGLETKBW3PvgPWqT"`.
  `{"error":"busy","wait":N}` means locked out for N more seconds; the page then stops asking for that visit (waits
  under 2 minutes it holds and retries).
- **Don't work around a lockout** (new Spotify apps, other keys, spoofed clients). Wait it out and tell the owner.
- The function tries up to five of an item's track IDs, then a search by name, then the other kind of picture, and
  skips Spotify's ~1 KB blank placeholder. The page remembers found URLs in localStorage (`unwrapped-pictures`).
- Before deploying a version of `smooth-endpoint` that needs new tables or the worker, confirm the owner has run the
  SQL and set `PICTURES_WORKER_KEY`, or every picture goes blank. Never probe the database's functions to find out
  (`picture_busy` writes the shared lockout). Each test of the function costs Spotify calls.

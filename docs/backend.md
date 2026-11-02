# Backend: edge functions and the community pool

## Edge functions

Deploy them yourself with the Supabase CLI; don't hand the owner a file to paste into the dashboard.

- **Check before deploying:** `/opt/homebrew/bin/deno check supabase/functions/<name>/index.ts` (Deno isn't on the
  shell's PATH). A deploy goes live for every visitor at once, so deploy only a change that's committed and checked.
- **Deploy:** `supabase functions deploy <name> --project-ref qvsoxqeuvpnryitechsf --no-verify-jwt`. Every function
  here has JWT verification off. Then watch its logs or make one test request. The CLI is at
  `/opt/homebrew/bin/supabase`, logged in as the owner; its "Docker is not running" warning doesn't matter for a deploy.
- **`artist-image` is deployed as `smooth-endpoint`:** `supabase functions deploy smooth-endpoint` (the
  `[functions.smooth-endpoint]` entry in `supabase/config.toml` points at the `artist-image` folder). A deployed
  function can't be renamed. Read `docs/pictures.md` before deploying it.
- **Secrets** (`LASTFM_API_KEY`, `GENRES_WORKER_KEY`, `PICTURES_WORKER_KEY`, the Spotify credentials) stay in the
  dashboard; never print them.

## Community pool

- **Supabase project `qvsoxqeuvpnryitechsf`.** The publishable key in `js/config.js` is meant to be public.
- **The browser can only call these functions:** `submit_summary`, `delete_summary`, `is_shared`, `community_stats`
  and `artist_ranks`, plus the feedback ones (`submit_feedback`, and `list_feedback`, `set_feedback_done`,
  `delete_feedback`, which need the owner's admin key). RLS is on with no policies, so direct table access is refused.
- **The shared summary** (`summary.js`) holds totals, the top 500 artists and tracks with hours, and the 168-cell
  clock. Nothing else leaves the browser.
- **Submission key:** sha256 of the user's first 200 plays. Re-uploading replaces the old summary, and only someone
  with the data can delete it.
- **Minimum crowd of 5:** nothing is shown below 5 contributors, and an artist or track appears only once 5
  contributors have it.
- **Known gap:** there's no rate limiting or bot check. Cloudflare Turnstile is the plan if spam shows up.
- **Fake data:** `python3 dev/seed_community.py seed|cleanup` adds or removes 12 fake contributors (keys from
  `"synthetic-test-<i>"`). `cleanup` never touches real submissions.

# Spotify (Un)Wrapped
If you have Spotify Premium you can request all your streaming data for free. I hope to make a website that will automatically create beautiful visualizations once you drag your streaming files

**Try it:** https://baphaelman.github.io/Spotify-Un-Wrapped/

<img width="1405" height="785" alt="Screenshot 2026-10-27 at 7 55 44 PM" src="https://github.com/user-attachments/assets/220565d3-daaf-4930-9e33-430833405149" />

# Python demo
Follow the instructions in 'Quick n Dirty Spotify Graph.pdf' to get started
It is indeed quick n dirty, copy-pasted from a Jupyter notebook I was fooling around in.

# To Do
- [ ] Get some other peoples' data and see what assumptions I can/can't safely make (how are podcasts treated? easy way to deal with sleep playlists? what do people actually want to see? also just snoopy lol
)
- [x] Make it an actual website lol
- [ ] Rate-limit or bot-check community submissions if spam shows up

# Website
## Run it

No build step or dependencies. Serve the folder with any static server:

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 and drop in `my_spotify_data.zip`, its unzipped folder, or the `Streaming_History_Audio_*.json` files. (Opening `index.html` straight from disk won't work, because browsers block ES modules over `file://`.)

To deploy, push the folder to any static host (GitHub Pages, Netlify, Cloudflare Pages).

## Getting the data

1. Go to [Spotify's privacy settings](https://www.spotify.com/account/privacy/) and scroll to *Download your data*.
2. Check *Extended streaming history* and click *Request data*.
3. Spotify emails you a zip. This can take a few days.

The older *Account data* export (`StreamingHistory_music_*.json`, last year only) also works.

## Layout

| File | What it does |
|---|---|
| `index.html` | Page shell. Loads ECharts and JSZip from cdnjs |
| `js/parse.js` | Reads the zip, folder, or JSON files and normalizes plays |
| `js/aggregate.js` | Pure aggregations: top lists, monthly totals, the listening clock, and the rolling window (a port of `rolling_window.py`) |
| `js/charts.js` | ECharts renderers |
| `js/main.js` | Drag and drop, filters, tabs, sharing, and wiring |
| `js/lists.js` | Ranked lists and stat tiles |
| `js/store.js` | Remembers the loaded data on this device (IndexedDB) |
| `dev/` | Test tools: headless screenshots, test pages, fake community data |
| `js/summary.js` | Builds the anonymous summary that gets shared, plus the submission key |
| `js/api.js`, `js/config.js` | Supabase client and settings |
| `js/community.js` | Community page |
| `supabase/schema.sql` | Tables and functions for the community pool |
| `css/style.css` | Light and dark color tokens and layout |

`rolling_window.py` is the original pandas/Plotly prototype.

## Community pool (optional)

Users can opt in to share an anonymous summary: totals, their top 500 artists and tracks with hours, and a weekday × hour grid. It's stored in Supabase and powers the Community tab.

- Setup: paste [`supabase/schema.sql`](supabase/schema.sql) into the Supabase SQL editor and run it. The project URL and publishable key live in `js/config.js`.
- The browser can only call the validated functions in that file. It can't read the tables.
- Community charts only include artists and tracks shared by at least 5 contributors, and nothing appears until 5 people have shared.
- Each submission is keyed by a hash of the user's first 200 plays, so re-uploading replaces the old summary, and only someone holding the data can remove it.

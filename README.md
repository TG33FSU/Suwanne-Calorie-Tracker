# Suwannee Tracker

A MyFitnessPal-style calorie diary built around Suwannee Room (FSU Seminole
Dining). It pulls today's menu + nutrition facts from the dining hall's
website and lets you log what you eat, meal by meal, against a daily
calorie/macro goal.

Everything runs locally on your own laptop — no account, no cloud service,
your data stays in a folder on your machine.

## What's inside

```
dininghall-tracker/
  server.js       -> the local web server (Express) + API
  scraper.js       -> Puppeteer script that reads the Suwannee Room menu
  db.js             -> simple JSON-file storage (diary, goals, custom foods)
  public/            -> the web app itself (HTML/CSS/JS, no build step)
  data/               -> created automatically; your diary + menu cache live here
```

## Using it from your phone (in the dining hall)

`npm start` now prints a second URL alongside `localhost:3000`, something like:

```
On your phone (same WiFi as this computer), open:
  http://10.0.1.42:3000
```

As long as your phone is on the **same WiFi network** as your laptop (e.g. your dorm room's WiFi), open that URL in Safari or Chrome on your phone. Then:

- On iPhone: tap the Share button → **Add to Home Screen**. It'll show up as its own icon and open full-screen, no browser bar.
- Your laptop has to be on and running `npm start` for your phone to reach it — this is a local-network setup, not a hosted server. If you close the laptop or it goes to sleep, your phone loses the connection until you start it again.

**If your phone can't load that URL:** some campus/dorm WiFi networks (especially "secure"/enterprise networks like eduroam) block devices from talking directly to each other for security, even on the same network. If that's the case here, the next step up is actually hosting the app on a free cloud service (like Render or Railway) so it has a real public address — that's more setup (needs a GitHub account, and a bit of rework since the scraper's headless browser doesn't run well on most free hosting tiers), but it means the app works anywhere, laptop on or off. Ask if you want to go that route and we'll set it up.

## Your Favorites (taste ratings)

Expand any diary entry's nutrition facts and you'll see a rating widget:
5 stars plus optional tags (🔥 Would eat again, 💪 Great for protein,
💰 Worth getting, 👎 Skip it). Rating a food feeds a **Your Favorites**
leaderboard that appears above the diary once you've rated at least one
thing, ranked by your own average rating, with a one-tap "Add" button to
log it again later without re-searching the menu.

This is intentionally scoped to *your* ratings only — it's stored in your
local `data/ratings.json`, same as everything else. A true crowdsourced
version (real counts across every FSU student using the app) is a
meaningfully bigger project: it needs a shared hosted backend and database
instead of a local file, some way to stop spam/fake ratings since there's
no login, and, hardest of all, actual adoption by enough students that the
numbers mean anything. The backend part is buildable if this ever gets
there — ask if you want to explore it.

## Deploying to Render (or similar hosts)

If you're hosting this instead of/alongside running it locally, two things
matter that don't come up when it's just running on your own laptop:

**1. Puppeteer needs a real Chromium with system libraries, which Render's
default Node environment doesn't have.** This repo includes a `Dockerfile`
that installs Chromium properly via `apt` for exactly this reason. To use
it: in your Render service's settings, set **Environment** to **Docker**
(not "Node") so Render builds from the `Dockerfile` instead of just running
`npm install && npm start` directly. If your service is already set up as
plain Node, you'll need to recreate it as a Docker-environment service, or
check Render's docs for switching an existing service's environment.

**2. Render's free tier filesystem is ephemeral** — anything written to
`data/` (your diary, ratings, menu cache) disappears on every redeploy and
on the automatic restarts that happen after inactivity on the free tier.
The fix: point the app at a free MongoDB Atlas database instead of local
files. Atlas's free M0 tier requires no credit card and is free forever
(512MB storage — far more than this app needs). The app already supports
this — it's a config change, not a code change, on your end:

1. Go to [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register) and sign up (no card required).
2. Create a free **M0** cluster (pick any cloud provider/region — closest to you is fine).
3. Under **Database Access**, create a database user with a username/password.
4. Under **Network Access**, add `0.0.0.0/0` (allow from anywhere) — Render's outbound IP isn't fixed, so you can't narrow this down to a specific IP.
5. Click **Connect** on your cluster → **Drivers** → copy the connection string (looks like `mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/`).
6. In Render, go to your service → **Environment** → add an environment variable named `MONGODB_URI` with that connection string as the value (fill in your actual username/password in place of the placeholders).
7. Redeploy. The server logs will print `Storage backend: MongoDB Atlas` instead of `local JSON files` once it's picked up.

Your local Mac setup is unaffected either way — without a `MONGODB_URI`
environment variable set, it keeps using local JSON files exactly as
before, so nothing about running it with `npm start` on your laptop changes.

## Setup (one time)

You need [Node.js](https://nodejs.org) installed (v18 or newer).

```bash
cd dininghall-tracker
npm install
```

This installs Express (web server) and Puppeteer (which downloads its own
copy of Chromium — the install can take a minute or two, and needs a normal
internet connection).

## Running it

```bash
npm start
```

Then open **http://localhost:3000** in your browser. Leave the terminal
window running in the background while you use the app.

## Using it

- **Sync Suwannee Room menu** — click this button once a day (e.g. before
  breakfast) to pull the current menu and nutrition facts. It opens a
  background browser and reads the live site, so it takes 15–30 seconds.
- **+ Add food** on any meal (Breakfast/Lunch/Dinner/Snacks) opens a dialog
  with three tabs:
  - **Suwannee Room** — search today's synced menu.
  - **My foods** — anything you've quick-added before, saved for reuse
    (e.g. your regular Chick-fil-A order).
  - **Quick add** — type in a food and its nutrition facts by hand. Useful
    for anything not on the dining hall menu, or if a sync is stale.
- The ring and bars at the top track calories remaining and protein/carb/fat
  progress against your goals. Click **Edit goals** to set your own numbers.
- Use the arrows next to the date to look at or log a different day.

## About the scraper — please read

The Suwannee Room page loads its menu with JavaScript rather than putting it
directly in the page's HTML, so `scraper.js` uses Puppeteer to open a real
(headless) browser, load the page fully, and read the rendered content —
similar to what your own browser does.

Nutrition data isn't available by clicking a menu item directly. Instead,
each item has an **Add** button that adds it to a "Meal Calculator" panel,
which shows a running nutrition total ("Summary Nutritional Information")
for everything currently in it. So the scraper, for each item:

1. Clicks that item's **Add** button.
2. Clicks the "N items / N Cal" summary pill to open the calculator.
3. Reads the "Summary Nutritional Information" text that appears (since the
   calculator is cleared beforehand, this total equals just that one item).
4. Clicks **Clear all**, then **Ok**, to reset before the next item.

**Covering Breakfast, Lunch, and Dinner in one sync:** the page has a
"Meal:X" toggle that filters which items are shown. The scraper now clicks
through all three periods (Breakfast → Lunch → Dinner) automatically, so you
can log breakfast food later in the day even after the site's moved on to
showing dinner. This toggle-clicking logic is, like the Add-button logic
above, based on what the page's structure looked like when I built it, not
something I could verify myself — if a sync's console output shows
`Couldn't confirm the meal-period switch worked` for every period, run
`node scraper.js --debug` and check the `[debug]` lines for specifics.

**Speed:** two things keep this reasonably fast despite now covering three
meal periods instead of one — the wait times between clicks were trimmed
down to what's actually needed, and any dish seen in an earlier period
(e.g. a Grill item that's on both Lunch and Dinner) reuses its already-known
nutrition instantly instead of repeating the whole Add/read/clear sequence.
The console prints a line like `(42 distinct dishes were fetched; repeats
across periods were reused from cache.)` so you can see how much that's
saving. It's still not instant — with ~50-100 unique dishes across all three
periods, expect somewhere in the range of 1.5-3 minutes total.

If a sync comes back with items but missing calories/macros for some of
them, or 0 items overall, here's how to dig in:

1. In the project folder, run:
   ```bash
   node scraper.js --debug
   ```
   This opens a **visible** Chrome window (instead of running invisibly) and
   prints progress to the terminal per meal period, including lines like:
   ```
   --- Breakfast ---
   [Breakfast] Found 91 elements, 38 look like food items.
   [Breakfast] Captured nutrition for 34 / 38 items.
   ```
   and `[debug]` warnings for any item or step that didn't work as expected.

2. If real dishes are being wrongly filtered out, or a UI button is wrongly
   kept as a "food," open `scraper.js` and adjust the `EXCLUDE_NAME_PATTERNS`
   list near the top.

3. If nutrition data isn't being captured, or meal-period switching isn't
   working, the site may have changed its wording for "Add," "Clear all,"
   "Meal:," or the period names themselves. Search `data/debug-page.html`
   (saved automatically in debug mode) for the current wording and update
   the relevant string in `scraper.js` to match.

You never have to fix the scraper to use the app, though — if a specific
item's nutrition can't be read, the app routes you to **Quick add**
pre-filled with that item's name so you can enter the numbers by hand, and
**Quick add** / **My foods** work regardless of the scraper.

## Editing the app

This is a plain Node/Express + vanilla JS project on purpose, so it's easy
to open in any editor and change:

- `public/style.css` — colors, fonts, layout (currently FSU garnet/gold).
- `public/index.html` / `public/app.js` — the diary UI and its behavior.
- `server.js` — API routes.
- `db.js` — swap out for a real database later if you want (SQLite,
  Postgres, etc.) without touching the frontend, since it's the only file
  that reads/writes data.

## Nutrition data accuracy

Nutrition facts come from whatever the dining hall publishes — the same
numbers you'd see on their site. Always double check anything the app
couldn't parse (shown as "cal unknown") using Quick add and the site itself.

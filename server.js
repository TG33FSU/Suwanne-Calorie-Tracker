// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Express 4 doesn't automatically catch rejected Promises thrown inside
// async route handlers — an uncaught one becomes an unhandled rejection,
// and Node's default behavior since v15 is to crash the whole process on
// those. That's especially risky now that routes talk to MongoDB, which can
// fail for reasons outside our control (bad connection string, a momentary
// network blip, IP not allowlisted in Atlas). This wrapper ensures any
// rejection becomes a normal 500 response instead of taking the entire app
// down for every other user's request too.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Every browser gets its own anonymous, persistent ID (generated and stored
// in localStorage on the frontend) sent as the X-User-Id header on every
// request that touches personal data. This is what actually separates
// Person A's diary from Person B's — not incognito mode, not IP address,
// just this ID. It's intentionally simple (no accounts/passwords) since the
// goal is "everyone gets their own private diary automatically," not real
// authentication.
function requireUserId(req, res, next) {
  const userId = req.headers["x-user-id"];
  if (!userId || typeof userId !== "string" || userId.length < 8 || userId.length > 128) {
    return res.status(400).json({
      error: "Missing or invalid X-User-Id header. The app should generate and send this automatically — try refreshing.",
    });
  }
  req.userId = userId;
  next();
}

// ---------- Menu ----------

// Get the cached menu (whatever was last scraped)
app.get("/api/menu", asyncHandler(async (req, res) => {
  res.json(await db.getMenuCache());
}));

// Retrieve a specific past date's menu (YYYY-MM-DD), if it was ever
// scraped. Not wired into the frontend UI yet — this just makes sure the
// historical data being saved is actually reachable, for whenever a "browse
// past menus" feature is worth adding.
app.get("/api/menu/history/:date", asyncHandler(async (req, res) => {
  const menu = await db.getMenuForDate(req.params.date);
  if (!menu) return res.status(404).json({ error: `No saved menu for ${req.params.date}` });
  res.json(menu);
}));

// Trigger a fresh scrape. A full sync (breakfast/lunch/dinner, ~80-200+
// items) genuinely takes a few minutes — that's real time spent clicking
// into every single item on the actual dining site, not something that can
// be optimized away further. Given that, the right model isn't "make the
// user wait less" (there's a hard floor on that), it's "don't make anyone
// wait at all": this runs automatically on a schedule in the background
// (see startAutoSync below), so by the time someone opens the app, the data
// is already there and loads instantly from the database. The manual
// button still exists for an on-demand refresh, but normal usage never
// needs it.
let scrapeState = { inProgress: false, error: null, startedAt: null, finishedAt: null };

function runScrapeInBackground() {
  if (scrapeState.inProgress) return Promise.resolve();
  scrapeState = { inProgress: true, error: null, startedAt: new Date().toISOString(), finishedAt: null };

  return new Promise((resolve) => {
    // Runs scraper.js as a completely separate OS process instead of
    // calling it in-process. Headless Chrome is heavy on both CPU and
    // memory, and on a constrained free-tier instance that was starving
    // this same Node process of the CPU time it needed to answer other
    // requests — even though nothing had technically crashed, requests
    // could still time out at the proxy. Isolating it in its own process
    // means the server answering HTTP requests never shares an event loop
    // with the scrape, so it stays responsive regardless of how much
    // resource Chrome eats.
    const child = spawn("node", ["scraper.js"], { cwd: __dirname });

    child.stdout.on("data", (d) => process.stdout.write(`[scraper] ${d}`));
    child.stderr.on("data", (d) => process.stderr.write(`[scraper] ${d}`));

    child.on("error", (err) => {
      console.error("Failed to start scraper process:", err);
      scrapeState = {
        inProgress: false,
        error: `Couldn't start the scraper process: ${err.message}`,
        startedAt: scrapeState.startedAt,
        finishedAt: new Date().toISOString(),
      };
      resolve();
    });

    child.on("close", async (code) => {
      if (code !== 0) {
        console.error(`Scraper process exited with code ${code}`);
        scrapeState = {
          inProgress: false,
          error: "Scrape process failed or ran out of resources. You can still add custom foods manually.",
          startedAt: scrapeState.startedAt,
          finishedAt: new Date().toISOString(),
        };
        resolve();
        return;
      }
      try {
        const menuPath = path.join(__dirname, "data", "menu-cache.json");
        const menu = JSON.parse(fs.readFileSync(menuPath, "utf-8"));
        const itemCount = (menu.stations || []).reduce((n, s) => n + (s.items || []).length, 0);

        if (itemCount === 0) {
          // The process exited cleanly (code 0) but came back with nothing —
          // a "soft" failure (e.g. the site's markup didn't match on this
          // run) that a plain exit-code check wouldn't catch. Treat it the
          // same as a hard failure: keep serving whatever was already
          // cached instead of overwriting good data with an empty menu.
          console.error("Scrape completed but found 0 items — keeping the previous cached menu instead of overwriting it.");
          scrapeState = {
            inProgress: false,
            error: "Scrape completed but found no items, so the previous menu was kept.",
            startedAt: scrapeState.startedAt,
            finishedAt: new Date().toISOString(),
          };
          resolve();
          return;
        }

        await db.saveMenuCache(menu);
        // Also keep this specific day's menu around under its own key, so a
        // later scrape (today or any future day) never erases today's data —
        // only ever adds/updates its own date's entry.
        const todayKey = new Date().toISOString().slice(0, 10);
        await db.saveMenuForDate(todayKey, menu);

        scrapeState = { inProgress: false, error: null, startedAt: scrapeState.startedAt, finishedAt: new Date().toISOString() };
      } catch (err) {
        console.error("Scrape finished but its result couldn't be read/saved:", err);
        scrapeState = {
          inProgress: false,
          error: `Scrape finished but the result couldn't be saved: ${err.message}`,
          startedAt: scrapeState.startedAt,
          finishedAt: new Date().toISOString(),
        };
      }
      resolve();
    });
  });
}

// Runs once shortly after the server starts (so a fresh deploy doesn't sit
// with an empty menu until someone happens to click the button), then on a
// repeating timer. Every 3 hours comfortably covers breakfast/lunch/dinner
// transitions through the day without hammering the dining site.
const AUTO_SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;

function startAutoSync() {
  setTimeout(() => {
    console.log("Running automatic background menu sync...");
    runScrapeInBackground();
  }, 15000); // small delay so the server finishes booting first

  setInterval(() => {
    console.log("Running scheduled automatic menu sync...");
    runScrapeInBackground();
  }, AUTO_SYNC_INTERVAL_MS);
}

app.post("/api/menu/refresh", asyncHandler(async (req, res) => {
  if (scrapeState.inProgress) {
    return res.status(409).json({ error: "A scrape is already in progress.", ...scrapeState });
  }
  res.status(202).json({ status: "started" });
  runScrapeInBackground();
}));

app.get("/api/menu/refresh/status", (req, res) => {
  res.json(scrapeState);
});

// ---------- Ratings ("Your Favorites") ----------

app.get("/api/ratings", requireUserId, asyncHandler(async (req, res) => {
  res.json(await db.getRatings(req.userId));
}));

app.post("/api/ratings", requireUserId, asyncHandler(async (req, res) => {
  const { name, stars, tags, calories, protein, totalCarbs, totalFat, servingSize } = req.body;
  const s = Number(stars);
  if (!name || !Number.isFinite(s) || s < 1 || s > 5) {
    return res.status(400).json({ error: "name and stars (1-5) are required" });
  }
  const nutritionSnapshot = {
    calories: Number(calories) || 0,
    protein: Number(protein) || 0,
    totalCarbs: Number(totalCarbs) || 0,
    totalFat: Number(totalFat) || 0,
    servingSize: servingSize || "1 serving",
  };
  const updated = await db.upsertRating(req.userId, name, s, tags || {}, nutritionSnapshot);
  res.status(201).json(updated);
}));

// ---------- Custom foods (user-created, reusable across days) ----------

app.get("/api/custom-foods", requireUserId, asyncHandler(async (req, res) => {
  res.json(await db.getCustomFoods(req.userId));
}));

app.post("/api/custom-foods", requireUserId, asyncHandler(async (req, res) => {
  const { name, calories, protein, totalCarbs, totalFat, servingSize } = req.body;
  if (!name || calories == null) {
    return res.status(400).json({ error: "name and calories are required" });
  }
  const food = {
    id: `custom_${Date.now()}`,
    name,
    calories: Number(calories) || 0,
    protein: Number(protein) || 0,
    totalCarbs: Number(totalCarbs) || 0,
    totalFat: Number(totalFat) || 0,
    servingSize: servingSize || "1 serving",
  };
  await db.addCustomFood(req.userId, food);
  res.status(201).json(food);
}));

app.delete("/api/custom-foods/:id", requireUserId, asyncHandler(async (req, res) => {
  await db.deleteCustomFood(req.userId, req.params.id);
  res.json({ ok: true });
}));

// ---------- Diary ----------

// date format: YYYY-MM-DD
app.get("/api/diary/:date", requireUserId, asyncHandler(async (req, res) => {
  res.json(await db.getDayEntry(req.userId, req.params.date));
}));

app.post("/api/diary/:date/:meal", requireUserId, asyncHandler(async (req, res) => {
  const { date, meal } = req.params;
  const validMeals = ["breakfast", "lunch", "dinner", "snacks"];
  if (!validMeals.includes(meal)) {
    return res.status(400).json({ error: `meal must be one of ${validMeals.join(", ")}` });
  }
  const {
    name,
    calories,
    protein,
    totalCarbs,
    totalFat,
    saturatedFat,
    transFat,
    cholesterol,
    sugars,
    addedSugars,
    fiber,
    sodium,
    servings,
    servingSize,
    source,
  } = req.body;
  if (!name || calories == null) {
    return res.status(400).json({ error: "name and calories are required" });
  }

  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    servings: Number(servings) || 1,
    servingSize: servingSize || "1 serving",
    calories: Number(calories) || 0,
    protein: Number(protein) || 0,
    totalCarbs: Number(totalCarbs) || 0,
    totalFat: Number(totalFat) || 0,
    saturatedFat: Number(saturatedFat) || 0,
    transFat: Number(transFat) || 0,
    cholesterol: Number(cholesterol) || 0,
    sugars: Number(sugars) || 0,
    addedSugars: Number(addedSugars) || 0,
    fiber: Number(fiber) || 0,
    sodium: Number(sodium) || 0,
    source: source || "manual", // "menu" | "custom" | "manual"
    loggedAt: new Date().toISOString(),
  };

  const day = await db.getDayEntry(req.userId, date);
  day[meal].push(entry);
  await db.saveDayEntry(req.userId, date, day);
  res.status(201).json(entry);
}));

app.delete("/api/diary/:date/:meal/:entryId", requireUserId, asyncHandler(async (req, res) => {
  const { date, meal, entryId } = req.params;
  const day = await db.getDayEntry(req.userId, date);
  if (!day[meal]) return res.status(400).json({ error: "invalid meal" });
  day[meal] = day[meal].filter((e) => e.id !== entryId);
  await db.saveDayEntry(req.userId, date, day);
  res.json({ ok: true });
}));

// ---------- Settings (daily goals) ----------

app.get("/api/settings", requireUserId, asyncHandler(async (req, res) => {
  res.json(await db.getSettings(req.userId));
}));

app.post("/api/settings", requireUserId, asyncHandler(async (req, res) => {
  const current = await db.getSettings(req.userId);
  const updated = { ...current, ...req.body };
  await db.saveSettings(req.userId, updated);
  res.json(updated);
}));

const os = require("os");

function getLanUrls(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

// Catches errors passed via next(err) — including anything asyncHandler
// forwards from a rejected route — and returns clean JSON instead of
// Express's default HTML error page, without crashing the process.
app.use((err, req, res, next) => {
  console.error("Request error:", err);
  res.status(500).json({ error: "Something went wrong on the server. Check the server logs for details." });
});

app.listen(PORT, () => {
  console.log(`\nDining Hall Calorie Tracker running at http://localhost:${PORT}`);
  const lanUrls = getLanUrls(PORT);
  if (lanUrls.length > 0) {
    console.log(`\nOn your phone (same WiFi as this computer), open:`);
    lanUrls.forEach((u) => console.log(`  ${u}`));
    console.log("");
  }
  startAutoSync();
});

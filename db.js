// db.js
//
// Two storage backends behind one identical async API, so server.js never
// needs to know or care which one is active:
//
//   - Local JSON files (default). Zero setup — this is what runs when you
//     `npm start` on your own laptop.
//   - MongoDB Atlas (when a MONGODB_URI environment variable is set). This
//     is what you want on a host like Render, whose filesystem is wiped on
//     every redeploy/restart.
//
// USER SCOPING: every function that touches personal data (diary, settings,
// custom foods, ratings) takes a userId as its first argument and only
// ever reads/writes that one user's data. The menu functions have no
// userId — the dining hall menu is shared by everyone.
//
// IMPORTANT: earlier versions of this file saved the diary/custom-foods/
// ratings collections by deleting the ENTIRE collection and re-inserting
// everything on every save. That's fine for a single hardcoded user, but
// the moment a second person uses the app, User A saving their diary would
// silently wipe User B's diary and custom foods too — a real data-loss bug,
// not just a missing-user-id issue. This version replaces that pattern with
// proper single-document upserts scoped to one user (+ date, for diary),
// so saving your own data can never touch anyone else's.

const fs = require("fs");
const path = require("path");

const USE_MONGO = !!process.env.MONGODB_URI;

const DEFAULT_SETTINGS = { calorieGoal: 0, proteinGoal: 0, carbGoal: 0, fatGoal: 0 };
const DEFAULT_MENU = { scrapedAt: null, stations: [] };
const TAG_KEYS = ["wouldEatAgain", "greatProtein", "worthGetting", "skipIt"];

function emptyDay() {
  return { breakfast: [], lunch: [], dinner: [], snacks: [] };
}

// ---------------------------------------------------------------------------
// Backend 1: local JSON files
//
// Kept as single-file-per-collection for simplicity (this path is really
// only exercised during local development on one machine), but every
// function is still properly userId-scoped so behavior matches the Mongo
// backend and nothing here silently mixes users' data either.
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "data");
const MENU_FILE = path.join(DATA_DIR, "menu-cache.json");
const MENU_HISTORY_DIR = path.join(DATA_DIR, "menu-history");
const DIARY_FILE = path.join(DATA_DIR, "diary.json"); // { "userId:date": dayData }
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json"); // { userId: settings }
const CUSTOM_FOODS_FILE = path.join(DATA_DIR, "custom-foods.json"); // { userId: [foods] }
const RATINGS_FILE = path.join(DATA_DIR, "ratings.json"); // { userId: { foodKey: rating } }

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDataDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read ${file}, using fallback.`, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

const fileBackend = {
  async getSettings(userId) {
    const all = readJson(SETTINGS_FILE, {});
    return { ...DEFAULT_SETTINGS, ...(all[userId] || {}) };
  },
  async saveSettings(userId, settings) {
    const all = readJson(SETTINGS_FILE, {});
    all[userId] = settings;
    writeJson(SETTINGS_FILE, all);
  },

  async getMenuCache() {
    return readJson(MENU_FILE, DEFAULT_MENU);
  },
  async saveMenuCache(menu) {
    writeJson(MENU_FILE, menu);
  },
  async saveMenuForDate(date, menu) {
    if (!fs.existsSync(MENU_HISTORY_DIR)) fs.mkdirSync(MENU_HISTORY_DIR, { recursive: true });
    writeJson(path.join(MENU_HISTORY_DIR, `${date}.json`), menu);
  },
  async getMenuForDate(date) {
    return readJson(path.join(MENU_HISTORY_DIR, `${date}.json`), null);
  },

  async getCustomFoods(userId) {
    const all = readJson(CUSTOM_FOODS_FILE, {});
    return all[userId] || [];
  },
  async addCustomFood(userId, food) {
    const all = readJson(CUSTOM_FOODS_FILE, {});
    if (!all[userId]) all[userId] = [];
    all[userId].push(food);
    writeJson(CUSTOM_FOODS_FILE, all);
    return food;
  },
  async deleteCustomFood(userId, foodId) {
    const all = readJson(CUSTOM_FOODS_FILE, {});
    if (!all[userId]) return;
    all[userId] = all[userId].filter((f) => f.id !== foodId);
    writeJson(CUSTOM_FOODS_FILE, all);
  },

  async getRatings(userId) {
    const all = readJson(RATINGS_FILE, {});
    return all[userId] || {};
  },
  async saveRatingsForUser(userId, ratings) {
    const all = readJson(RATINGS_FILE, {});
    all[userId] = ratings;
    writeJson(RATINGS_FILE, all);
  },

  async getDayEntry(userId, date) {
    const all = readJson(DIARY_FILE, {});
    return all[`${userId}:${date}`] || emptyDay();
  },
  async saveDayEntry(userId, date, dayData) {
    const all = readJson(DIARY_FILE, {});
    all[`${userId}:${date}`] = dayData;
    writeJson(DIARY_FILE, all);
  },
};

// ---------------------------------------------------------------------------
// Backend 2: MongoDB Atlas
// ---------------------------------------------------------------------------

let mongoDbPromise = null;
function getMongoDb() {
  if (!mongoDbPromise) {
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
    });
    mongoDbPromise = client
      .connect()
      .then((c) => {
        console.log("Connected to MongoDB Atlas.");
        return c.db("dininghall_tracker");
      })
      .catch((err) => {
        console.error("MongoDB connection failed:", err.message);
        mongoDbPromise = null; // allow a retry on the next call instead of caching a dead connection
        throw err;
      });
  }
  return mongoDbPromise;
}

const mongoBackend = {
  // Settings: one document per user, _id = userId.
  async getSettings(userId) {
    const db = await getMongoDb();
    const doc = await db.collection("settings").findOne({ _id: userId });
    return doc ? { ...DEFAULT_SETTINGS, ...doc, _id: undefined } : DEFAULT_SETTINGS;
  },
  async saveSettings(userId, settings) {
    const db = await getMongoDb();
    await db.collection("settings").replaceOne({ _id: userId }, { _id: userId, ...settings }, { upsert: true });
  },

  // Menu: shared globally, no userId — everyone sees the same dining hall menu.
  async getMenuCache() {
    const db = await getMongoDb();
    const doc = await db.collection("menu_cache").findOne({ _id: "singleton" });
    return doc ? { ...doc, _id: undefined } : DEFAULT_MENU;
  },
  async saveMenuCache(menu) {
    const db = await getMongoDb();
    await db.collection("menu_cache").replaceOne({ _id: "singleton" }, { _id: "singleton", ...menu }, { upsert: true });
  },
  async saveMenuForDate(date, menu) {
    const db = await getMongoDb();
    await db.collection("menu_history").replaceOne({ _id: date }, { _id: date, ...menu }, { upsert: true });
  },
  async getMenuForDate(date) {
    const db = await getMongoDb();
    const doc = await db.collection("menu_history").findOne({ _id: date });
    return doc ? { ...doc, _id: undefined } : null;
  },

  // Custom foods: one document per food, tagged with userId. Adding/deleting
  // touches exactly one document — never the whole collection — so it can
  // never affect another user's foods.
  async getCustomFoods(userId) {
    const db = await getMongoDb();
    const docs = await db.collection("custom_foods").find({ userId }).toArray();
    return docs.map((d) => ({ ...d, _id: undefined }));
  },
  async addCustomFood(userId, food) {
    const db = await getMongoDb();
    await db.collection("custom_foods").insertOne({ _id: food.id, userId, ...food });
    return food;
  },
  async deleteCustomFood(userId, foodId) {
    const db = await getMongoDb();
    // Scoped to both the id AND the userId, so a user can only ever delete
    // their own food even if they somehow guessed another user's food id.
    await db.collection("custom_foods").deleteOne({ _id: foodId, userId });
  },

  // Ratings: one document per (user, food), _id = "userId:foodKey".
  async getRatings(userId) {
    const db = await getMongoDb();
    const docs = await db.collection("ratings").find({ userId }).toArray();
    const ratings = {};
    docs.forEach((d) => {
      ratings[d.foodKey] = { ...d, _id: undefined, userId: undefined, foodKey: undefined };
    });
    return ratings;
  },
  async saveRatingsForUser(userId, ratings) {
    // Only used internally by upsertRating below, which already knows
    // exactly which single food changed — so this replaces just that one
    // document, not the user's whole rating history, and never touches
    // other users' documents at all.
    const db = await getMongoDb();
    const col = db.collection("ratings");
    const entries = Object.entries(ratings);
    await Promise.all(
      entries.map(([foodKey, value]) =>
        col.replaceOne({ _id: `${userId}:${foodKey}` }, { _id: `${userId}:${foodKey}`, userId, foodKey, ...value }, { upsert: true })
      )
    );
  },

  // Diary: one document per (user, date), _id = "userId:date". Saving one
  // day's entries only ever upserts that single document.
  async getDayEntry(userId, date) {
    const db = await getMongoDb();
    const doc = await db.collection("diary").findOne({ _id: `${userId}:${date}` });
    return doc ? { ...emptyDay(), ...doc, _id: undefined, userId: undefined, date: undefined } : emptyDay();
  },
  async saveDayEntry(userId, date, dayData) {
    const db = await getMongoDb();
    await db
      .collection("diary")
      .replaceOne({ _id: `${userId}:${date}` }, { _id: `${userId}:${date}`, userId, date, ...dayData }, { upsert: true });
  },
};

const backend = USE_MONGO ? mongoBackend : fileBackend;
if (USE_MONGO) {
  console.log("Storage backend: MongoDB Atlas (MONGODB_URI is set).");
} else {
  console.log("Storage backend: local JSON files in data/ (no MONGODB_URI set).");
}

// ---------------------------------------------------------------------------
// Public API — identical regardless of backend
// ---------------------------------------------------------------------------

async function getSettings(userId) {
  return backend.getSettings(userId);
}
async function saveSettings(userId, settings) {
  return backend.saveSettings(userId, settings);
}

async function getMenuCache() {
  return backend.getMenuCache();
}
async function saveMenuCache(menu) {
  return backend.saveMenuCache(menu);
}
async function saveMenuForDate(date, menu) {
  return backend.saveMenuForDate(date, menu);
}
async function getMenuForDate(date) {
  return backend.getMenuForDate(date);
}

async function getCustomFoods(userId) {
  return backend.getCustomFoods(userId);
}
async function addCustomFood(userId, food) {
  return backend.addCustomFood(userId, food);
}
async function deleteCustomFood(userId, foodId) {
  return backend.deleteCustomFood(userId, foodId);
}

async function getRatings(userId) {
  return backend.getRatings(userId);
}

async function upsertRating(userId, name, stars, tags, nutritionSnapshot) {
  const ratings = await getRatings(userId);
  const key = name.trim().toLowerCase();
  const existing = ratings[key] || {
    name: name.trim(),
    avgStars: 0,
    ratingCount: 0,
    tags: { wouldEatAgain: 0, greatProtein: 0, worthGetting: 0, skipIt: 0 },
    lastNutrition: {},
  };

  const newCount = existing.ratingCount + 1;
  const newAvg = (existing.avgStars * existing.ratingCount + stars) / newCount;

  const updatedTags = { ...existing.tags };
  TAG_KEYS.forEach((t) => {
    if (tags && tags[t]) updatedTags[t] = (updatedTags[t] || 0) + 1;
  });

  const updated = {
    name: name.trim(),
    avgStars: newAvg,
    ratingCount: newCount,
    tags: updatedTags,
    lastNutrition: nutritionSnapshot || existing.lastNutrition,
  };

  // Only this one food's rating document gets written — not the user's
  // whole ratings collection, and never another user's data.
  await backend.saveRatingsForUser(userId, { [key]: updated });
  return updated;
}

async function getDayEntry(userId, date) {
  return backend.getDayEntry(userId, date);
}
async function saveDayEntry(userId, date, dayData) {
  return backend.saveDayEntry(userId, date, dayData);
}

module.exports = {
  getMenuCache,
  saveMenuCache,
  saveMenuForDate,
  getMenuForDate,
  getCustomFoods,
  addCustomFood,
  deleteCustomFood,
  getRatings,
  upsertRating,
  getDayEntry,
  saveDayEntry,
  getSettings,
  saveSettings,
};

// app.js — all client-side logic for the tracker. No build step, no framework:
// plain fetch() calls to the Express API in server.js.

// ---------------- Anonymous per-browser user ID ----------------
//
// This is what actually separates one person's diary from another's — not
// incognito mode, not IP address. The first time this app runs in a given
// browser, it generates a random ID and stores it in localStorage; every
// API request that touches personal data sends it as the X-User-Id header.
// Same browser later = same ID = same diary. A different browser, a
// different device, or clearing site data = a new ID = a fresh, separate
// diary — which is exactly the isolation being asked for, achieved without
// any accounts or passwords.
const USER_ID_KEY = "suwanneeTrackerUserId";

function getOrCreateUserId() {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

const userId = getOrCreateUserId();

const state = {
  date: todayStr(),
  settings: { calorieGoal: 2200, proteinGoal: 130, carbGoal: 250, fatGoal: 70 },
  day: { breakfast: [], lunch: [], dinner: [], snacks: [] },
  menu: { stations: [] },
  customFoods: [],
  ratings: {},
  pendingMeal: null, // which meal the "add food" dialog is currently targeting
  pendingFood: null, // the food selected in the serving-picker step
};

function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

// ---------------- API helpers ----------------

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", "X-User-Id": userId },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function renderFavorites() {
  const panel = document.getElementById("favoritesPanel");
  const list = document.getElementById("favoritesList");
  const ranked = Object.values(state.ratings)
    .filter((r) => r.ratingCount > 0)
    .sort((a, b) => b.avgStars - a.avgStars || b.ratingCount - a.ratingCount)
    .slice(0, 6);

  if (ranked.length === 0) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const medals = ["🥇", "🥈", "🥉"];
  list.innerHTML = ranked
    .map((r, i) => {
      const n = r.lastNutrition || {};
      const stars = "★".repeat(Math.round(r.avgStars)) + "☆".repeat(5 - Math.round(r.avgStars));
      const tagBits = [];
      if (r.tags?.wouldEatAgain) tagBits.push(`🔥 ${r.tags.wouldEatAgain}`);
      if (r.tags?.greatProtein) tagBits.push(`💪 ${r.tags.greatProtein}`);
      if (r.tags?.worthGetting) tagBits.push(`💰 ${r.tags.worthGetting}`);
      if (r.tags?.skipIt) tagBits.push(`👎 ${r.tags.skipIt}`);
      return `
        <div class="favorite-card">
          <div class="fav-rank">${medals[i] || "⭐"}</div>
          <p class="fav-name">${escapeHtml(r.name)}</p>
          <div><span class="fav-stars">${stars}</span><span class="fav-count">${r.ratingCount} rating${r.ratingCount === 1 ? "" : "s"}</span></div>
          <div class="fav-macros">${n.calories ?? "?"} cal · ${n.protein ?? "?"}g protein${tagBits.length ? " · " + tagBits.join(" ") : ""}</div>
          <div class="fav-add-row">
            <select class="fav-meal-select" data-fav="${escapeHtml(r.name)}">
              <option value="breakfast">Breakfast</option>
              <option value="lunch">Lunch</option>
              <option value="dinner">Dinner</option>
              <option value="snacks" selected>Snacks</option>
            </select>
            <button class="fav-add-btn" data-fav-add="${escapeHtml(r.name)}">Add</button>
          </div>
        </div>`;
    })
    .join("");

  list.querySelectorAll(".fav-add-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.favAdd;
      const rating = ranked.find((r) => r.name === name);
      const select = list.querySelector(`.fav-meal-select[data-fav="${CSS.escape(name)}"]`);
      const meal = select.value;
      const n = rating.lastNutrition || {};
      await api(`/api/diary/${state.date}/${meal}`, {
        method: "POST",
        body: JSON.stringify({ ...n, name, servings: 1, source: "favorite" }),
      });
      state.day = await api(`/api/diary/${state.date}`);
      renderDiary();
      renderSummary();
      btn.textContent = "Added!";
      setTimeout(() => (btn.textContent = "Add"), 1200);
    });
  });
}

// ---------------- Load & render ----------------

async function loadAll() {
  const [day, settings, menu, customFoods, ratings] = await Promise.all([
    api(`/api/diary/${state.date}`),
    api("/api/settings"),
    api("/api/menu"),
    api("/api/custom-foods"),
    api("/api/ratings"),
  ]);
  state.day = day;
  state.settings = settings;
  state.menu = menu;
  state.customFoods = customFoods;
  state.ratings = ratings;
  render();
}

function render() {
  document.getElementById("datePicker").value = state.date;
  renderDiary();
  renderSummary();
  renderSyncStatus();
  renderFavorites();
  renderMenuPreview();
  renderInsight();
}

function renderDiary() {
  ["breakfast", "lunch", "dinner", "snacks"].forEach((meal) => {
    const list = document.querySelector(`[data-list="${meal}"]`);
    const entries = state.day[meal] || [];
    list.innerHTML = "";

    if (entries.length === 0) {
      const li = document.createElement("li");
      li.className = "empty-meal";
      li.textContent = "No food logged yet.";
      list.appendChild(li);
    } else {
      entries.forEach((e) => list.appendChild(renderEntry(meal, e)));
    }

    const total = entries.reduce((sum, e) => sum + e.calories * e.servings, 0);
    document.querySelector(`[data-total="${meal}"]`).textContent = `${Math.round(total)} cal`;
  });
}

function renderEntry(meal, entry) {
  const li = document.createElement("li");
  li.className = "entry-item";
  const cals = Math.round(entry.calories * entry.servings);
  const s = entry.servings;
  li.innerHTML = `
    <div class="entry-row">
      <button class="entry-expand" title="Nutrition facts">▸</button>
      <span class="entry-name">${escapeHtml(entry.name)}</span>
      <span class="entry-meta">${entry.servings}× ${escapeHtml(entry.servingSize || "")}</span>
      <span class="entry-cal">${cals} cal</span>
      <button class="remove-entry" title="Remove">&times;</button>
    </div>
    <div class="nutrition-facts hidden">
      ${nutritionFactsRows(entry, s)}
      ${ratingWidgetHtml(entry)}
    </div>
  `;

  li.querySelector(".entry-expand").addEventListener("click", (e) => {
    const panel = li.querySelector(".nutrition-facts");
    const collapsed = panel.classList.toggle("hidden");
    e.target.textContent = collapsed ? "▸" : "▾";
  });

  li.querySelector(".remove-entry").addEventListener("click", async () => {
    await api(`/api/diary/${state.date}/${meal}/${entry.id}`, { method: "DELETE" });
    state.day[meal] = state.day[meal].filter((e) => e.id !== entry.id);
    renderDiary();
    renderSummary();
  });

  wireRatingWidget(li, entry);
  return li;
}

function ratingWidgetHtml(entry) {
  return `
    <div class="rate-widget">
      <p class="rate-label">How was it?</p>
      <div class="star-picker" data-stars="0">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star-btn" data-star="${n}">★</button>`).join("")}
      </div>
      <div class="tag-chips">
        <button type="button" class="tag-chip" data-tag="wouldEatAgain">🔥 Would eat again</button>
        <button type="button" class="tag-chip" data-tag="greatProtein">💪 Great for protein</button>
        <button type="button" class="tag-chip" data-tag="worthGetting">💰 Worth getting</button>
        <button type="button" class="tag-chip" data-tag="skipIt">👎 Skip it</button>
      </div>
      <button type="button" class="save-rating-btn">Save rating</button>
    </div>
  `;
}

function wireRatingWidget(li, entry) {
  const picker = li.querySelector(".star-picker");
  const stars = Array.from(li.querySelectorAll(".star-btn"));
  const tagChips = Array.from(li.querySelectorAll(".tag-chip"));
  const saveBtn = li.querySelector(".save-rating-btn");

  stars.forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = Number(btn.dataset.star);
      picker.dataset.stars = val;
      stars.forEach((s) => s.classList.toggle("filled", Number(s.dataset.star) <= val));
    });
  });

  tagChips.forEach((chip) => {
    chip.addEventListener("click", () => chip.classList.toggle("active"));
  });

  saveBtn.addEventListener("click", async () => {
    const starsVal = Number(picker.dataset.stars);
    if (!starsVal) {
      saveBtn.textContent = "Pick stars first";
      setTimeout(() => (saveBtn.textContent = "Save rating"), 1500);
      return;
    }
    const tags = {};
    tagChips.forEach((chip) => {
      if (chip.classList.contains("active")) tags[chip.dataset.tag] = true;
    });

    await api("/api/ratings", {
      method: "POST",
      body: JSON.stringify({
        name: entry.name,
        stars: starsVal,
        tags,
        calories: entry.calories,
        protein: entry.protein,
        totalCarbs: entry.totalCarbs,
        totalFat: entry.totalFat,
        servingSize: entry.servingSize,
      }),
    });

    state.ratings = await api("/api/ratings");
    renderFavorites();
    saveBtn.textContent = "Saved!";
    setTimeout(() => (saveBtn.textContent = "Save rating"), 1500);
  });
}

function nutritionFactsRows(entry, s) {
  const row = (label, value, unit, indent) => `
    <div class="fact-row ${indent ? "fact-indent" : ""}">
      <span>${label}</span><span>${Math.round((value || 0) * s * 10) / 10}${unit}</span>
    </div>`;
  return [
    row("Total Fat", entry.totalFat, "g", false),
    row("Saturated Fat", entry.saturatedFat, "g", true),
    row("Trans Fat", entry.transFat, "g", true),
    row("Cholesterol", entry.cholesterol, "mg", false),
    row("Sodium", entry.sodium, "mg", false),
    row("Total Carbohydrates", entry.totalCarbs, "g", false),
    row("Dietary Fiber", entry.fiber, "g", true),
    row("Total Sugars", entry.sugars, "g", true),
    row("Added Sugars", entry.addedSugars, "g", true),
    row("Protein", entry.protein, "g", false),
  ].join("");
}

function renderSummary() {
  const all = [...state.day.breakfast, ...state.day.lunch, ...state.day.dinner, ...state.day.snacks];
  const totals = all.reduce(
    (acc, e) => {
      acc.calories += e.calories * e.servings;
      acc.protein += e.protein * e.servings;
      acc.carbs += e.totalCarbs * e.servings;
      acc.fat += e.totalFat * e.servings;
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  const goal = state.settings;
  const valueEl = document.getElementById("caloriesRemaining");
  const goalEl = document.getElementById("calorieGoalDisplay");
  const labelEl = document.getElementById("ringLabel");

  if (goal.calorieGoal > 0) {
    valueEl.textContent = Math.round(totals.calories).toLocaleString();
    goalEl.textContent = `/ ${Math.round(goal.calorieGoal).toLocaleString()}`;
    labelEl.textContent =
      totals.calories > goal.calorieGoal
        ? `${Math.round(totals.calories - goal.calorieGoal).toLocaleString()} over goal`
        : `${Math.round(goal.calorieGoal - totals.calories).toLocaleString()} calories left today`;
  } else {
    // No goal set yet — show what's been logged, no fake target.
    valueEl.textContent = Math.round(totals.calories).toLocaleString();
    goalEl.textContent = "";
    labelEl.textContent = "logged today — set a goal via ⚙";
  }

  setMacro("protein", totals.protein, goal.proteinGoal);
  setMacro("carbs", totals.carbs, goal.carbGoal);
  setMacro("fat", totals.fat, goal.fatGoal);
}

function setMacro(key, value, goal) {
  const pct = goal > 0 ? Math.min(100, (value / goal) * 100) : 0;
  document.getElementById(`${key}Fill`).style.width = `${pct}%`;
  const valueText = goal > 0 ? `${Math.round(value)} / ${Math.round(goal)}g` : `${Math.round(value)}g`;
  document.getElementById(`${key}Value`).textContent = valueText;
}

function renderSyncStatus() {
  const el = document.getElementById("syncStatus");
  if (!state.menu.scrapedAt) {
    el.textContent = "Today's menu hasn't been synced yet";
    return;
  }
  const itemCount = state.menu.stations.reduce((n, s) => n + s.items.length, 0);
  const when = new Date(state.menu.scrapedAt).toLocaleString([], { hour: "numeric", minute: "2-digit" });
  el.textContent = `✓ Menu synced at ${when} · ${itemCount} foods available` + (state.menu.warning ? ` · ${state.menu.warning}` : "");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- Date navigation ----------------

document.getElementById("datePicker").addEventListener("change", (e) => {
  state.date = e.target.value;
  loadAll();
});
document.getElementById("prevDay").addEventListener("click", () => shiftDate(-1));
document.getElementById("nextDay").addEventListener("click", () => shiftDate(1));
document.getElementById("todayBtn").addEventListener("click", () => {
  state.date = todayStr();
  loadAll();
});
function shiftDate(delta) {
  const d = new Date(state.date + "T00:00:00");
  d.setDate(d.getDate() + delta);
  state.date = d.toISOString().slice(0, 10);
  loadAll();
}

// ---------------- Sync menu ----------------

document.getElementById("syncMenu").addEventListener("click", async () => {
  const btn = document.getElementById("syncMenu");
  const label = document.getElementById("syncLabel");
  const statusEl = document.getElementById("syncStatus");
  btn.disabled = true;

  try {
    // Kick the scrape off — this returns almost instantly now; the actual
    // scraping happens in the background on the server so we don't hold
    // open one long request (which is what was causing the 502 — Render's
    // proxy kills requests that stay open for minutes, even though the
    // scrape itself was still working fine).
    const started = await api("/api/menu/refresh", { method: "POST" });
    if (started.error && !started.status) {
      throw new Error(started.error);
    }
  } catch (err) {
    // A 409 here just means one's already running — that's fine, fall
    // through to polling instead of treating it as a failure.
    if (!/already in progress/i.test(err.message)) {
      statusEl.textContent = `Sync failed: ${err.message}`;
      btn.disabled = false;
      return;
    }
  }

  let elapsed = 0;
  label.textContent = "Syncing…";
  const poll = setInterval(async () => {
    elapsed += 3;
    try {
      const status = await api("/api/menu/refresh/status");
      label.textContent = `Syncing… ${elapsed}s`;
      if (!status.inProgress) {
        clearInterval(poll);
        btn.disabled = false;
        label.textContent = "Sync today's menu";
        if (status.error) {
          statusEl.textContent = `Sync failed: ${status.error}`;
        } else {
          state.menu = await api("/api/menu");
          renderSyncStatus();
          renderMenuPreview();
        }
      }
    } catch (err) {
      clearInterval(poll);
      btn.disabled = false;
      label.textContent = "Sync today's menu";
      statusEl.textContent = `Lost track of sync progress: ${err.message}`;
    }
  }, 3000);
});

// ---------------- Add food dialog ----------------

const addFoodDialog = document.getElementById("addFoodDialog");

document.querySelectorAll("[data-meal-add]").forEach((btn) => {
  btn.addEventListener("click", () => openAddFood(btn.dataset.mealAdd));
});

function openAddFood(meal) {
  state.pendingMeal = meal;
  document.getElementById("dialogMealName").textContent = meal;
  document.getElementById("manualHint").textContent = "";
  document.getElementById("manualForm").reset();
  showDialogError("");
  switchTab("menu");
  renderMenuResults("");
  renderCustomResults();
  addFoodDialog.showModal();
}

document.getElementById("closeDialog").addEventListener("click", () => addFoodDialog.close());

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
}

// --- Menu search tab ---

document.getElementById("menuSearch").addEventListener("input", (e) => renderMenuResults(e.target.value));

function allMenuItems() {
  return state.menu.stations.flatMap((s) => s.items.map((i) => ({ ...i, station: s.name })));
}

// Used when someone adds a food from the menu preview or "your favorites"
// row, where there's no explicit meal card they clicked "+ Add food" on —
// picks a reasonable default meal based on the time of day.
function inferMealByTime() {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 16) return "lunch";
  if (h < 21) return "dinner";
  return "snacks";
}

// "Today at Suwannee" — a lightweight preview of synced menu items with a
// one-click path into the same add-food flow, so people don't have to open
// the full dialog just to see what's available today.
function renderMenuPreview() {
  const card = document.getElementById("menuPreviewCard");
  const list = document.getElementById("menuPreviewList");
  const items = allMenuItems();

  if (items.length === 0) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const preview = items.slice(0, 6);
  list.innerHTML =
    preview
      .map(
        (item) => `
        <div class="preview-item" data-preview-name="${escapeHtml(item.name)}">
          <span class="preview-name">${escapeHtml(item.name)}</span>
          <span class="preview-cal">${item.calories != null ? item.calories + " cal" : "—"}</span>
        </div>`
      )
      .join("") + `<button class="preview-viewall" id="viewFullMenuBtn">View full menu →</button>`;

  list.querySelectorAll(".preview-item").forEach((el) => {
    el.addEventListener("click", () => {
      const item = items.find((i) => i.name === el.dataset.previewName);
      if (item) openQuickAddFromPreview(item);
    });
  });

  document.getElementById("viewFullMenuBtn").addEventListener("click", () => openAddFood(inferMealByTime()));
}

function openQuickAddFromPreview(item) {
  state.pendingMeal = inferMealByTime();
  document.getElementById("dialogMealName").textContent = state.pendingMeal;
  showDialogError("");
  openServingPicker(item, "menu");
  addFoodDialog.showModal();
}

// A small deterministic (no AI) nudge based on today's actual logged
// nutrition vs goals, plus whatever's in the synced menu — not shown at all
// if there's nothing meaningful to say yet (no meals logged, or no protein
// goal set).
function renderInsight() {
  const card = document.getElementById("insightCard");
  const textEl = document.getElementById("insightText");
  const goal = state.settings;
  const all = [...state.day.breakfast, ...state.day.lunch, ...state.day.dinner, ...state.day.snacks];

  if (all.length === 0 || !(goal.proteinGoal > 0)) {
    card.classList.add("hidden");
    return;
  }

  const proteinConsumed = all.reduce((sum, e) => sum + (e.protein || 0) * e.servings, 0);
  const remaining = goal.proteinGoal - proteinConsumed;
  card.classList.remove("hidden");

  if (remaining <= 0) {
    textEl.textContent = "You've hit your protein goal for today — nice work.";
    return;
  }

  const candidates = allMenuItems().filter((i) => i.protein != null && i.calories != null);
  let suggestion = "";
  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) => (b.protein > a.protein ? b : a));
    suggestion = ` Suwannee has ${escapeHtml(best.name)} today with ${best.protein}g protein.`;
  }
  textEl.textContent = `You're ${Math.round(remaining)}g short of your protein goal.${suggestion}`;
}

function renderMenuResults(query) {
  const list = document.getElementById("menuResults");
  list.innerHTML = "";
  const q = query.trim().toLowerCase();
  const items = allMenuItems().filter((i) => !q || i.name.toLowerCase().includes(q));

  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "hint";
    li.style.cursor = "default";
    li.textContent = state.menu.stations.length === 0
      ? "No menu synced yet. Click \"Sync Suwannee Room menu\" or use Quick add."
      : "No matches. Try Quick add to log it manually.";
    list.appendChild(li);
    return;
  }

  items.slice(0, 60).forEach((item) => {
    const li = document.createElement("li");
    const cal = item.calories != null ? `${item.calories} cal` : "cal unknown";
    li.innerHTML = `<span class="fname">${escapeHtml(item.name)}</span><span class="fmeta">${cal} · ${escapeHtml(item.station)}</span>`;
    li.addEventListener("click", () => openServingPicker(item, "menu"));
    list.appendChild(li);
  });
}

// --- My foods tab ---

function renderCustomResults() {
  const list = document.getElementById("customResults");
  list.innerHTML = "";
  if (state.customFoods.length === 0) {
    const li = document.createElement("li");
    li.className = "hint";
    li.style.cursor = "default";
    li.textContent = "Nothing saved yet. Foods you quick-add will show up here.";
    list.appendChild(li);
    return;
  }
  state.customFoods.forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="fname">${escapeHtml(item.name)}</span><span class="fmeta">${item.calories} cal</span>`;
    li.addEventListener("click", () => openServingPicker(item, "custom"));
    list.appendChild(li);
  });
}

// --- Quick add (manual) tab ---

document.getElementById("manualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showDialogError("");
  const fd = new FormData(e.target);
  const food = {
    name: fd.get("name"),
    calories: Number(fd.get("calories")) || 0,
    protein: Number(fd.get("protein")) || 0,
    totalCarbs: Number(fd.get("totalCarbs")) || 0,
    totalFat: Number(fd.get("totalFat")) || 0,
    servingSize: fd.get("servingSize") || "1 serving",
  };

  try {
    if (fd.get("save")) {
      const saved = await api("/api/custom-foods", { method: "POST", body: JSON.stringify(food) });
      state.customFoods.push(saved);
    }
  } catch (err) {
    showDialogError(`Couldn't save to My foods (adding to diary anyway): ${err.message}`);
  }

  const ok = await logEntry({ ...food, servings: 1, source: "manual" });
  if (ok) {
    e.target.reset();
    document.getElementById("manualHint").textContent = "";
    addFoodDialog.close();
  }
});

// --- Serving picker step ---

function openServingPicker(item, source) {
  // If we couldn't parse nutrition data for this item (the sync's nutrition
  // panel step failed for it), don't let the user add a fake "0 calorie"
  // entry — send them to Quick add instead, pre-filled with the name, so
  // they can type in the real numbers (e.g. from the label at the station).
  if (item.calories == null) {
    switchTab("manual");
    const form = document.getElementById("manualForm");
    form.name.value = item.name;
    form.servingSize.value = item.servingSize || "";
    document.getElementById("manualHint").textContent =
      `We synced "${item.name}" but couldn't read its nutrition facts. Enter them here (check the label at the station, or the item on the dining site).`;
    return;
  }

  state.pendingFood = { ...item, source };
  document.getElementById("servingFoodName").textContent = item.name;
  document.getElementById("servingBase").textContent =
    `${item.calories ?? "?"} cal per ${item.servingSize || "serving"}` + (item.station ? ` · ${item.station}` : "");
  document.getElementById("servingCount").value = 1;
  updateServingPreview();
  switchTab("serving");
}

document.getElementById("servingCount").addEventListener("input", updateServingPreview);

function updateServingPreview() {
  const servings = Number(document.getElementById("servingCount").value) || 0;
  const food = state.pendingFood;
  const preview = document.getElementById("servingPreview");
  if (!food) return;
  const n = (v) => Math.round((v || 0) * servings * 10) / 10;
  preview.innerHTML = `
    <div class="preview-headline"><span>${n(food.calories)} cal</span><span>${n(food.protein)}g protein</span><span>${n(food.totalCarbs)}g carbs</span><span>${n(food.totalFat)}g fat</span></div>
    <div class="preview-detail">
      <span>Sat fat ${n(food.saturatedFat)}g</span>
      <span>Trans fat ${n(food.transFat)}g</span>
      <span>Cholesterol ${n(food.cholesterol)}mg</span>
      <span>Sodium ${n(food.sodium)}mg</span>
      <span>Fiber ${n(food.fiber)}g</span>
      <span>Sugars ${n(food.sugars)}g</span>
      <span>Added sugars ${n(food.addedSugars)}g</span>
    </div>
  `;
}

document.getElementById("confirmAdd").addEventListener("click", async () => {
  const servings = Number(document.getElementById("servingCount").value) || 1;
  const food = state.pendingFood;
  const ok = await logEntry({ ...food, servings, source: food.source });
  if (ok) addFoodDialog.close();
});

function showDialogError(message) {
  const el = document.getElementById("dialogError");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

async function logEntry(food) {
  showDialogError("");
  try {
    const entry = await api(`/api/diary/${state.date}/${state.pendingMeal}`, {
      method: "POST",
      body: JSON.stringify(food),
    });
    state.day[state.pendingMeal].push(entry);
    renderDiary();
    renderSummary();
    return true;
  } catch (err) {
    showDialogError(`Couldn't add that food: ${err.message}`);
    return false;
  }
}

// ---------------- Goals dialog ----------------

const goalsDialog = document.getElementById("goalsDialog");

document.getElementById("editGoals").addEventListener("click", () => {
  const form = document.getElementById("goalsForm");
  form.calorieGoal.value = state.settings.calorieGoal;
  form.proteinGoal.value = state.settings.proteinGoal;
  form.carbGoal.value = state.settings.carbGoal;
  form.fatGoal.value = state.settings.fatGoal;
  goalsDialog.showModal();
});
document.getElementById("closeGoals").addEventListener("click", () => goalsDialog.close());

document.getElementById("goalsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const updated = {
    calorieGoal: Number(fd.get("calorieGoal")),
    proteinGoal: Number(fd.get("proteinGoal")),
    carbGoal: Number(fd.get("carbGoal")),
    fatGoal: Number(fd.get("fatGoal")),
  };
  state.settings = await api("/api/settings", { method: "POST", body: JSON.stringify(updated) });
  renderSummary();
  goalsDialog.close();
});

// ---------------- Init ----------------

loadAll().catch((err) => {
  console.error(err);
  document.getElementById("syncStatus").textContent = `Failed to load app data: ${err.message}`;
});

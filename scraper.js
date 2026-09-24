// scraper.js
//
// Scrapes today's menu + nutrition facts from the Suwannee Room page on
// Seminole Dining's site (a JS-rendered site, so we drive a real headless
// browser rather than fetching raw HTML).
//
// IMPORTANT / READ ME:
// I built this against the page's public structure, but I could not run a
// live browser against seminoledining.mydininghub.com from my own sandbox to
// verify exact CSS class names (my dev environment's network is locked down
// to package registries only). So this scraper is written defensively: it
// tries several common selector patterns and falls back gracefully, and it
// dumps debug info to help you fix things quickly if the site's markup
// doesn't match what it expects.
//
// HOW TO FIX IT IF SCRAPING RETURNS 0 ITEMS OR BAD NUTRITION DATA:
//   1. Run:  node scraper.js --debug
//      This opens a *visible* (non-headless) browser window and prints
//      candidate selectors + counts to the console, and saves
//      data/debug-page.html (the fully rendered HTML) for inspection.
//   2. Open data/debug-page.html in a normal browser, or use Chrome DevTools
//      on the live site (right-click a menu item -> Inspect) to find the
//      real class names / structure.
//   3. Update the SELECTORS object below to match what you find.
//
// The rest of the app (manual "Add Custom Food") works completely
// independently of this scraper, so you can always log meals by hand even
// if the site changes and this needs a tune-up.

const fs = require("fs");
let puppeteer;
try {
  puppeteer = require("puppeteer");
} catch {
  puppeteer = require("puppeteer-core");
}

function findLocalChrome() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ];
  return candidates.find((p) => fs.existsSync(p));
}
const path = require("path");

const MENU_URL = "https://seminoledining.mydininghub.com/en/location/suwannee-room";

// ---------------------------------------------------------------------------
// SELECTORS: the most likely thing you'll need to edit if the site changes
// its markup. Each is a list of candidates tried in order; first match wins.
// ---------------------------------------------------------------------------
const SELECTORS = {
  // A station/category heading (e.g. "Grill", "Pizza", "Global Solutions")
  stationHeading: ['h2', 'h3', '[class*="station"]', '[class*="category"]'],

  // A clickable menu item card/row/button
  menuItem: [
    '[class*="menu-item"]',
    '[class*="MenuItem"]',
    '[data-testid*="menu-item"]',
    'button[class*="item"]',
    'li[class*="item"]',
    '[class*="product-card"]',
    '[class*="dish"]',
  ],

  // The nutrition modal/panel that opens after clicking an item
  nutritionModal: [
    '[role="dialog"]',
    '[class*="modal"]',
    '[class*="Modal"]',
    '[class*="nutrition"]',
    '[class*="Nutrition"]',
    '[class*="drawer"]',
  ],

  // A close button for the modal, so we can move to the next item
  modalClose: [
    '[aria-label="Close"]',
    'button[class*="close"]',
    '[class*="Close"]',
  ],
};

// Regex patterns used to pull numbers out of the "Summary Nutritional
// Information" text block, matched against the exact field labels confirmed
// on the live Suwannee Room "Meal Calculator" panel.
const NUTRIENT_PATTERNS = {
  calories: /calories?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
  protein: /protein\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  totalCarbs: /total carbohydrate[s]?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  totalFat: /total fat\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  saturatedFat: /saturated fat\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  transFat: /trans fat\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  cholesterol: /cholesterol\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*mg/i,
  sugars: /(?:total sugars|sugars)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  addedSugars: /added sugars\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  fiber: /(?:dietary fiber|fiber)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  sodium: /sodium\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*mg/i,
  servingSize: /serving size\s*[:\-]?\s*([^\n]+)/i,
};

// The item selector is intentionally broad (any button with "item" in its
// class name), which can also catch site-chrome buttons like "Sign Out" or
// "Retry" that happen to share that class naming convention. Filter those
// out by name before we waste time trying to click into them.
const EXCLUDE_NAME_PATTERNS = [
  /^sign in$/i,
  /^sign out$/i,
  /^log in$/i,
  /^log out$/i,
  /^retry$/i,
  /^loading/i,
  /^add to cart$/i,
  /^view cart$/i,
  /^checkout$/i,
  /^search$/i,
  /^filters?$/i,
  /^clear( all)?$/i,
  /^apply$/i,
  /^close$/i,
  /^submit$/i,
  /^continue$/i,
  /^next$/i,
  /^previous$/i,
  /^back$/i,
  /^home$/i,
  /^locations?$/i,
  /^favorites?$/i,
  /^menu$/i,
  /^cart$/i,
  /^my account$/i,
  /^\s*$/,
  // Patterns confirmed from real Suwannee Room page output:
  /^add$/i, // the "Add to cart" button rendered next to each item's name
  /^view menu$/i,
  /^add to favorites$/i,
  /^meal:/i, // e.g. "Meal:Dinner" (meal-period toggle)
  /^view:/i, // e.g. "View:Daily" (view toggle)
  /^\d+\s*items?\d*\s*cal/i, // e.g. "0 items0 Cal" (cart summary pill)
  /^print$/i,
  /^my menu preferences$/i,
  /^view more$/i,
  /^join$/i, // "Join our email list" style footer/promo button
];

function isLikelyFoodItem(name) {
  if (!name || name.length < 2 || name.length > 120) return false;
  return !EXCLUDE_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

function parseNutritionText(text) {
  const result = {};
  for (const [key, regex] of Object.entries(NUTRIENT_PATTERNS)) {
    const match = text.match(regex);
    result[key] = match ? (key === "servingSize" ? match[1].trim() : Number(match[1])) : null;
  }
  return result;
}

async function findFirstMatch(page, selectorList) {
  for (const sel of selectorList) {
    const count = await page.$$eval(sel, (els) => els.length).catch(() => 0);
    if (count > 0) return { selector: sel, count };
  }
  return null;
}

// Clicks the first button/link/role=button element whose visible text
// matches exactly (case-insensitive). Used for "Clear all" in the Meal
// Calculator panel, which we don't have (and don't need) a stable CSS
// selector for.
async function clickButtonByText(page, text) {
  return page.evaluate((targetText) => {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const match = candidates.find(
      (el) => el.textContent && el.textContent.trim().toLowerCase() === targetText.toLowerCase()
    );
    if (match) {
      match.click();
      return true;
    }
    return false;
  }, text);
}

// Clicking an item's "Add" button only adds it to the calculator silently —
// it does NOT open the nutrition popup by itself. To actually see nutrition,
// you have to separately click the small "N items / N Cal" summary pill
// elsewhere on the page, which opens the "Meal Calculator" modal. This finds
// and clicks that pill.
async function clickCalculatorPill(page) {
  return page.evaluate(() => {
    const regex = /^\d+\s*items?\s*\d*\s*cal/i;
    const all = Array.from(document.querySelectorAll("body *"));
    // Prefer the most specific (leaf-most) element whose own text matches,
    // to avoid grabbing some huge wrapping container.
    const leafMatches = all.filter(
      (el) => el.children.length === 0 && el.textContent && regex.test(el.textContent.trim())
    );
    const candidate =
      leafMatches[0] || all.find((el) => el.textContent && regex.test(el.textContent.trim()));
    if (!candidate) return false;

    // Walk up a few levels to find an actually-clickable ancestor, since the
    // matching text node is often inside a plain <span> or <div>.
    let target = candidate;
    let el = candidate;
    for (let i = 0; i < 4 && el; i++) {
      if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") {
        target = el;
        break;
      }
      el = el.parentElement;
    }
    target.click();
    return true;
  });
}

// After reading nutrition, close whatever dialog/modal is open so the next
// item starts from a clean state.
async function closeAnyDialog(page) {
  const closed = await page.evaluate(() => {
    const selectors = ['[aria-label="Close"]', '[aria-label="close"]', 'button[class*="close" i]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!closed) {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

const MEAL_PERIODS = ["Breakfast", "Lunch", "Dinner"];

function emptyNutrition() {
  return {
    calories: null,
    protein: null,
    totalCarbs: null,
    totalFat: null,
    saturatedFat: null,
    transFat: null,
    cholesterol: null,
    sugars: null,
    addedSugars: null,
    fiber: null,
    sodium: null,
    servingSize: null,
  };
}

// Switches the page's active meal period via the "Meal:X" toggle seen on the
// live site, so a single sync can capture Breakfast + Lunch + Dinner instead
// of whatever period happens to be showing at scrape time. This is another
// UI-structure guess (like the Add-button logic above) — if it can't find
// the toggle or the period option, it logs a warning in --debug mode rather
// than failing the whole sync; whatever period is currently showing just
// gets scraped and tagged with the period name that was intended.
async function switchMealPeriod(page, period, debug) {
  const opened = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("body *"));
    const toggle = all.find(
      (el) => el.children.length === 0 && el.textContent && /^meal\s*:/i.test(el.textContent.trim())
    );
    if (!toggle) return false;
    let el = toggle;
    let target = toggle;
    for (let i = 0; i < 4 && el; i++) {
      if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") {
        target = el;
        break;
      }
      el = el.parentElement;
    }
    target.click();
    return true;
  });

  if (!opened) {
    if (debug) console.warn(`  [debug] Couldn't find the "Meal:" toggle to switch to ${period}.`);
    return false;
  }

  await new Promise((r) => setTimeout(r, 350));

  const selected = await page.evaluate((targetPeriod) => {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], li, div, span'));
    const match = candidates.find(
      (el) =>
        el.children.length === 0 &&
        el.textContent &&
        el.textContent.trim().toLowerCase() === targetPeriod.toLowerCase()
    );
    if (!match) return false;
    let el = match;
    let target = match;
    for (let i = 0; i < 4 && el; i++) {
      if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") {
        target = el;
        break;
      }
      el = el.parentElement;
    }
    target.click();
    return true;
  }, period);

  if (!selected) {
    if (debug) console.warn(`  [debug] Opened the meal toggle, but couldn't find a "${period}" option to click.`);
    return false;
  }

  await new Promise((r) => setTimeout(r, 1000)); // let the item list reload for the new period
  return true;
}

// Scrapes every food item currently shown on the page (i.e. for whatever
// meal period is active). Items already seen in an earlier period (same
// name) reuse their cached nutrition instantly instead of repeating the
// Add → open calculator → read → clear dance — this is both a big speed win
// (dining halls repeat a lot of items across Lunch/Dinner) and the only
// reason scraping three periods doesn't just take 3x as long.
async function scrapeItemsForPeriod(page, period, debug, nutritionCache, deadline) {
  const itemMatch = await findFirstMatch(page, SELECTORS.menuItem);
  if (!itemMatch) {
    console.warn(`[${period}] No menu item elements found.`);
    return [];
  }

  const rawHandles = await page.$$(itemMatch.selector);
  const rawNames = [];
  for (const h of rawHandles) {
    const name = await h.evaluate((el) => el.textContent.trim().replace(/\s+/g, " ")).catch(() => null);
    rawNames.push(name);
  }
  const keptIndexes = [];
  rawNames.forEach((name, i) => {
    if (isLikelyFoodItem(name)) keptIndexes.push(i);
  });

  console.log(`[${period}] Found ${rawHandles.length} elements, ${keptIndexes.length} look like food items.`);

  const items = [];

  for (const i of keptIndexes) {
    const name = rawNames[i];
    if (!name) continue;

    const cacheKey = name.trim().toLowerCase();
    if (nutritionCache.has(cacheKey)) {
      // Seen this exact dish in an earlier period already — reuse it, no
      // clicking needed.
      items.push({ name, mealPeriod: period, ...nutritionCache.get(cacheKey) });
      continue;
    }

    // Hard time budget: once we're out of runway, stop trying to click into
    // items for nutrition detail and just record the remaining names. They
    // still show up and are searchable — they just route to Quick Add
    // instead of auto-filled nutrition, same fallback as any item nutrition
    // parsing fails for. This is what actually guarantees the whole sync
    // finishes in a bounded time instead of scaling with menu size.
    if (Date.now() > deadline) {
      items.push({ name, mealPeriod: period, ...emptyNutrition() });
      continue;
    }

    let nutrition = emptyNutrition();

    try {
      const addClicked = await page.evaluate(
        (idx, selector) => {
          const els = Array.from(document.querySelectorAll(selector));
          const nameEl = els[idx];
          if (!nameEl) return false;
          let container = nameEl.parentElement;
          for (let depth = 0; depth < 6 && container; depth++) {
            const addButtons = Array.from(container.querySelectorAll('button, a, [role="button"]')).filter(
              (el) => el.textContent && el.textContent.trim().toLowerCase() === "add"
            );
            if (addButtons.length === 1) {
              addButtons[0].click();
              return true;
            }
            if (addButtons.length > 1) return false;
            container = container.parentElement;
          }
          return false;
        },
        i,
        itemMatch.selector
      );

      if (addClicked) {
        // Poll for the calculator to register the add, instead of always
        // waiting a fixed amount — most items update almost instantly.
        await page
          .waitForFunction(
            () => {
              const regex = /^\d+\s*items?\s*\d*\s*cal/i;
              const all = document.querySelectorAll("body *");
              for (const el of all) {
                if (el.children.length === 0 && el.textContent && regex.test(el.textContent.trim())) {
                  if (!/^0\s*items?\s*0?\s*cal/i.test(el.textContent.trim())) return true;
                }
              }
              return false;
            },
            { timeout: 1200, polling: 100 }
          )
          .catch(() => {});

        const pillClicked = await clickCalculatorPill(page);
        if (pillClicked) {
          let bodyText = await page
            .waitForFunction(() => document.body.innerText.includes("Summary Nutritional Information"), {
              timeout: 1500,
              polling: 100,
            })
            .then(() => page.evaluate(() => document.body.innerText))
            .catch(() => page.evaluate(() => document.body.innerText));

          let markerIdx = bodyText.indexOf("Summary Nutritional Information");

          // One retry with a bit more patience — worth affording now that
          // the budget is realistic instead of a race against 20 seconds.
          if (markerIdx === -1) {
            await new Promise((r) => setTimeout(r, 600));
            bodyText = await page.evaluate(() => document.body.innerText);
            markerIdx = bodyText.indexOf("Summary Nutritional Information");
          }

          if (markerIdx !== -1) {
            const chunk = bodyText.slice(markerIdx, markerIdx + 700);
            nutrition = { ...nutrition, ...parseNutritionText(chunk) };
          } else if (debug) {
            console.warn(`  [debug] "${name}": pill clicked, but no "Summary Nutritional Information" text found afterward.`);
          }

          await clickButtonByText(page, "Clear all");
          const okClicked = await clickButtonByText(page, "Ok");
          if (!okClicked) await closeAnyDialog(page);
        } else if (debug) {
          console.warn(`  [debug] "${name}": Added, but couldn't find the calculator summary pill to click.`);
        }
      } else if (debug) {
        console.warn(`  [debug] "${name}": couldn't find a scoped "Add" button for this item.`);
      }
    } catch (err) {
      console.warn(`Could not read nutrition for "${name}": ${err.message}`);
    }

    if (nutrition.calories != null) {
      nutritionCache.set(cacheKey, nutrition);
    }
    items.push({ name, mealPeriod: period, ...nutrition });
  }

  return items;
}

async function scrapeMenu({ debug = false } = {}) {
  const scrapeStart = Date.now();
  // A full day (breakfast + lunch + dinner) genuinely takes longer than a
  // single period, since every item needs its own click-and-read — there's
  // no way around that given how the site exposes nutrition. This deadline
  // exists purely as a safety ceiling against something going genuinely
  // wrong (a hung page, a selector that stopped matching), not as a target
  // to race — sync runs in the background now, so taking a couple minutes
  // doesn't block or error the page the way it used to.
  const deadline = scrapeStart + 150000;

  const browser = await puppeteer.launch({
    headless: !debug,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || findLocalChrome() || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // avoids Chromium crashing in small/limited /dev/shm containers like Render's
      "--disable-gpu",
      // Memory-reduction flags: free-tier hosts like Render typically only
      // give ~512MB RAM total for the whole app, and headless Chrome by
      // default runs a bunch of background features that add up fast in
      // that little room. None of this changes what gets scraped — it just
      // turns off things the scraper never uses.
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
      "--disable-ipc-flooding-protection",
      "--disable-renderer-backgrounding",
      "--disable-sync",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--no-first-run",
      "--js-flags=--max-old-space-size=192", // caps the browser's own JS heap instead of growing unbounded
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    );

    console.log(`Navigating to ${MENU_URL} ...`);
    await page.goto(MENU_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 800));

    await page
      .waitForFunction(
        () => {
          const candidates = document.querySelectorAll('[class*="menu-item"], [class*="MenuItem"], button[class*="item"]');
          return candidates.length > 3;
        },
        { timeout: 8000, polling: 300 }
      )
      .catch(() => {});

    if (debug) {
      const html = await page.content();
      const dataDir = path.join(__dirname, "data");
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "debug-page.html"), html, "utf-8");
      console.log("Saved rendered HTML to data/debug-page.html for inspection.");

      for (const [label, list] of Object.entries(SELECTORS)) {
        const match = await findFirstMatch(page, list);
        console.log(
          match
            ? `[${label}] matched "${match.selector}" (${match.count} elements)`
            : `[${label}] NO MATCH from candidates: ${list.join(", ")}`
        );
      }
    }

    const nutritionCache = new Map();
    const stations = [];

    for (const period of MEAL_PERIODS) {
      console.log(`\n--- ${period} (${((Date.now() - scrapeStart) / 1000).toFixed(1)}s elapsed) ---`);
      const switched = await switchMealPeriod(page, period, debug);
      if (!switched) {
        console.warn(
          `[${period}] Couldn't confirm the meal-period switch worked — scraping whatever's ` +
            `currently on screen and tagging it as "${period}" anyway.`
        );
      }
      const items = await scrapeItemsForPeriod(page, period, debug, nutritionCache, deadline);
      const withNutrition = items.filter((it) => it.calories != null).length;
      console.log(`[${period}] Captured nutrition for ${withNutrition} / ${items.length} items.`);
      stations.push({ name: period, items });
    }

    const totalItems = stations.reduce((n, s) => n + s.items.length, 0);
    const totalWithNutrition = stations.reduce(
      (n, s) => n + s.items.filter((it) => it.calories != null).length,
      0
    );
    console.log(
      `\nDone in ${((Date.now() - scrapeStart) / 1000).toFixed(1)}s. ${totalWithNutrition} / ${totalItems} items across all three meal periods have nutrition data.`
    );
    console.log(`(${nutritionCache.size} distinct dishes were fetched; repeats across periods were reused from cache.)`);

    return { scrapedAt: new Date().toISOString(), stations };
  } finally {
    await browser.close();
  }
}

// Allow running directly: `node scraper.js` or `node scraper.js --debug`
if (require.main === module) {
  const debug = process.argv.includes("--debug");
  scrapeMenu({ debug })
    .then((result) => {
      const dataDir = path.join(__dirname, "data");
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "menu-cache.json"), JSON.stringify(result, null, 2));
      console.log(`Saved to data/menu-cache.json`);
    })
    .catch((err) => {
      console.error("Scrape failed:", err);
      process.exit(1);
    });
}

module.exports = { scrapeMenu, MENU_URL };

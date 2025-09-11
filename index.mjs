// index.mjs
import fs from "fs";
import puppeteer from "puppeteer";
import path from "path";
import fetch from "node-fetch";

// --- CONFIG ---
const BIN_ID = "68c2021dae596e708fea4198"; // your JsonBin ID
const API_KEY = "$2a$10$SI/gpDvMkKnXWaJlKR4F9eUR9feh46FeWJS1Le/P3lgtrh2jDIbQK"; // X-Master-Key
const DATA_FILE = "cards.json";            // optional local backup
const TIERS = [1, 2];                      // add other tiers like [1,2,3,4,5,6,'S']
const PAGES_PER_TIER = { 1: 120, 2: 120};     // how many pages per tier
const CONCURRENCY = 3;                     // how many index pages to scrape in parallel

let allCards = [];

// --- Fetch existing cards from JsonBin ---
async function loadFromJsonBin() {
  try {
    const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
      headers: { "X-Master-Key": API_KEY },
    });
    if (!res.ok) throw new Error(`JsonBin load failed: ${res.status}`);
    const json = await res.json();
    return json.record || [];
  } catch (err) {
    console.log("⚠️ Could not load from JsonBin, starting fresh.", err.message);
    return [];
  }
}

// --- Save to JsonBin ---
async function saveToJsonBin(data) {
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": API_KEY,
    },
    body: JSON.stringify(data, null, 2),
  });

  if (!res.ok) {
    const error = await res.text();
    console.error("❌ Failed to save to JsonBin:", error);
  } else {
    console.log("✅ Successfully saved to JsonBin");
  }
}

// --- Detect system Chrome ---
async function getChromePath() {
  const possiblePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  ];

  for (const p of possiblePaths) {
    try {
      fs.accessSync(p);
      return p;
    } catch {}
  }

  console.log("⚠️ Chrome not found, Puppeteer will use bundled Chromium.");
  return null;
}

// --- Generate all index page URLs ---
const PAGE_URLS = [];
for (const tier of TIERS) {
  const totalPages = PAGES_PER_TIER[tier];
  for (let i = 1; i <= totalPages; i++) {
    PAGE_URLS.push(`https://shoob.gg/cards?page=${i}&tier=${tier}`);
  }
}

// --- Scrape single card page ---
const scrapeCardPage = async (browser, url) => {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
    await page.waitForSelector("ol.breadcrumb-new li:last-child span[itemprop='name']", { timeout: 15000 });

    const card = await page.evaluate(() => {
      const name = document.querySelector("ol.breadcrumb-new li:last-child span[itemprop='name']")?.textContent?.trim() || null;
      const tier = document.querySelector("ol.breadcrumb-new li:nth-child(3) span[itemprop='name']")?.textContent?.trim() || null;
      const series = document.querySelector("ol.breadcrumb-new li:nth-child(4) span[itemprop='name']")?.textContent?.trim() || null;
      const img = document.querySelector(".cardData img.img-fluid")?.getAttribute("src") || null;
      const maker = document.querySelector("p:has(span.padr5)")?.textContent?.replace("Card Maker:", "")?.trim() || null;
      return { name, tier, series, img, maker };
    });

    card.url = url;
    console.log("✅ Scraped card:", card);
    return card;
  } catch (err) {
    console.log(`⚠️ Failed scraping ${url}: ${err.message}`);
    return { url, name: null, tier: null, series: null, img: null, maker: null };
  } finally {
    await page.close();
  }
};

// --- Scrape all index pages with concurrency ---
const scrapeAllPages = async (browser, existingUrls) => {
  const newCards = [];
  const queue = [...PAGE_URLS];

  const workers = Array.from({ length: CONCURRENCY }, () =>
    (async () => {
      while (queue.length > 0) {
        const pageUrl = queue.shift();
        const page = await browser.newPage();
        try {
          await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForSelector("a[href^='/cards/info/']", { timeout: 15000 });
          const cardLinks = await page.$$eval("a[href^='/cards/info/']", (links) =>
            [...new Set(links.map((a) => a.href))]
          );
          await page.close();

          for (const link of cardLinks) {
            if (!existingUrls.has(link)) {
              const card = await scrapeCardPage(browser, link);
              newCards.push(card);
              existingUrls.add(link);
            }
          }
        } catch (err) {
          console.log(`⚠️ Failed scraping index page ${pageUrl}: ${err.message}`);
          await page.close();
        }
      }
    })()
  );

  await Promise.all(workers);
  return newCards;
};

// --- Run scraper ---
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  executablePath: puppeteer.executablePath() 
});

allCards = await loadFromJsonBin();
console.log(`Loaded ${allCards.length} cards from JsonBin`);
const existingUrls = new Set(allCards.map((c) => c.url));

const newCards = await scrapeAllPages(browser, existingUrls);
allCards.push(...newCards);

fs.writeFileSync(DATA_FILE, JSON.stringify(allCards, null, 2)); // local backup
console.log(`✅ Added ${newCards.length} new cards — total now ${allCards.length}`);

await saveToJsonBin(allCards);
await browser.close();

// === Keep Alive Server ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ Scraper bot is alive!");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
});

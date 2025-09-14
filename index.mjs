// index.mjs
import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

// --- CONFIG ---
const BIN_ID = "68c2021dae596e708fea4198"; // your JsonBin ID
const API_KEY = "$2a$10$SI/gpDvMkKnXWaJlKR4F9eUR9feh46FeWJS1Le/P3lgtrh2jDIbQK"; // X-Master-Key
const DATA_FILE = "cards.json";            // optional local backup
const TIERS = [1];                      // add other tiers like [1,2,3,4,5,6,'S']
const PAGES_PER_TIER = { 1: 790 };     // how many pages per tier

// --- JsonBin Helpers ---
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

const targetUrl = "https://shoob.gg/cards?page=1&tier=2";

// --- ScrapingAnt request ---
async function fetchHtml(url) {
  const apiUrl = `https://api.scrapingant.com/v2/general?url=${encodeURIComponent(url)}&browser=true&wait_for_selector=.card-main&wait=5000&x-api-key=4286856825214c16ad0606f43cd7a83a`;

  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`ScrapingAnt failed: ${res.status}`);
  return res.text();
}

// --- Scrape a single card page ---
async function scrapeCardPage(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const card = {
      url,
      name:
        $("ol.breadcrumb-new li:last-child span[itemprop='name']")
          .text()
          ?.trim() || null,
      tier:
        $("ol.breadcrumb-new li:nth-child(3) span[itemprop='name']")
          .text()
          ?.trim() || null,
      series:
        $("ol.breadcrumb-new li:nth-child(4) span[itemprop='name']")
          .text()
          ?.trim() || null,
      img: $(".cardData img.img-fluid").attr("src") || null,
      maker:
        $("p:has(span.padr5)")
          .text()
          ?.replace("Card Maker:", "")
          ?.trim() || null,
    };

    console.log("✅ Scraped card:", card);
    return card;
  } catch (err) {
    console.log(`⚠️ Failed scraping ${url}: ${err.message}`);
    return { url, name: null, tier: null, series: null, img: null, maker: null };
  }
}

// --- Scrape all index pages ---
async function scrapeAllPages(existingUrls) {
  const newCards = [];

  for (const tier of TIERS) {
    for (let i = 1; i <= PAGES_PER_TIER[tier]; i++) {
      const pageUrl = `https://shoob.gg/cards?page=${i}&tier=${tier}`;
      console.log(`🔹 Scraping index: ${pageUrl}`);

      try {
        const html = await fetchHtml(pageUrl);
        const $ = cheerio.load(html);

        const cardLinks = [
          ...new Set(
            $("a[href^='/cards/info/']")
              .map((_, a) => "https://shoob.gg" + $(a).attr("href"))
              .get()
          ),
        ];

        for (const link of cardLinks) {
          if (!existingUrls.has(link)) {
            const card = await scrapeCardPage(link);
            newCards.push(card);
            existingUrls.add(link);
            await new Promise((r) => setTimeout(r, 800)); // small delay
          }
        }
      } catch (err) {
        console.log(`⚠️ Failed index page ${pageUrl}: ${err.message}`);
      }

      await new Promise((r) => setTimeout(r, 1500)); // delay between index pages
    }
  }

  return newCards;
}

// --- Run scraper ---
(async () => {
  let allCards = await loadFromJsonBin();
  console.log(`Loaded ${allCards.length} cards from JsonBin`);

  const existingUrls = new Set(allCards.map((c) => c.url));
  const newCards = await scrapeAllPages(existingUrls);

  allCards.push(...newCards);
  fs.writeFileSync(DATA_FILE, JSON.stringify(allCards, null, 2)); // local backup
  console.log(`✅ Added ${newCards.length} new cards — total now ${allCards.length}`);

  await saveToJsonBin(allCards);
})();

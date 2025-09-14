// index.mjs
import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import express from "express";
import path from "path";


// --- CONFIG ---
const SCRAPING_KEY = `4286856825214c16ad0606f43cd7a83a`; // your ScrapingAnt API key
const BIN_ID = "68c2021dae596e708fea4198"; // your JsonBin ID
const API_KEY = "$2a$10$SI/gpDvMkKnXWaJlKR4F9eUR9feh46FeWJS1Le/P3lgtrh2jDIbQK"; // X-Master-Key
const DATA_FILE = "cards.json";            // optional local backup
const TIERS = [2];                      // add other tiers like [1,2,3,4,5,6,'S']
// define [startPage, endPage] for each tier
const PAGE_RANGES = {
  2: [1, 30],   // scrape pages 1 → 30 of tier 2
  // 3: [5, 20],    // scrape pages 5 → 20 of tier 3
};

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

// --- ScrapingAnt request ---
async function fetchHtml(url) {
  const apiUrl = `https://api.scrapingant.com/v2/general?url=${encodeURIComponent(url)}&browser=true&x-api-key=${SCRAPING_KEY}&wait_for_selector=.card-main`;

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
    const [start, end] = PAGE_RANGES[tier];
    for (let i = start; i <= end; i++) {
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
async function runScraper() {
  let allCards = await loadFromJsonBin();
  console.log(`Loaded ${allCards.length} cards from JsonBin`);

  const existingUrls = new Set(allCards.map((c) => c.url));
  const newCards = await scrapeAllPages(existingUrls);

  allCards.push(...newCards);
  fs.writeFileSync(DATA_FILE, JSON.stringify(allCards, null, 2)); // local backup
  console.log(`✅ Added ${newCards.length} new cards — total now ${allCards.length}`);

  await saveToJsonBin(allCards);
}

// === Keep Alive Server ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ Gura Shoob scraper is alive!");
});

app.get("/download", (req, res) => {
  const filePath = path.resolve("cards.json");
  res.download(filePath, "cards.json", (err) => {
    if (err) {
      console.error("❌ Error sending file:", err);
      res.status(500).send("Could not download file.");
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);

  // run the scraper when the server starts
  runScraper();
});

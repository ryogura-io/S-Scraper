// index.mjs
import fs from "fs";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import express from "express";
import { MongoClient } from "mongodb";

// --- CONFIG ---
const SCRAPING_KEY = `966a97dd1a3349a5b59de862e1e50308`; // chr11
const MONGO_URI = "mongodb+srv://Ryou:12345@shoob-cards.6bphku9.mongodb.net/?retryWrites=true&w=majority&appName=Shoob-Cards";
const DB_NAME = "cards-backup";
const COLLECTION_NAME = "cards";

const DATA_FILE = "cards.json"; // optional local backup
const TIERS = [6,'S'];              // add tiers like [1,2,3,4,5,6,'S']
const PAGE_RANGES = {
 6: [1, 34], 
   'S': [1, 7], // scrape pages 1 → 30 of tier 2
//   2: [6, 30]
};

// --- MongoDB Setup ---
let db, cardsCollection;
async function connectMongo() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  cardsCollection = db.collection(COLLECTION_NAME);
  console.log("✅ Connected to MongoDB Atlas");
}

// --- ScrapingAnt request ---
async function fetchHtml(url) {
  const apiUrl = `https://api.scrapingant.com/v2/general?url=${encodeURIComponent(
    url
  )}&browser=true&x-api-key=${SCRAPING_KEY}&wait_for_selector=.card-main`;

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
    ?.trim()
    .replace("Tier ", "") || null,
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

    // save immediately to Mongo
    await cardsCollection.updateOne(
      { url: card.url }, // filter
      { $set: card },    // update
      { upsert: true }   // insert if not exists
    );

    return card;
  } catch (err) {
    console.log(`⚠️ Failed scraping ${url}: ${err.message}`);
    return {
      url,
      name: null,
      tier: null,
      series: null,
      img: null,
      maker: null,
    };
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

            // also save to local backup incrementally
            fs.writeFileSync(
              DATA_FILE,
              JSON.stringify([...existingUrls], null, 2)
            );

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
  // load existing URLs from Mongo
  const existingCards = await cardsCollection.find({}, { projection: { url: 1 } }).toArray();
  const existingUrls = new Set(existingCards.map((c) => c.url));
  console.log(`Loaded ${existingUrls.size} existing cards from Mongo`);

  const newCards = await scrapeAllPages(existingUrls);
  console.log(`✅ Added ${newCards.length} new cards`);
}

// === Keep Alive Server ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ Gura Shoob scraper is alive!");
});

// === API routes ===

// Get all cards
app.get("/api/cards", async (req, res) => {
  try {
    const cards = await cardsCollection.find({}).toArray();
    res.json(cards);
  } catch (err) {
    console.error("❌ Failed to fetch cards:", err.message);
    res.status(500).json({ error: "Failed to fetch cards" });
  }
});

// Get card by name (case insensitive)
app.get("/api/cards/:name", async (req, res) => {
  try {
    const name = req.params.name;
    const card = await cardsCollection.findOne({
      name: { $regex: new RegExp("^" + name + "$", "i") },
    });

    if (!card) return res.status(404).json({ error: "Card not found" });
    res.json(card);
  } catch (err) {
    console.error("❌ Failed to fetch card:", err.message);
    res.status(500).json({ error: "Failed to fetch card" });
  }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);

  // connect to Mongo first
  await connectMongo();

  // run the scraper when the server starts
  runScraper();
});

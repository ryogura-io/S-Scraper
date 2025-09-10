// index.mjs
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import AWS from "aws-sdk";

// --- CONFIG ---
const TIERS = [1]; // Add other tiers if needed
const PAGES_PER_TIER = { 1: 3 }; // Demo: 3 pages for tier 1
const CONCURRENCY = 2; // Low concurrency for free instance

// --- AWS S3 CONFIG ---
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const BUCKET = process.env.S3_BUCKET || "your-bucket-name";
const FILE_KEY = "cards.json";

// --- Helper: load cards from S3 ---
async function loadCards() {
  try {
    const data = await s3.getObject({ Bucket: BUCKET, Key: FILE_KEY }).promise();
    return JSON.parse(data.Body.toString());
  } catch (err) {
    console.log("⚠️ No existing cards found on S3, starting fresh.");
    return [];
  }
}

// --- Helper: save cards to S3 ---
async function saveCards(cards) {
  await s3.putObject({
    Bucket: BUCKET,
    Key: FILE_KEY,
    Body: JSON.stringify(cards, null, 2),
    ContentType: "application/json",
  }).promise();
  console.log(`✅ Saved ${cards.length} cards to S3`);
}

// --- Generate all index page URLs ---
function generatePageUrls() {
  const urls = [];
  for (const tier of TIERS) {
    const totalPages = PAGES_PER_TIER[tier];
    for (let i = 1; i <= totalPages; i++) {
      urls.push(`https://shoob.gg/cards?page=${i}&tier=${tier}`);
    }
  }
  return urls;
}

// --- Scrape single card page ---
async function scrapeCardPage(browser, url) {
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
    console.log("✅ Scraped card:", card.name);
    return card;
  } catch (err) {
    console.log(`⚠️ Failed scraping ${url}: ${err.message}`);
    return { url, name: null, tier: null, series: null, img: null, maker: null };
  } finally {
    await page.close();
  }
}

// --- Main ---
(async () => {
  const browser = await puppeteer.launch({
    headless: true,         // Must be headless for Render
    args: ["--no-sandbox"], // Required on Render/Linux
    defaultViewport: null,
  });

  const allCards = await loadCards();
  const existingUrls = new Set(allCards.map(c => c.url));
  const newCards = [];
  const pageUrls = generatePageUrls();

  // Simple concurrency queue
  const queue = [...pageUrls];
  const workers = Array.from({ length: CONCURRENCY }, () => (async () => {
    while (queue.length > 0) {
      const pageUrl = queue.shift();
      const page = await browser.newPage();
      try {
        await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForSelector("a[href^='/cards/info/']", { timeout: 15000 });
        const cardLinks = await page.$$eval("a[href^='/cards/info/']", links => [...new Set(links.map(a => a.href))]);
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
  })());

  await Promise.all(workers);

  allCards.push(...newCards);
  await saveCards(allCards);
  console.log(`✅ Added ${newCards.length} new cards — total now ${allCards.length}`);

  await browser.close();
})();


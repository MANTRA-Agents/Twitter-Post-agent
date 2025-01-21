/// <reference types="bun-types" />
import { serve } from "bun";
import puppeteer, { Browser } from "puppeteer";

interface Announcement {
  title: string;
  date: string;        // The raw date string as scraped (e.g. "January 9, 2025")
  content: string;
  url: string;
}

/**
 * Helper: Parse a date string like "January 9, 2025" or "Dec 31, 2024" into a real Date.
 * If invalid or unknown format, returns an "Invalid Date" object (check with date.getTime()).
 */
function parseAnnouncementDate(dateString: string): Date {
  // Attempt a straightforward parse
  // JavaScript’s Date constructor usually handles "January 9, 2025" or "Dec 31, 2024" format.
  // If that doesn't suffice, you'd do custom parsing.
  return new Date(Date.parse(dateString));
}

/**
 * In-memory store for announcements
 */
let cachedAnnouncements: Announcement[] = [];

/**
 * Some concurrency limit to speed things up, but avoid too many open pages at once
 */
const CONCURRENCY_LIMIT = 2;

/** 
 * Scrape the announcements listing page to retrieve all article URLs 
 */
async function scrapeListPage(): Promise<string[]> {
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();

    await page.goto("https://mantrachain.io/resources/announcements", {
      waitUntil: "networkidle0",
      timeout: 30_000, // 30s
    });

    // Grab the <a> links for each announcement
    const links = await page.$$eval(
      ".partner-cms-item.is-grid a.announcements--w",
      (anchors) => anchors.map((a) => (a as HTMLAnchorElement).href),
    );
    return links;
  } catch (error) {
    console.error("Error scraping announcements list page:", error);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

/** 
 * Scrape a single article page for title, date, content 
 */
async function scrapeArticle(url: string): Promise<Announcement> {
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();

    await page.goto(url, {
      waitUntil: "networkidle0",
      timeout: 30_000,
    });

    // Title
    const title = await page
      .$eval("h1.heading-3xl", (el) => el.textContent?.trim() || "")
      .catch(() => "");

    // Date string (raw)
    const date = await page
      .$eval("div.announce_mid_w .announce-tag--date p", (el) => el.textContent?.trim() || "")
      .catch(() => "");

    // Content from paragraphs in .article_rich-text
    const paragraphs = await page.$$eval(".article_rich-text p", (nodes) =>
      nodes.map((p) => p.textContent?.trim() || ""),
    );
    const content = paragraphs.join("\n\n");

    return { title, date, content, url };
  } catch (error) {
    console.error("Error scraping article:", url, error);
    return {
      title: "",
      date: "",
      content: "",
      url,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/** 
 * Scrape all announcements, parse each date, then sort descending by date 
 */
async function scrapeAllAnnouncements(): Promise<Announcement[]> {
  // 1) get the list of article links
  const links = await scrapeListPage();
  if (!links.length) {
    console.warn("No announcement links found—returning empty.");
    return [];
  }

  const results: Announcement[] = [];
  let index = 0;

  // Helper to scrape each link
  async function processLink(link: string) {
    const announcement = await scrapeArticle(link);
    results.push(announcement);
  }

  // Slice up the array into chunks of size = CONCURRENCY_LIMIT
  while (index < links.length) {
    const slice = links.slice(index, index + CONCURRENCY_LIMIT);
    await Promise.all(slice.map((link) => processLink(link)));
    index += CONCURRENCY_LIMIT;
  }

  // 2) Sort them by date DESC (newest first) using parseAnnouncementDate
  results.sort((a, b) => {
    const dateA = parseAnnouncementDate(a.date).getTime();
    const dateB = parseAnnouncementDate(b.date).getTime();
    // If date is invalid, it ends up older
    return dateB - dateA; // descending
  });

  return results;
}

/** 
 * background function to re-scrape announcements. 
 */
async function updateAnnouncements(): Promise<void> {
  console.log("Scraping announcements (date-based)...");
  const data = await scrapeAllAnnouncements();
  if (data.length) {
    cachedAnnouncements = data;
  } else {
    console.warn("Scraping returned 0 announcements—keeping old cache if any.");
  }
}

/** 
 * Return the single latest announcement based on sorted list 
 */
function getLatestAnnouncement() {
  return cachedAnnouncements[0] ?? null;
}

// On startup, do an immediate initial scrape
(async () => {
  await updateAnnouncements();
  console.log(`Initial scrape done. Found ${cachedAnnouncements.length} announcements.`);
})();

// Then periodically check for updates (e.g. every 5 minutes)
const FIVE_MINUTES = 5 * 60_000;
setInterval(updateAnnouncements, FIVE_MINUTES);

/**
 * Bun server with:
 *  - /api/announcements -> full list
 *  - /api/announcements/latest -> single newest
 */
const server = serve({
  port: 3000,
  // older Bun versions may enforce <= 255 seconds
  idleTimeout: 255,

  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/announcements") {
      return new Response(JSON.stringify(cachedAnnouncements, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/api/announcements/latest") {
      const latest = getLatestAnnouncement();
      if (latest) {
        return new Response(JSON.stringify(latest, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }
      // If no announcements, respond with 204 (No Content)
      return new Response(null, { status: 204 });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server is running at http://localhost:${server.port}`);

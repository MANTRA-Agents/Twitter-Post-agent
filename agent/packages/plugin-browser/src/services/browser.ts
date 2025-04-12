import { generateText, IBrowserService, trimTokens } from "@elizaos/core";
import { parseJSONObjectFromText } from "@elizaos/core";
import { Service } from "@elizaos/core";
import { settings } from "@elizaos/core";
import { IAgentRuntime, ModelClass, ServiceType } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { PlaywrightBlocker } from "@cliqz/adblocker-playwright";
import CaptchaSolver from "capsolver-npm";
import { Browser, BrowserContext, chromium, Page } from "playwright";
import { elizaLogger } from "@elizaos/core";

import { z } from "zod";

// Zod schema for each announcement item
const AnnouncementItemSchema = z.object({
  date: z.string().regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "Date must be in YYYY-MM-DD format"
  ),
  text: z.string(),
  source: z.string().optional(),
});

type AnnouncementItem = z.infer<typeof AnnouncementItemSchema>;

interface AnnouncementSummary {
  formattedAnnouncement: string;
}

/**
 * Generate a structured summary of the announcements, extracting each announcement
 * in an array and validating them with zod.
 */
export async function generateEnhancedSummary(
  runtime: IAgentRuntime,
  text: string
): Promise<AnnouncementSummary> {
  // Trim text to ensure it's within token limits
  text = await trimTokens(text, 100000, runtime);

  const prompt = `As an expert data analyst, analyze the following tweet and webpage content, focusing ONLY on Mantra-related announcements and information. Extract and organize the information in a clean, structured format, including announcement dates.

Text to analyze: """
${text}
"""

DATA CLEANING RULES:
1. Focus only on official Mantra announcements and updates
2. Remove all promotional and marketing fluff
3. Exclude website utilities, footers, and navigation content
4. Eliminate duplicate information
5. Keep only factual, verifiable information
6. Extract and standardize all dates in YYYY-MM-DD format

Please provide your analysis in this exact structure:

DATES:
[List all relevant dates found in the content]
FORMAT: YYYY-MM-DD: [Event type]

ANNOUNCEMENTS:
[List only confirmed announcements with dates]
FORMAT: YYYY-MM-DD: [Concise announcement] (Source: Tweet/Webpage)

KEY_UPDATES:
[List 3-4 major developments with dates]
FORMAT:
• YYYY-MM-DD: [Update title]
- [Key point 1]
- [Key point 2]
- [Key point 3]

ANALYSIS:
[Core analysis points]
FORMAT:
• [Analysis area]
- [Finding 1 with date if applicable]
- [Finding 2 with date if applicable]
- [Finding 3 with date if applicable]

IMPACT:
[Key implications]
FORMAT:
• [Impact area]
- [Implication 1]
- [Implication 2]
- [Implication 3]

NEXT_STEPS:
[Actionable recommendations]
FORMAT:
• For [stakeholder group]:
- [Action 1]
- [Action 2]
- [Action 3]

Ensure all entries are:
1. Fact-based and verified from source material
2. Clear and concise
3. Properly dated in YYYY-MM-DD format where applicable
4. Properly attributed to source
5. Free of speculative content
`;

  // Generate the LLM response
  const response = await generateText({
    runtime,
    context: prompt,
    modelClass: ModelClass.LARGE,
  });

  if (response) {
    // Split the LLM's response by double newlines to identify major blocks
    const blocks = response.split("\n\n");
    const sections: Record<string, string> = {};

    // In each block, use the first line as "header" and the rest as content
    blocks.forEach((block) => {
      const [header, ...contentLines] = block.split("\n");
      const normalizedHeader = header.trim().toUpperCase().replace(/:$/, "");
      const content = contentLines.join("\n").trim();
      sections[normalizedHeader] = content;
    });

    // 1) Extract ANNOUNCEMENTS lines from the LLM's "ANNOUNCEMENTS" section
    const announcementsRaw = sections["ANNOUNCEMENTS"] || "";
    const announcementLines = announcementsRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => !!l);

    // 2) Parse each line into { date, text, source } with a simple regex
    //    Expected format: "YYYY-MM-DD: Some text here (Source: Tweet/Webpage)"
    const announcementsArray: any[] = [];

    const announcementRegex =
      /^(\d{4}-\d{2}-\d{2}):\s*(.+?)(?:\s*\(Source:\s*(.+)\))?$/i;

    for (const line of announcementLines) {
      const match = line.match(announcementRegex);
      if (match) {
        const [_, date, text, maybeSource] = match;
        announcementsArray.push({
          date,
          text: text.trim(),
          source: maybeSource?.trim(), // if it exists
        });
      }
    }

    // 3) Use zod to validate the array of announcements
    let validatedAnnouncements: AnnouncementItem[] = [];
    try {
      validatedAnnouncements = z.array(AnnouncementItemSchema).parse(announcementsArray);
    } catch (zodError) {
      // If there's a parsing error, we can log or handle it
      console.error("Zod parsing error for announcements:", zodError);
      validatedAnnouncements = []; // fallback to empty if invalid
    }

    // 4) Build the final structured object
    const structuredResponse = {
      dates: sections["DATES"] || "",
      announcements: validatedAnnouncements, // now an array of validated objects
      keyUpdates: sections["KEY_UPDATES"] || "",
      analysis: sections["ANALYSIS"] || "",
      impact: sections["IMPACT"] || "",
      nextSteps: sections["NEXT_STEPS"] || "",
    };

    // Return as a JSON string
    return {
      formattedAnnouncement: JSON.stringify(structuredResponse, null, 2),
    };
  }

 
}


async function generateSummary(
    runtime: IAgentRuntime,
    text: string
): Promise<{ title: string; description: string }> {
    // make sure text is under 128k characters
    text = await trimTokens(text, 100000, runtime);

    const prompt = `Please generate a concise summary for the following text:
    Text: """
    ${text}
    """

    Respond with a JSON object in the following format:
    \`\`\`json
    {
        "title": "Generated Title",
        "summary": "Generated summary and/or description of the text"
    }
    \`\`\``;

    const response = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
    });

    const parsedResponse = parseJSONObjectFromText(response);

    if (parsedResponse) {
        return {
            title: parsedResponse.title,
            description: parsedResponse.summary,
        };
    }

    return {
        title: "",
        description: "",
    };
}

type PageContent = {
    title: string;
    description: string;
    bodyContent: string;
};

export class BrowserService extends Service implements IBrowserService {
    private browser: Browser | undefined;
    private context: BrowserContext | undefined;
    private blocker: PlaywrightBlocker | undefined;
    private captchaSolver: CaptchaSolver;
    private cacheKey = "content/browser";

    static serviceType: ServiceType = ServiceType.BROWSER;

    static register(runtime: IAgentRuntime): IAgentRuntime {
        // since we are lazy loading, do nothing
        return runtime;
    }

    getInstance(): IBrowserService {
        return BrowserService.getInstance();
    }

    constructor() {
        super();
        this.browser = undefined;
        this.context = undefined;
        this.blocker = undefined;
        this.captchaSolver = new CaptchaSolver(
            settings.CAPSOLVER_API_KEY || ""
        );
    }

    async initialize() {}

    async initializeBrowser() {
        if (!this.browser) {
            this.browser = await chromium.launch({
                headless: true,
                args: [
                    "--disable-dev-shm-usage", // Uses /tmp instead of /dev/shm. Prevents memory issues on low-memory systems
                    "--block-new-web-contents", // Prevents creation of new windows/tabs
                ],
            });

            const platform = process.platform;
            let userAgent = "";

            // Change the user agent to match the platform to reduce bot detection
            switch (platform) {
                case "darwin":
                    userAgent =
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
                    break;
                case "win32":
                    userAgent =
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
                    break;
                case "linux":
                    userAgent =
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
                    break;
                default:
                    userAgent =
                        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
            }

            this.context = await this.browser.newContext({
                userAgent,
                acceptDownloads: false,
            });

            this.blocker =
                await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
        }
    }

    async closeBrowser() {
        if (this.context) {
            await this.context.close();
            this.context = undefined;
        }
        if (this.browser) {
            await this.browser.close();
            this.browser = undefined;
        }
    }

    async getPageContent(
        url: string,
        runtime: IAgentRuntime
    ): Promise<PageContent> {
        await this.initializeBrowser();
        return await this.fetchPageContent(url, runtime);
    }

    private getCacheKey(url: string): string {
        return stringToUuid(url);
    }

    private async fetchPageContent(
        url: string,
        runtime: IAgentRuntime
    ): Promise<PageContent> {
        const cacheKey = this.getCacheKey(url);
        const cached = await runtime.cacheManager.get<{
            url: string;
            content: PageContent;
        }>(`${this.cacheKey}/${cacheKey}`);

        if (cached) {
            return cached.content;
        }

        let page: Page | undefined;

        try {
            if (!this.context) {
                elizaLogger.log(
                    "Browser context not initialized. Call initializeBrowser() first."
                );
            }

            page = await this.context.newPage();

            // Enable stealth mode
            await page.setExtraHTTPHeaders({
                "Accept-Language": "en-US,en;q=0.9",
            });

            // Apply ad blocker
            if (this.blocker) {
                await this.blocker.enableBlockingInPage(page);
            }

            const response = await page.goto(url, { waitUntil: "networkidle" });

            if (!response) {
                elizaLogger.error("Failed to load the page");
            }

            if (response.status() === 403 || response.status() === 404) {
                return await this.tryAlternativeSources(url, runtime);
            }

            // Check for CAPTCHA
            const captchaDetected = await this.detectCaptcha(page);
            if (captchaDetected) {
                await this.solveCaptcha(page, url);
            }
            const documentTitle = await page.evaluate(() => document.title);
            const bodyContent = await page.evaluate(
                () => document.body.innerText
            );
            const { title: parsedTitle, description } = await generateSummary(
                runtime,
                documentTitle + "\n" + bodyContent
            );
            const content = { title: parsedTitle, description, bodyContent };
            await runtime.cacheManager.set(`${this.cacheKey}/${cacheKey}`, {
                url,
                content,
            });
            return content;
        } catch (error) {
            elizaLogger.error("Error:", error);
            return {
                title: url,
                description: "Error, could not fetch content",
                bodyContent: "",
            };
        } finally {
            if (page) {
                await page.close();
            }
        }
    }

    private async detectCaptcha(page: Page): Promise<boolean> {
        const captchaSelectors = [
            'iframe[src*="captcha"]',
            'div[class*="captcha"]',
            "#captcha",
            ".g-recaptcha",
            ".h-captcha",
        ];

        for (const selector of captchaSelectors) {
            const element = await page.$(selector);
            if (element) return true;
        }

        return false;
    }

    private async solveCaptcha(page: Page, url: string): Promise<void> {
        try {
            const hcaptchaKey = await this.getHCaptchaWebsiteKey(page);
            if (hcaptchaKey) {
                const solution = await this.captchaSolver.hcaptchaProxyless({
                    websiteURL: url,
                    websiteKey: hcaptchaKey,
                });
                await page.evaluate((token) => {
                    // eslint-disable-next-line
                    // @ts-ignore
                    window.hcaptcha.setResponse(token);
                }, solution.gRecaptchaResponse);
                return;
            }

            const recaptchaKey = await this.getReCaptchaWebsiteKey(page);
            if (recaptchaKey) {
                const solution = await this.captchaSolver.recaptchaV2Proxyless({
                    websiteURL: url,
                    websiteKey: recaptchaKey,
                });
                await page.evaluate((token) => {
                    // eslint-disable-next-line
                    // @ts-ignore
                    document.getElementById("g-recaptcha-response").innerHTML =
                        token;
                }, solution.gRecaptchaResponse);
            }
        } catch (error) {
            elizaLogger.error("Error solving CAPTCHA:", error);
        }
    }

    private async getHCaptchaWebsiteKey(page: Page): Promise<string> {
        return page.evaluate(() => {
            const hcaptchaIframe = document.querySelector(
                'iframe[src*="hcaptcha.com"]'
            );
            if (hcaptchaIframe) {
                const src = hcaptchaIframe.getAttribute("src");
                const match = src?.match(/sitekey=([^&]*)/);
                return match ? match[1] : "";
            }
            return "";
        });
    }

    private async getReCaptchaWebsiteKey(page: Page): Promise<string> {
        return page.evaluate(() => {
            const recaptchaElement = document.querySelector(".g-recaptcha");
            return recaptchaElement
                ? recaptchaElement.getAttribute("data-sitekey") || ""
                : "";
        });
    }

    private async tryAlternativeSources(
        url: string,
        runtime: IAgentRuntime
    ): Promise<{ title: string; description: string; bodyContent: string }> {
        // Try Internet Archive
        const archiveUrl = `https://web.archive.org/web/${url}`;
        try {
            return await this.fetchPageContent(archiveUrl, runtime);
        } catch (error) {
            elizaLogger.error("Error fetching from Internet Archive:", error);
        }

        // Try Google Search as a last resort
        const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
        try {
            return await this.fetchPageContent(googleSearchUrl, runtime);
        } catch (error) {
            elizaLogger.error("Error fetching from Google Search:", error);
            elizaLogger.error(
                "Failed to fetch content from alternative sources"
            );
            return {
                title: url,
                description:
                    "Error, could not fetch content from alternative sources",
                bodyContent: "",
            };
        }
    }
}

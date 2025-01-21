import {
    Provider,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
} from "@elizaos/core";
import { Scraper, Tweet } from "agent-twitter-client";
import { BrowserService } from "../services";


export class AnnouncementProvider implements Provider {
    private browserService: BrowserService;
    private readonly TWITTER_HANDLE = "MANTRA_Chain";
    private readonly ANNOUNCEMENT_URL = "https://www.mantrachain.io/resources/announcements";

    constructor() {
        this.browserService = new BrowserService();
    }

    async get(runtime: IAgentRuntime, _message: Memory, _state: State): Promise<string> {
        try {
            const [twitterData, websiteData] = await Promise.all([
                this.fetchTwitterAnnouncements(runtime),
                this.fetchWebsiteAnnouncements(runtime)
            ]);

            return this.formatResponse(twitterData, websiteData);
        } catch (error) {
            elizaLogger.error("Error in AnnouncementProvider:", error);
            return "Failed to fetch announcements. Please try again later.";
        }
    }

    private async fetchTwitterAnnouncements(_runtime: IAgentRuntime): Promise<Tweet[]> {
        const scraper = new Scraper();
        const tweets: Tweet[] = [];

        try {
            for await (const tweet of scraper.getTweets(this.TWITTER_HANDLE , 1)) {
                tweets.push(tweet);
                // Store tweet in embeddings for future referenc
            }
            elizaLogger.log(`Successfully fetched ${tweets.length} tweets`);
            return tweets;
        } catch (error) {
            elizaLogger.error("Error fetching tweets:", error);
            throw error;
        }
    }

    private async fetchWebsiteAnnouncements(runtime: IAgentRuntime) {
        try {
            await this.browserService.initializeBrowser();
            const pageContent = await this.browserService.getPageContent(
                this.ANNOUNCEMENT_URL,
                runtime
            );

            // Store website content in embeddings

            return pageContent;
        } catch (error) {
            elizaLogger.error("Error fetching website content:", error);
            throw error;
        } finally {
            await this.browserService.closeBrowser();
        }
    }

    private formatResponse(tweets: Tweet[], websiteContent: any): string {
        const twitterSection = tweets.length > 0
            ? `Latest Twitter Announcements:\n${tweets.map((tweet, index) =>
                `${index + 1}. ${tweet.text}`).join("\n")}`
            : "No recent tweets found.";

        const websiteSection = websiteContent.bodyContent
            ? `\n\nWebsite Announcements:\nTitle: ${websiteContent.title}\n${websiteContent.description}\n\nDetails: ${websiteContent.bodyContent}`
            : "\n\nWebsite content unavailable.";

        return `${twitterSection}${websiteSection}`;
    }
}


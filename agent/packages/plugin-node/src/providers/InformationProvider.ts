import {
    Provider,
    IAgentRuntime,
    Memory,
    State,
    elizaLogger
  } from "@elizaos/core";
  import { Scraper, Tweet } from "agent-twitter-client";
  import { BrowserService } from "../services";
  import { generateEnhancedSummary } from "../services/browser";

  function shuffleArray<T>(array: T[]): T[] {
    // Simple Fisher-Yates shuffle
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  export class AnnouncementProvider implements Provider {
    private browserService: BrowserService;
    private readonly TWITTER_HANDLE = "MANTRA_Chain";
    private readonly ANNOUNCEMENT_URL = "https://www.mantrachain.io/resources/announcements";

    constructor() {
      this.browserService = new BrowserService();
    }

    /**
     * Main get() method called by your plugin. It gathers announcements
     * from both Twitter and the website, then returns a structured JSON string
     * (optionally enhanced by generateEnhancedSummary).
     */
    async get(
      runtime: IAgentRuntime,
      _message: Memory,
      _state: State
    ): Promise<string> {
      try {
        // 1. Gather Twitter announcements (tweets)
        const twitterData = await this.fetchTwitterAnnouncements(runtime);

        // 2. Gather website announcements
        const websiteData = await this.fetchWebsiteAnnouncements(runtime);

        // 3. Combine into a structured response
        const structuredData = this.formatResponse(twitterData, websiteData);

        // 4. Optionally enhance with an LLM
        const enhancedSummary = await generateEnhancedSummary(
          runtime,
          JSON.stringify(structuredData) // pass the JSON as string
        );

        elizaLogger.log("AnnouncementProvider: Enhanced Summary", {
          enhancedSummary
        });

        // The "generateEnhancedSummary" presumably returns an object with
        // { formattedAnnouncement: string } or similar. Adjust as needed.
        return enhancedSummary.formattedAnnouncement;
      } catch (error) {
        elizaLogger.error("Error in AnnouncementProvider:", error);
        return "Failed to fetch announcements. Please try again later.";
      }
    }

    /**
     * Fetch 1 latest tweet, or fallback to 20 tweets if none is found,
     * then shuffle them randomly in an array.
     */
    private async fetchTwitterAnnouncements(_runtime: IAgentRuntime): Promise<Tweet[]> {
      const scraper = new Scraper();

      try {
        // Try to get the single latest tweet
        const latestTweet = await scraper.getLatestTweet(this.TWITTER_HANDLE, true, 5);

        if (latestTweet) {
          elizaLogger.log(
            "Successfully fetched 1 latest tweet for handle:",
            this.TWITTER_HANDLE
          );
          return [latestTweet];
        } else {
          // No latest tweet? Then fetch up to 20 tweets from timeline
          elizaLogger.log("No latest tweet found. Fetching up to 20 tweets...");

          const multipleTweets: Tweet[] = [];

          for await (const tweet of scraper.getTweets(this.TWITTER_HANDLE , 10)) {
            multipleTweets.push(tweet);
        }


          if (!multipleTweets || multipleTweets.length === 0) {
            elizaLogger.log("No tweets found at all for", this.TWITTER_HANDLE);
            return [];
          }

          // Shuffle them randomly
          shuffleArray(multipleTweets);
          elizaLogger.log(`Fetched and shuffled ${multipleTweets.length} tweets`);
          return multipleTweets;
        }
      } catch (error) {
        elizaLogger.error("Error fetching tweets:", error);
        throw error;
      }
    }

    /**
     * Fetch the website announcements content from mantrachain.io
     */
    private async fetchWebsiteAnnouncements(runtime: IAgentRuntime) {
      try {
        await this.browserService.initializeBrowser();
        const pageContent = await this.browserService.getPageContent(
          this.ANNOUNCEMENT_URL,
          runtime
        );

        elizaLogger.log("Successfully fetched website content");
        return pageContent;
      } catch (error) {
        elizaLogger.error("Error fetching website content:", error);
        throw error;
      } finally {
        await this.browserService.closeBrowser();
      }
    }

    /**
     * Format the final response as a JSON structure:
     *
     * {
     *   twitter: [
     *     { type: "twitter", text: "...", date: "...", ... },
     *     ...
     *   ],
     *   website: [
     *     { type: "website", content: "raw website text..." }
     *   ]
     * }
     *
     * You can customize how you parse or store the data as needed.
     */
    private formatResponse(tweets: Tweet[], websiteContent: any): any {
      // Build the Twitter array
      const twitterArray = tweets.map((tweet) => ({
        type: "twitter",
        text: tweet.text,
        createdAt: tweet.timestamp,
        id: tweet.id,
        username: tweet.username,
        permanentUrl: tweet.permanentUrl
      }));

      // For the website, you might parse it further, but here we store as one chunk
      const websiteArray = [
        {
          type: "website",
          content: websiteContent?.bodyContent || "No website announcements found."
        }
      ];

      return {
        twitter: twitterArray,
        website: websiteArray
      };
    }
  }

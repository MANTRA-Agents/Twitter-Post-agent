import type { Tweet } from "agent-twitter-client";
import {
  composeContext,
  generateText,
  getEmbeddingZeroVector,
  type IAgentRuntime,
  ModelClass,
  stringToUuid,
  type TemplateType,
  type UUID,
  truncateToCompleteSentence,
} from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import type { ClientBase } from "./base.ts";
import { postActionResponseFooter } from "@elizaos/core";
import { generateTweetActions } from "@elizaos/core";
import { type IImageDescriptionService, ServiceType } from "@elizaos/core";
import { buildConversationThread } from "./utils.ts";
import { twitterMessageHandlerTemplate } from "./interactions.ts";
import { DEFAULT_MAX_TWEET_LENGTH } from "./environment.ts";
import {
  Client,
  Events,
  GatewayIntentBits,
  TextChannel,
  Partials,
} from "discord.js";
import type { State } from "@elizaos/core";
import type { ActionResponse } from "@elizaos/core";

// The AnnouncementsPlugin, which provides random unposted announcements
import { AnnouncementsPlugin } from "./plugins/AnnouncementPlugin.ts";

// ------------------------------------------------------------------
// CoinMarketCap imports + TypeScript interfaces
// ------------------------------------------------------------------
import axios from "axios";

interface PriceData {
  price: number;            
  marketCap: number;        
  volume24h: number;        
  percentChange24h: number; 
}

interface ApiStatus {
  timestamp: string;
  error_code: number;
  error_message: string;
  elapsed: number;
  credit_count: number;
}

interface CryptoQuote {
  [key: string]: {
    price: number;
    volume_24h: number;
    percent_change_24h: number;
    market_cap: number;
  };
}

interface CryptoData {
  id: number;
  name: string;
  symbol: string;
  quote: CryptoQuote;
}

interface ApiData {
  [symbol: string]: CryptoData;
}

interface ApiResponse {
  status: ApiStatus;
  data: ApiData;
}

const CMC_BASE_URL = "https://pro-api.coinmarketcap.com/v1";

/**
 * Fix: explicitly define local variables (price, marketCap, etc.)
 * before returning them in the object.
 */
const createPriceService = (apiKey: string) => {
  const client = axios.create({
    baseURL: CMC_BASE_URL,
    headers: {
      "X-CMC_PRO_API_KEY": apiKey,
      Accept: "application/json",
    },
  });

  const getPrice = async (symbol: string, currency: string): Promise<PriceData> => {
    const normalizedSymbol = symbol.toUpperCase().trim();
    const normalizedCurrency = currency.toUpperCase().trim();

    try {
      const response = await client.get<ApiResponse>(
        "/cryptocurrency/quotes/latest",
        {
          params: {
            symbol: normalizedSymbol,
            convert: normalizedCurrency,
          },
        }
      );

      console.log("CoinMarketCap API Response:", JSON.stringify(response.data, null, 2));

      const symbolData = response.data.data[normalizedSymbol];
      if (!symbolData) {
        throw new Error(`No data found for symbol: ${normalizedSymbol}`);
      }

      const quoteData = symbolData.quote[normalizedCurrency];
      if (!quoteData) {
        throw new Error(`No quote data found for currency: ${normalizedCurrency}`);
      }

      // Explicitly define variables
      const price = quoteData.price;
      const marketCap = quoteData.market_cap;
      const volume24h = quoteData.volume_24h;
      const percentChange24h = quoteData.percent_change_24h;

      return { price, marketCap, volume24h, percentChange24h };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMessage =
          error.response?.data?.status?.error_message || error.message;
        console.error("CoinMarketCap API Error:", errorMessage);
        throw new Error(`API Error: ${errorMessage}`);
      }
      throw error;
    }
  };

  return { getPrice };
};

// ------------------------------------------------------------------
// Templates
// ------------------------------------------------------------------

const MAX_TIMELINES_TO_FETCH = 15;

const AnnouncementPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}
{{announcements}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice, style, and perspective of {{agentName}} (@{{twitterUserName}}), ensuring it sounds like a genuine human voice (not robotic) and embodies a "giga chad" vibe.
Write a post that is {{adjective}}, witty, and relevant about the {{announcements}} to know what's happening in the mantra chain, from the perspective of {{agentName}}. Write a complete analysis of the
announcements.

Your post MUST:
- Use the phrase "JUST NOW" or "TRENDING" for posting about announcements.
- Include emojis.
- Be 2, or 3 sentences in total (choose the length randomly).
- Contain no questions.
- Remain under {{maxTweetLength}} characters.
- Separate sentences with \\n\\n (double spaces) if there are multiple sentences.

Do not add commentary or acknowledge these instructions, just write the post.
`;

const RegularPostTemplate = `
# Character Info
{{knowledge}}
{{bio}}
{{lore}}
{{topics}}

{{providers}}

# Task
Write a short, fun tweet from the perspective of {{agentName}} (@{{twitterUserName}}) about any interesting topic or update. It should:
- Sound enthusiastic and friendly
- Possibly mention current events or a random insight
- Remain under {{maxTweetLength}} characters
- Contain 1 or 2 emojis
- Must NOT mention "announcements" or "JUST NOW"/"TRENDING"

Just output the tweet text (no extra commentary).
`;

export const twitterActionTemplate = `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{twitterUserName}}) based on:
{{bio}}
{{postDirections}}

Guidelines:
- ONLY engage with content that DIRECTLY relates to character's core interests
- Direct mentions are priority IF they are on-topic
- Skip ALL content that is:
  - Off-topic or tangentially related
  - From high-profile accounts unless explicitly relevant
  - Generic/viral content without specific relevance
  - Political/controversial unless central to character
  - Promotional/marketing unless directly relevant

Actions (respond only with tags):
[LIKE] - Perfect topic match AND aligns with character (9.8/10)
[RETWEET] - Exceptional content that embodies character's expertise (9.5/10)
[QUOTE] - Can add substantial domain expertise (9.5/10)
[REPLY] - Can contribute meaningful, expert-level insight (9.5/10)

Tweet:
{{currentTweet}}

# Respond with qualifying action tags only. Default to NO action unless extremely confident of relevance.
` + postActionResponseFooter;

// New Token Update Template
const TokenUpdatePostTemplate = `
# Character Info
{{knowledge}}
{{bio}}
{{lore}}
{{topics}}
{{price}}
{{percentChange24h}}
{{marketCap}}
{{volume24h}}
{{providers}}

# Task
Write a short, vibrant tweet from the perspective of {{agentName}} (@{{twitterUserName}}) about the current OM token price.
You have the following data about OM in {{currency}}:

The tweet should:
- Summarize the current OM price
- Possibly reference the 24-hour change, volume, and market cap
- Sound enthusiastic and knowledgeable
- Remain under {{maxTweetLength}} characters
- Contain 1 or 2 emojis
- Not ask any direct question
- Encourage sharing or liking (CTA)
- No disclaimers like "not financial advice"
- No references to these instructions or meta commentary

Just output the tweet text (no extra commentary).
`;

// ------------------------------------------------------------------
// Implementation
// ------------------------------------------------------------------

interface PendingTweet {
  cleanedContent: string;
  roomId: UUID;
  newTweetContent: string;
  discordMessageId: string;
  channelId: string;
  timestamp: number;
}

type PendingTweetApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export class TwitterPostClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  twitterUsername: string;
  announcementPlugin: AnnouncementsPlugin;

  private isProcessing = false;
  private lastProcessTime = 0;
  private stopProcessingActions = false;
  private isDryRun: boolean;
  private discordClientForApproval: Client;
  private approvalRequired = false;
  private discordApprovalChannelId: string;
  private approvalCheckInterval: number;

  private ANNOUNCEMENT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
  private LAST_ANNOUNCEMENT_KEY: string;

  private lastAnnouncementTime = 0;
  private lastRegularPostTime = 0;

  // CoinMarketCap price service
  private priceService: ReturnType<typeof createPriceService>;

  constructor(
    client: ClientBase,
    runtime: IAgentRuntime,
    announcementPlugin: AnnouncementsPlugin,
  ) {
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
    this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
    this.announcementPlugin = announcementPlugin;

    this.LAST_ANNOUNCEMENT_KEY = `twitter/${this.twitterUsername}/lastAnnouncementPost`;

    // Logging config
    elizaLogger.log("Twitter Client Configuration:");
    elizaLogger.log(`- Username: ${this.twitterUsername}`);
    elizaLogger.log(`- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`);
    elizaLogger.log(
      `- Post Interval (for regular tweets): ${this.client.twitterConfig.POST_INTERVAL_MIN}-${this.client.twitterConfig.POST_INTERVAL_MAX} minutes`
    );
    elizaLogger.log(
      `- Action Processing: ${this.client.twitterConfig.ENABLE_ACTION_PROCESSING ? "enabled" : "disabled"}`
    );
    elizaLogger.log(
      `- Action Interval: ${this.client.twitterConfig.ACTION_INTERVAL} minutes`
    );
    elizaLogger.log(
      `- Post Immediately: ${this.client.twitterConfig.POST_IMMEDIATELY ? "enabled" : "disabled"}`
    );

    if (this.isDryRun) {
      elizaLogger.log("Dry run mode enabled: no actual tweets will be posted.");
    }

    // Check if approval workflow is enabled
    const approvalRequired: boolean =
      this.runtime
        .getSetting("TWITTER_APPROVAL_ENABLED")
        ?.toLowerCase() === "true";
    if (approvalRequired) {
      const discordToken = this.runtime.getSetting("TWITTER_APPROVAL_DISCORD_BOT_TOKEN");
      const approvalChannelId = this.runtime.getSetting("TWITTER_APPROVAL_DISCORD_CHANNEL_ID");
      const APPROVAL_CHECK_INTERVAL =
        Number.parseInt(this.runtime.getSetting("TWITTER_APPROVAL_CHECK_INTERVAL")) ||
        5 * 60 * 1000; // 5 minutes

      if (!discordToken || !approvalChannelId) {
        throw new Error(
          "TWITTER_APPROVAL_DISCORD_BOT_TOKEN and TWITTER_APPROVAL_DISCORD_CHANNEL_ID are required for approval workflow"
        );
      }

      this.approvalRequired = true;
      this.discordApprovalChannelId = approvalChannelId;
      this.approvalCheckInterval = APPROVAL_CHECK_INTERVAL;

      this.setupDiscordClient(discordToken);
    }

    // Initialize the CoinMarketCap service
    const cmcApiKey = this.runtime.getSetting("COINMARKETCAP_API_KEY");
    if (!cmcApiKey) {
      throw new Error("Missing environment setting: COINMARKETCAP_API_KEY");
    }
    this.priceService = createPriceService(cmcApiKey);
  }

  private setupDiscordClient(discordToken: string) {
    this.discordClientForApproval = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    this.discordClientForApproval.once(Events.ClientReady, (readyClient) => {
      elizaLogger.log(`Discord bot is ready as ${readyClient.user.tag}!`);
      const invite = `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user.id}&permissions=274877991936&scope=bot`;
      elizaLogger.log(`Use this link to invite the bot: ${invite}`);
    });

    this.discordClientForApproval.login(discordToken);
  }

  async start() {
    if (!this.client.profile) {
      await this.client.init();
    }

    const generateNewTweetLoop = async () => {
      // 1) Handle any pending approvals first
      if (this.approvalRequired) {
        await this.handlePendingTweet();
      }
    
      // 2) Check last regular tweet post
      const lastPost = await this.runtime.cacheManager.get<{ timestamp: number }>(
        `twitter/${this.twitterUsername}/lastPost`
      );
      const lastPostTimestamp = lastPost?.timestamp ?? 0;
    
      // 3) Pick random interval for next regular/announcement tweet
      const minMinutes = this.client.twitterConfig.POST_INTERVAL_MIN;
      const maxMinutes = this.client.twitterConfig.POST_INTERVAL_MAX;
      const randomMinutes =
        Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
      const delay = randomMinutes * 60 * 1000;
    
      // 4) If it's time for a new "regular or announcement" tweet
      if (Date.now() > lastPostTimestamp + delay) {
        const shouldPostAnnouncement = await this.isAnnouncementDue();
        if (shouldPostAnnouncement) {
          elizaLogger.log("Time to post an announcement tweet.");
          await this.generateAnnouncementTweet();
        } else {
          elizaLogger.log("Posting a *regular* tweet.");
          await this.generateRegularTweet();
        }
      }
    
      // 5) (Optional) Also check if it’s time for OM token update
      //    Suppose we only want to post OM price once every 4 hours:
      const OM_TOKEN_INTERVAL_MS = 4 * 60 * 60 * 1000;
      const lastOmPost = await this.runtime.cacheManager.get<{ timestamp: number }>(
        `twitter/${this.twitterUsername}/lastOmPost`
      );
      const lastOmTimestamp = lastOmPost?.timestamp ?? 0;
    
      if (Date.now() > lastOmTimestamp + OM_TOKEN_INTERVAL_MS) {
        // If it's time, generate token update tweet
        elizaLogger.log("Time to post an OM token price update...");
        await this.generateTokenUpdateTweet("USD");
    
        // Update "lastOmPost" so we don’t do it again too soon
        await this.runtime.cacheManager.set(`twitter/${this.twitterUsername}/lastOmPost`, {
          timestamp: Date.now(),
        });
      }
    
      // 6) Schedule next iteration
      setTimeout(generateNewTweetLoop, delay);
      elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
    };

    const processActionsLoop = async () => {
      const actionInterval = this.client.twitterConfig.ACTION_INTERVAL;
      while (!this.stopProcessingActions) {
        try {
          const results = await this.processTweetActions();
          if (results) {
            elizaLogger.log(`Processed ${results.length} tweets`);
            elizaLogger.log(`Next action check in ${actionInterval} minutes`);
            await new Promise((resolve) =>
              setTimeout(resolve, actionInterval * 60 * 1000)
            );
          }
        } catch (error) {
          elizaLogger.error("Error in action processing loop:", error);
          await new Promise((resolve) => setTimeout(resolve, 30000));
        }
      }
    };

    // Optionally post immediately
    if (this.client.twitterConfig.POST_IMMEDIATELY) {
      if (await this.isAnnouncementDue()) {
        await this.generateAnnouncementTweet();
      } else {
        await this.generateRegularTweet();
      }
    }

    // Start loops
    generateNewTweetLoop();
    elizaLogger.log("Tweet generation loop started");

    if (this.client.twitterConfig.ENABLE_ACTION_PROCESSING) {
      processActionsLoop().catch((error) => {
        elizaLogger.error("Fatal error in processActionsLoop:", error);
      });
    }

    if (this.approvalRequired) {
      this.runPendingTweetCheckLoop();
    }
  }

  private runPendingTweetCheckLoop() {
    setInterval(() => {
      this.handlePendingTweet();
    }, this.approvalCheckInterval);
  }

  private async isAnnouncementDue(): Promise<boolean> {
    const lastAnnouncement = await this.runtime.cacheManager.get<{ timestamp: number }>(
      this.LAST_ANNOUNCEMENT_KEY
    );
    const lastTime = lastAnnouncement?.timestamp ?? 0;
    return Date.now() - lastTime >= this.ANNOUNCEMENT_INTERVAL_MS;
  }

  private async generateAnnouncementTweet() {
    elizaLogger.log("Generating announcement tweet...");
    try {
      const announcement =
        await this.announcementPlugin.getRandomUnpostedAnnouncement();
      if (!announcement) {
        elizaLogger.log("No unposted announcements found. Skipping.");
        await this.runtime.cacheManager.set(this.LAST_ANNOUNCEMENT_KEY, {
          timestamp: Date.now(),
        });
        return;
      }

      const roomId = stringToUuid(
        "twitter_generate_room-" + this.client.profile.username
      );
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.client.profile.username,
        this.runtime.character.name,
        "twitter"
      );

      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId,
          agentId: this.runtime.agentId,
          content: {
            text: announcement.content,
            action: "TWEET",
          },
        },
        {
          twitterUserName: this.client.profile.username,
          announcements: announcement.content,
          topics: this.runtime.character.topics.join(", "),
        }
      );

      const context = composeContext({ state, template: AnnouncementPostTemplate });
      elizaLogger.debug("Announcement tweet prompt:\n" + context);

      const newTweetContent = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL,
      });

      let cleanedContent = "";
      try {
        const parsed = JSON.parse(newTweetContent);
        if (parsed.text) {
          cleanedContent = parsed.text;
        } else if (typeof parsed === "string") {
          cleanedContent = parsed;
        }
      } catch {
        cleanedContent = newTweetContent
          .replace(/\\n/g, "\n\n")
          .replace(/^['"](.*)['"]$/g, "$1")
          .trim();
      }

      cleanedContent = truncateToCompleteSentence(
        cleanedContent,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );

      if (!cleanedContent) {
        elizaLogger.error("Failed to parse valid announcement content:", newTweetContent);
        return;
      }

      if (this.isDryRun) {
        elizaLogger.info("Dry run mode: would post announcement tweet:\n" + cleanedContent);
        await this.runtime.cacheManager.set(this.LAST_ANNOUNCEMENT_KEY, {
          timestamp: Date.now(),
        });
        return;
      }

      if (this.approvalRequired) {
        await this.sendForApproval(cleanedContent, roomId, newTweetContent);
      } else {
        elizaLogger.log("Posting announcement tweet:\n" + cleanedContent);
        await this.postTweet(
          this.runtime,
          this.client,
          cleanedContent,
          roomId,
          newTweetContent,
          this.twitterUsername
        );
        await this.announcementPlugin.markAnnouncementAsPosted(announcement.id);
      }

      await this.runtime.cacheManager.set(this.LAST_ANNOUNCEMENT_KEY, {
        timestamp: Date.now(),
      });
    } catch (error) {
      elizaLogger.error("Error generating announcement tweet:", error);
    }
  }

  private async generateRegularTweet() {
    elizaLogger.log("Generating *regular* tweet...");
    try {
      const roomId = stringToUuid(
        "twitter_regular_room-" + this.client.profile.username
      );
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.client.profile.username,
        this.runtime.character.name,
        "twitter"
      );

      const topics = this.runtime.character.topics.join(", ");
      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId,
          agentId: this.runtime.agentId,
          content: {
            text: topics,
            action: "TWEET",
          },
        },
        {
          twitterUserName: this.client.profile.username,
          topics,
        }
      );

      const context = composeContext({ state, template: RegularPostTemplate });
      elizaLogger.debug("Regular tweet prompt:\n" + context);

      const newTweetContent = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL,
      });

      let cleanedContent = "";
      try {
        const parsed = JSON.parse(newTweetContent);
        if (parsed.text) {
          cleanedContent = parsed.text;
        } else if (typeof parsed === "string") {
          cleanedContent = parsed;
        }
      } catch {
        cleanedContent = newTweetContent
          .replace(/\\n/g, "\n\n")
          .replace(/^['"](.*)['"]$/g, "$1")
          .trim();
      }

      cleanedContent = truncateToCompleteSentence(
        cleanedContent,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );

      if (!cleanedContent) {
        elizaLogger.error("Failed to parse valid content for regular tweet.");
        return;
      }

      if (this.isDryRun) {
        elizaLogger.info(`Dry run: Would have posted:\n${cleanedContent}`);
        return;
      }

      if (this.approvalRequired) {
        await this.sendForApproval(cleanedContent, roomId, newTweetContent);
      } else {
        elizaLogger.log("Posting regular tweet:\n" + cleanedContent);
        await this.postTweet(
          this.runtime,
          this.client,
          cleanedContent,
          roomId,
          newTweetContent,
          this.twitterUsername
        );
      }
    } catch (error) {
      elizaLogger.error("Error generating regular tweet:", error);
    }
  }

  /**
   * This method fetches the OM token data from CoinMarketCap,
   * composes the tweet, and posts (or queues for approval).
   */
  private async generateTokenUpdateTweet(currency = "USD") {
    elizaLogger.log("[TwitterPostClient] Generating OM token price update tweet...");

    try {
      // 1) Fetch OM token data
      const { price, marketCap, volume24h, percentChange24h } =
        await this.priceService.getPrice("OM", currency);

      // 2) Prepare roomId
      const roomId = stringToUuid(
        "twitter_om_token_room-" + this.client.profile.username
      );
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.client.profile.username,
        this.runtime.character.name,
        "twitter"
      );

      // 3) Build state
      const state = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId,
          agentId: this.runtime.agentId,
          content: {
            text: `OM token price data for ${currency}`,
            action: "TWEET",
          },
        },
        {
          twitterUserName: this.client.profile.username,
          currency,
          price: price,            // e.g. 4 decimal places
          marketCap: Math.round(marketCap),   // integer
          volume24h: Math.round(volume24h),   // integer
          percentChange24h: percentChange24h.toFixed(2),
        }
      );

      // 4) Compose GPT prompt
      const context = composeContext({
        state,
        template: TokenUpdatePostTemplate,
      });
      elizaLogger.debug("OM Tweet prompt:\n" + context);

      // 5) Generate text
      const rawResponse = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL,
      });

      // 6) Cleanup
      let cleanedContent = rawResponse
        .replace(/\\n/g, "\n\n")
        .replace(/^['"](.*)['"]$/g, "$1")
        .trim();

      try {
        const parsed = JSON.parse(rawResponse);
        if (parsed.text) {
          cleanedContent = parsed.text;
        }
      } catch {
        // Not JSON, so keep as-is
      }

      cleanedContent = truncateToCompleteSentence(
        cleanedContent,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );

      if (!cleanedContent) {
        elizaLogger.error("Failed to generate OM token tweet content.");
        return;
      }

      // 7) Post or queue for approval
      if (this.isDryRun) {
        elizaLogger.info(`[Dry Run] Would post OM token tweet:\n${cleanedContent}`);
        return;
      }

      if (this.approvalRequired) {
        await this.sendForApproval(cleanedContent, roomId, rawResponse);
      } else {
        elizaLogger.log("Posting OM token tweet:\n" + cleanedContent);
        await this.postTweet(
          this.runtime,
          this.client,
          cleanedContent,
          roomId,
          rawResponse,
          this.twitterUsername
        );
      }
    } catch (error) {
      elizaLogger.error("Error generating OM token price tweet:", error);
    }
  }

  // You can call generateTokenUpdateTweet("USD") anywhere you like,
  // e.g. on an interval, or on a command, etc.

  // ----------------------------------------------------------------------
  // Methods for posting, approvals, and timeline actions remain unchanged
  // ----------------------------------------------------------------------

  createTweetObject(
    tweetResult: any,
    client: any,
    twitterUsername: string
  ): Tweet {
    return {
      id: tweetResult.rest_id,
      name: client.profile.screenName,
      username: client.profile.username,
      text: tweetResult.legacy.full_text,
      conversationId: tweetResult.legacy.conversation_id_str,
      createdAt: tweetResult.legacy.created_at,
      timestamp: new Date(tweetResult.legacy.created_at).getTime(),
      userId: client.profile.id,
      inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
      permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
      hashtags: [],
      mentions: [],
      photos: [],
      thread: [],
      urls: [],
      videos: [],
    } as Tweet;
  }

  async postTweet(
    runtime: IAgentRuntime,
    client: ClientBase,
    cleanedContent: string,
    roomId: UUID,
    newTweetContent: string,
    twitterUsername: string
  ) {
    try {
      elizaLogger.log("Posting new tweet...");

      let result;
      if (cleanedContent.length > DEFAULT_MAX_TWEET_LENGTH) {
        result = await this.handleNoteTweet(client, cleanedContent);
      } else {
        result = await this.sendStandardTweet(client, cleanedContent);
      }

      if (!result) {
        elizaLogger.error("Failed to post tweet; no result returned.");
        return;
      }

      const tweet = this.createTweetObject(result, client, twitterUsername);
      await this.processAndCacheTweet(runtime, client, tweet, roomId, newTweetContent);
    } catch (error) {
      elizaLogger.error("Error sending tweet:", error);
    }
  }

  async handleNoteTweet(client: ClientBase, content: string, tweetId?: string) {
    try {
      const noteTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendNoteTweet(content, tweetId)
      );
      if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
        const truncated = truncateToCompleteSentence(
          content,
          this.client.twitterConfig.MAX_TWEET_LENGTH
        );
        return await this.sendStandardTweet(client, truncated, tweetId);
      } else {
        return noteTweetResult.data.notetweet_create.tweet_results.result;
      }
    } catch (error) {
      throw new Error(`Note Tweet failed: ${error}`);
    }
  }

  async sendStandardTweet(client: ClientBase, content: string, tweetId?: string) {
    try {
      const standardTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendTweet(content, tweetId)
      );
      const body = await standardTweetResult.json();
      if (!body?.data?.create_tweet?.tweet_results?.result) {
        elizaLogger.error("Bad tweet response:", body);
        return;
      }
      return body.data.create_tweet.tweet_results.result;
    } catch (error) {
      elizaLogger.error("Error sending standard Tweet:", error);
      throw error;
    }
  }

  async processAndCacheTweet(
    runtime: IAgentRuntime,
    client: ClientBase,
    tweet: Tweet,
    roomId: UUID,
    newTweetContent: string
  ) {
    await runtime.cacheManager.set(`twitter/${client.profile.username}/lastPost`, {
      id: tweet.id,
      timestamp: Date.now(),
    });
    await client.cacheTweet(tweet);

    elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

    await runtime.ensureRoomExists(roomId);
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

    await runtime.messageManager.createMemory({
      id: stringToUuid(tweet.id + "-" + runtime.agentId),
      userId: runtime.agentId,
      agentId: runtime.agentId,
      content: {
        text: newTweetContent.trim(),
        url: tweet.permanentUrl,
        source: "twitter",
      },
      roomId,
      embedding: getEmbeddingZeroVector(),
      createdAt: tweet.timestamp,
    });
  }

  async stop() {
    this.stopProcessingActions = true;
  }

  private async sendForApproval(
    cleanedContent: string,
    roomId: UUID,
    newTweetContent: string
  ): Promise<string | null> {
    try {
      const embed = {
        title: "New Tweet Pending Approval",
        description: cleanedContent,
        fields: [
          { name: "Character", value: this.client.profile.username, inline: true },
          { name: "Length", value: String(cleanedContent.length), inline: true },
        ],
        footer: {
          text: "React with '👍' to post or '❌' to discard. Expires after 24h.",
        },
        timestamp: new Date().toISOString(),
      };

      const channel = await this.discordClientForApproval.channels.fetch(
        this.discordApprovalChannelId
      );
      if (!channel || !(channel instanceof TextChannel)) {
        throw new Error("Invalid approval channel");
      }

      const message = await channel.send({ embeds: [embed] });

      const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
      const currentPendingTweets =
        (await this.runtime.cacheManager.get<PendingTweet[]>(pendingTweetsKey)) || [];

      currentPendingTweets.push({
        cleanedContent,
        roomId,
        newTweetContent,
        discordMessageId: message.id,
        channelId: this.discordApprovalChannelId,
        timestamp: Date.now(),
      });
      await this.runtime.cacheManager.set(pendingTweetsKey, currentPendingTweets);

      return message.id;
    } catch (error) {
      elizaLogger.error("Error Sending Approval Request:", error);
      return null;
    }
  }

  private async checkApprovalStatus(
    discordMessageId: string
  ): Promise<PendingTweetApprovalStatus> {
    try {
      const channel = await this.discordClientForApproval.channels.fetch(
        this.discordApprovalChannelId
      );
      if (!(channel instanceof TextChannel)) {
        elizaLogger.error("Invalid approval channel");
        return "PENDING";
      }
      const message = await channel.messages.fetch(discordMessageId);
      const thumbsUpReaction = message.reactions.cache.find(
        (reaction) => reaction.emoji.name === "👍"
      );
      const rejectReaction = message.reactions.cache.find(
        (reaction) => reaction.emoji.name === "❌"
      );

      if (rejectReaction && rejectReaction.count > 0) return "REJECTED";
      if (thumbsUpReaction && thumbsUpReaction.count > 0) return "APPROVED";

      return "PENDING";
    } catch (error) {
      elizaLogger.error("Error checking approval status:", error);
      return "PENDING";
    }
  }

  private async cleanupPendingTweet(discordMessageId: string) {
    const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
    const currentPendingTweets =
      (await this.runtime.cacheManager.get<PendingTweet[]>(pendingTweetsKey)) || [];

    const updatedPendingTweets = currentPendingTweets.filter(
      (pt) => pt.discordMessageId !== discordMessageId
    );

    if (updatedPendingTweets.length === 0) {
      await this.runtime.cacheManager.delete(pendingTweetsKey);
    } else {
      await this.runtime.cacheManager.set(pendingTweetsKey, updatedPendingTweets);
    }
  }

  private async handlePendingTweet() {
    elizaLogger.log("Checking Pending Tweets...");
    const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
    const pendingTweets =
      (await this.runtime.cacheManager.get<PendingTweet[]>(pendingTweetsKey)) || [];

    for (const pendingTweet of pendingTweets) {
      const isExpired = Date.now() - pendingTweet.timestamp > 24 * 60 * 60 * 1000;
      if (isExpired) {
        elizaLogger.log("Pending tweet expired, cleaning up");
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(
              pendingTweet.discordMessageId
            );
            await originalMessage.reply("Tweet approval request expired (24h).");
          }
        } catch (err) {
          elizaLogger.error("Error sending expiration notification:", err);
        }
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
        return;
      }

      elizaLogger.log("Checking approval status...");
      const approvalStatus = await this.checkApprovalStatus(pendingTweet.discordMessageId);

      if (approvalStatus === "APPROVED") {
        elizaLogger.log("Tweet Approved, Posting...");
        await this.postTweet(
          this.runtime,
          this.client,
          pendingTweet.cleanedContent,
          pendingTweet.roomId,
          pendingTweet.newTweetContent,
          this.twitterUsername
        );
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(
              pendingTweet.discordMessageId
            );
            await originalMessage.reply("Tweet posted successfully! ✅");
          }
        } catch (error) {
          elizaLogger.error("Error sending post notification:", error);
        }
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);

      } else if (approvalStatus === "REJECTED") {
        elizaLogger.log("Tweet Rejected, Cleaning Up.");
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(
              pendingTweet.discordMessageId
            );
            await originalMessage.reply("Tweet was rejected! ❌");
          }
        } catch (error) {
          elizaLogger.error("Error sending rejection notification:", error);
        }
      }
    }
  }

  private async processTweetActions() {
    if (this.isProcessing) {
      elizaLogger.log("Already processing tweet actions, skipping");
      return null;
    }

    try {
      this.isProcessing = true;
      this.lastProcessTime = Date.now();

      elizaLogger.log("Processing tweet actions...");
      await this.runtime.ensureUserExists(
        this.runtime.agentId,
        this.twitterUsername,
        this.runtime.character.name,
        "twitter"
      );

      const timelines = await this.client.fetchTimelineForActions(
        MAX_TIMELINES_TO_FETCH
      );
      const maxActionsProcessing = this.client.twitterConfig.MAX_ACTIONS_PROCESSING;
      const processedTimelines = [];

      for (const tweet of timelines) {
        try {
          const memory = await this.runtime.messageManager.getMemoryById(
            stringToUuid(tweet.id + "-" + this.runtime.agentId)
          );
          if (memory) {
            elizaLogger.log(`Already processed tweet ID: ${tweet.id}`);
            continue;
          }

          const roomId = stringToUuid(
            tweet.conversationId + "-" + this.runtime.agentId
          );

          const tweetState = await this.runtime.composeState(
            {
              userId: this.runtime.agentId,
              roomId,
              agentId: this.runtime.agentId,
              content: { text: "", action: "" },
            },
            {
              twitterUserName: this.twitterUsername,
              currentTweet: `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})\nText: ${tweet.text}`,
            }
          );

          const actionContext = composeContext({
            state: tweetState,
            template:
              this.runtime.character.templates?.twitterActionTemplate ||
              twitterActionTemplate,
          });

          const actionResponse = await generateTweetActions({
            runtime: this.runtime,
            context: actionContext,
            modelClass: ModelClass.SMALL,
          });
          if (!actionResponse) {
            elizaLogger.log(`No valid actions for tweet ${tweet.id}`);
            continue;
          }

          processedTimelines.push({
            tweet,
            actionResponse,
            tweetState,
            roomId,
          });
        } catch (error) {
          elizaLogger.error(`Error processing tweet ${tweet.id}:`, error);
        }
      }

      const sortProcessedTimeline = (arr: {
        tweet: Tweet;
        actionResponse: ActionResponse;
        tweetState: State;
        roomId: UUID;
      }[]) => {
        return arr.sort((a, b) => {
          const countTrue = (obj: ActionResponse) =>
            Object.values(obj).filter(Boolean).length;

          const countA = countTrue(a.actionResponse);
          const countB = countTrue(b.actionResponse);

          if (countA !== countB) return countB - countA;
          if (a.actionResponse.like !== b.actionResponse.like) {
            return a.actionResponse.like ? -1 : 1;
          }
          return 0;
        });
      };

      const sortedTimelines = sortProcessedTimeline(processedTimelines).slice(
        0,
        maxActionsProcessing
      );

      return this.processTimelineActions(sortedTimelines);
    } catch (error) {
      elizaLogger.error("Error in processTweetActions:", error);
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  private async processTimelineActions(
    timelines: {
      tweet: Tweet;
      actionResponse: ActionResponse;
      tweetState: State;
      roomId: UUID;
    }[]
  ): Promise<
    {
      tweetId: string;
      actionResponse: ActionResponse;
      executedActions: string[];
    }[]
  > {
    const results = [];
    for (const timeline of timelines) {
      const { actionResponse, tweetState, roomId, tweet } = timeline;
      try {
        const executedActions: string[] = [];

        // LIKE
        if (actionResponse.like) {
          if (this.isDryRun) {
            elizaLogger.info(`Dry run: like tweet ${tweet.id}`);
            executedActions.push("like (dry run)");
          } else {
            try {
              await this.client.twitterClient.likeTweet(tweet.id);
              executedActions.push("like");
              elizaLogger.log(`Liked tweet ${tweet.id}`);
            } catch (error) {
              elizaLogger.error(`Error liking tweet ${tweet.id}:`, error);
            }
          }
        }

        // RETWEET
        if (actionResponse.retweet) {
          if (this.isDryRun) {
            elizaLogger.info(`Dry run: retweet tweet ${tweet.id}`);
            executedActions.push("retweet (dry run)");
          } else {
            try {
              await this.client.twitterClient.retweet(tweet.id);
              executedActions.push("retweet");
              elizaLogger.log(`Retweeted tweet ${tweet.id}`);
            } catch (error) {
              elizaLogger.error(`Error retweeting tweet ${tweet.id}:`, error);
            }
          }
        }

        // QUOTE
        if (actionResponse.quote) {
          try {
            const result = await this.handleQuoteAction(tweet);
            if (result) executedActions.push("quote");
          } catch (error) {
            elizaLogger.error("Error generating quote tweet:", error);
          }
        }

        // REPLY
        if (actionResponse.reply) {
          try {
            await this.handleTextOnlyReply(tweet, tweetState, executedActions);
          } catch (error) {
            elizaLogger.error(`Error replying to tweet ${tweet.id}:`, error);
          }
        }

        // Record memory
        await this.runtime.ensureRoomExists(roomId);
        await this.runtime.ensureUserExists(
          stringToUuid(tweet.userId),
          tweet.username,
          tweet.name,
          "twitter"
        );
        await this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId);

        if (!this.isDryRun) {
          await this.runtime.messageManager.createMemory({
            id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
            userId: stringToUuid(tweet.userId),
            content: {
              text: tweet.text,
              url: tweet.permanentUrl,
              source: "twitter",
              action: executedActions.join(","),
            },
            agentId: this.runtime.agentId,
            roomId,
            embedding: getEmbeddingZeroVector(),
            createdAt: tweet.timestamp * 1000,
          });
        }

        results.push({ tweetId: tweet.id, actionResponse, executedActions });
      } catch (error) {
        elizaLogger.error(`Error processing tweet ${tweet.id}:`, error);
      }
    }
    return results;
  }

  private async handleQuoteAction(tweet: Tweet) {
    try {
      const thread = await buildConversationThread(tweet, this.client);
      const formattedConversation = thread
        .map(
          (t) =>
            `@${t.username} (${new Date(t.timestamp * 1000).toLocaleString()}): ${t.text}`
        )
        .join("\n\n");

      const imageDescriptions = [];
      if (tweet.photos?.length > 0) {
        for (const photo of tweet.photos) {
          const description = await this.runtime
            .getService<IImageDescriptionService>(ServiceType.IMAGE_DESCRIPTION)
            .describeImage(photo.url);
          imageDescriptions.push(description);
        }
      }

      let quotedContent = "";
      if (tweet.quotedStatusId) {
        try {
          const quotedTweet = await this.client.twitterClient.getTweet(
            tweet.quotedStatusId
          );
          if (quotedTweet) {
            quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
          }
        } catch (error) {
          elizaLogger.error("Error fetching quoted tweet:", error);
        }
      }

      const enrichedState = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId: stringToUuid(tweet.conversationId + "-" + this.runtime.agentId),
          agentId: this.runtime.agentId,
          content: { text: tweet.text, action: "QUOTE" },
        },
        {
          twitterUserName: this.twitterUsername,
          currentPost: `From @${tweet.username}: ${tweet.text}`,
          formattedConversation,
          imageContext:
            imageDescriptions.length > 0
              ? imageDescriptions
                  .map((desc, i) => `Image ${i + 1}: ${desc}`)
                  .join("\n")
              : "",
          quotedContent,
        }
      );

      const quoteContent = await this.generateTweetContent(enrichedState, {
        template:
          this.runtime.character.templates?.twitterMessageHandlerTemplate ||
          twitterMessageHandlerTemplate,
      });

      if (!quoteContent) {
        elizaLogger.error("Failed to generate quote tweet content");
        return false;
      }

      elizaLogger.log("Generated quote tweet content:", quoteContent);

      if (this.isDryRun) {
        elizaLogger.info("[Dry Run] Would have posted quote tweet: " + quoteContent);
        return true;
      }

      const result = await this.client.requestQueue.add(
        async () => await this.client.twitterClient.sendQuoteTweet(quoteContent, tweet.id)
      );
      const body = await result.json();

      if (body?.data?.create_tweet?.tweet_results?.result) {
        elizaLogger.log("Successfully posted quote tweet");
        await this.runtime.cacheManager.set(
          `twitter/quote_generation_${tweet.id}.txt`,
          `Context:\n${enrichedState}\n\nGenerated Quote:\n${quoteContent}`
        );
        return true;
      } else {
        elizaLogger.error("Quote tweet creation failed:", body);
        return false;
      }
    } catch (error) {
      elizaLogger.error("Error in handleQuoteAction:", error);
      return false;
    }
  }

  private async handleTextOnlyReply(
    tweet: Tweet,
    tweetState: any,
    executedActions: string[]
  ) {
    try {
      const thread = await buildConversationThread(tweet, this.client);
      const formattedConversation = thread
        .map(
          (t) =>
            `@${t.username} (${new Date(t.timestamp * 1000).toLocaleString()}): ${t.text}`
        )
        .join("\n\n");

      const imageDescriptions = [];
      if (tweet.photos?.length > 0) {
        for (const photo of tweet.photos) {
          const description = await this.runtime
            .getService<IImageDescriptionService>(ServiceType.IMAGE_DESCRIPTION)
            .describeImage(photo.url);
          imageDescriptions.push(description);
        }
      }

      let quotedContent = "";
      if (tweet.quotedStatusId) {
        try {
          const quotedTweet = await this.client.twitterClient.getTweet(
            tweet.quotedStatusId
          );
          if (quotedTweet) {
            quotedContent = `\nQuoted Tweet from @${quotedTweet.username}:\n${quotedTweet.text}`;
          }
        } catch (error) {
          elizaLogger.error("Error fetching quoted tweet:", error);
        }
      }

      const enrichedState = await this.runtime.composeState(
        {
          userId: this.runtime.agentId,
          roomId: stringToUuid(tweet.conversationId + "-" + this.runtime.agentId),
          agentId: this.runtime.agentId,
          content: { text: tweet.text, action: "REPLY" },
        },
        {
          twitterUserName: this.twitterUsername,
          currentPost: `From @${tweet.username}: ${tweet.text}`,
          formattedConversation,
          imageContext:
            imageDescriptions.length > 0
              ? imageDescriptions.map((desc, i) => `Image ${i + 1}: ${desc}`).join("\n")
              : "",
          quotedContent,
        }
      );

      const replyText = await this.generateTweetContent(enrichedState, {
        template:
          this.runtime.character.templates?.twitterMessageHandlerTemplate ||
          twitterMessageHandlerTemplate,
      });

      if (!replyText) {
        elizaLogger.error("Failed to generate valid reply content");
        return;
      }

      if (this.isDryRun) {
        elizaLogger.info("[Dry Run] Would have replied with:\n" + replyText);
        executedActions.push("reply (dry run)");
        return;
      }

      elizaLogger.debug("Reply text to be sent:", replyText);

      let result;
      if (replyText.length > DEFAULT_MAX_TWEET_LENGTH) {
        result = await this.handleNoteTweet(this.client, replyText, tweet.id);
      } else {
        result = await this.sendStandardTweet(this.client, replyText, tweet.id);
      }

      if (result) {
        elizaLogger.log("Successfully posted reply tweet");
        executedActions.push("reply");
        await this.runtime.cacheManager.set(
          `twitter/reply_generation_${tweet.id}.txt`,
          `Context:\n${enrichedState}\n\nGenerated Reply:\n${replyText}`
        );
      } else {
        elizaLogger.error("Tweet reply creation failed");
      }
    } catch (error) {
      elizaLogger.error("Error in handleTextOnlyReply:", error);
    }
  }

  private async generateTweetContent(
    tweetState: any,
    options?: {
      template?: TemplateType;
      context?: string;
    }
  ): Promise<string> {
    const context = composeContext({
      state: tweetState,
      template: options?.template || twitterMessageHandlerTemplate,
    });

    const response = await generateText({
      runtime: this.runtime,
      context: options?.context || context,
      modelClass: ModelClass.SMALL,
    });
    elizaLogger.debug("Generate tweet content response:\n" + response);

    const cleanedResponse = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .replaceAll(/\\n/g, "\n")
      .trim();

    try {
      const jsonResponse = JSON.parse(cleanedResponse);
      if (jsonResponse.text) {
        return this.trimTweetLength(jsonResponse.text);
      }
      if (typeof jsonResponse === "object") {
        const possibleContent =
          jsonResponse.content || jsonResponse.message || jsonResponse.response;
        if (possibleContent) {
          return this.trimTweetLength(possibleContent);
        }
      }
    } catch {
      elizaLogger.debug("Response not JSON, treating as plain text");
    }

    return this.trimTweetLength(cleanedResponse);
  }

  private trimTweetLength(text: string, maxLength = 280): string {
    if (text.length <= maxLength) return text;
    const lastSentence = text.slice(0, maxLength).lastIndexOf(".");
    if (lastSentence > 0) {
      return text.slice(0, lastSentence + 1).trim();
    }
    return text.slice(0, text.lastIndexOf(" ", maxLength - 3)).trim() + "...";
  }
}

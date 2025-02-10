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

// ------------------------------------------------------------------
// CoinMarketCap Service
// ------------------------------------------------------------------
const CMC_BASE_URL = "https://pro-api.coinmarketcap.com/v1";

/**
 * Returns an object with a method `getPrice(symbol, currency)`,
 * fetching from CoinMarketCap.
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

      console.log(
        "CoinMarketCap API Response:",
        JSON.stringify(response.data, null, 2)
      );

      const symbolData = response.data.data[normalizedSymbol];
      if (!symbolData) {
        throw new Error(`No data found for symbol: ${normalizedSymbol}`);
      }

      const quoteData = symbolData.quote[normalizedCurrency];
      if (!quoteData) {
        throw new Error(`No quote data found for currency: ${normalizedCurrency}`);
      }

      // Extract local vars
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
// Tweet Templates (CEO/Investor Style)
// ------------------------------------------------------------------
// NOTE: Updated instructions to reflect a more professional, investor-like tone.
// Also limiting emojis and ensuring we don't sound "robotic".

const MAX_TIMELINES_TO_FETCH = 15;

/**
 * AnnouncementPostTemplate: Giga-chad CEO/Investor style, minimal emojis,
 * well-informed, direct, no questions, short.
 */
const AnnouncementPostTemplate = `
# Context
You're an insider in the MANTRA ecosystem, sharing a **forward-looking update** with clarity and confidence. You know how to frame important developments without unnecessary hype.

- **Knowledge**: {{knowledge}}
- **Bio**: {{bio}}
- **Topics of Interest**: {{topics}}
- **Providers**: {{providers}}

# Task
Write a **short, high-impact announcement** about a MANTRA milestone, innovation, or broader industry trend.

- **Start with a concise, strong headline.**
- **Follow with 2-3 short sentences that explain why this matters.**
- **Keep it direct, avoiding marketing fluff.**
- **Frame the message as an inevitable progression—not just an event.**
- **Under {{maxTweetLength}} characters, formatted with proper spacing.**
`;
/**
 * RegularPostTemplate: CEO/Investor style for a general "update" or thought.
 */
const RegularPostTemplate = `
# Context
You're a sharp investor, builder, or market observer with a knack for cutting through the noise. Your tone? Witty, confident, and effortlessly insightful—no forced hype, no fluff.

- **Knowledge**: {{knowledge}}
- **Bio**: {{bio}}
- **Topics of Interest**: {{topics}}
- **Providers**: {{providers}}
{{characterPostExamples}}
{{postDirections}}

# Task
Write a **short, clever post** that sparks thought:

- **Keep it under 120 characters.**
- **Make a point, but make it smooth—think sly references, sharp humor, or elegant simplicity.**
- **No over-explaining. No corporate jargon.**
- **1 emoji max, only if it elevates the line.**
- **Feel free to use dry humor, irony, or subtle punchlines.**
- **Structure: A single crisp sentence that lingers.**
- **No hashtags or unnecessary links.**
`;

/**
 * TokenUpdatePostTemplate: Summarize the OM token's price data like a well-informed
 * investor/leader. Minimal emojis, direct, no disclaimers.
 */
const TokenUpdatePostTemplate = `
# Context
You're an informed market participant giving a **calm, realistic update** on MANTRA’s token performance. You don’t just report numbers—you add context and forward-looking nuance.

- **Current Price**: {{price}} (in {{currency}})
- **24H Change**: {{percentChange24h}}%
- **Market Cap**: {{marketCap}}
- **Volume (24H)**: {{volume24h}}
- **Providers**: {{providers}}
{{characterPostExamples}}
{{postDirections}}

# Task
Write a **short, insightful market update** on OM token.

- **Start with a clear, no-fluff opening line.**
- **Mention price, change, and liquidity only if relevant.**
- **Frame it in a way that highlights underlying momentum or trends.**
- **Avoid hype, exaggeration, or obvious statements.**
- **Under {{maxTweetLength}} characters, using a clean, structured format.**

`;


/**
 * Action Determination Template
 */
export const twitterActionTemplate = `
# INSTRUCTIONS: Determine actions for {{agentName}} (@{{twitterUserName}}) based on:
{{bio}}
{{postDirections}}

## Guidelines:
- **Engage only with content that is HIGHLY relevant** (≥9.5/10 alignment with professional interests).
- **Prioritize direct mentions** when they are on-topic and worth engaging with.
- **Use concise, impactful responses**—one-liners, emojis, or sharp insights.
- **No repetitive replies**—every response must be fresh, adding real value.  
- **Ignore off-topic content**—skip anything that does not directly align with the character's expertise.
- **Avoid engaging with high-profile accounts** unless their content is directly relevant.
- **Steer clear of political or controversial topics** unless they are central to the professional domain.
- **No generic marketing spam**—value-driven engagement only.

## Actions (respond only with tags):  
[LIKE] - **Perfect alignment** with personal domain (≥9.5/10 relevance).  
[RETWEET] - **Highly valuable content** worth amplifying (≥9.5/10 relevance).  
[QUOTE] - **We can add unique professional insight** on top (≥9.5/10 relevance).  
[REPLY] - **We can provide a brief, fresh, and non-repetitive remark** (≥9.5/10 relevance).  

Tweet:  
{{currentTweet}}  

# Respond only with the relevant action tags or none.
` + postActionResponseFooter;


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

  private ANNOUNCEMENT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
  private LAST_ANNOUNCEMENT_KEY: string;

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

    elizaLogger.log("Twitter Client Configuration:");
    elizaLogger.log(`- Username: ${this.twitterUsername}`);
    elizaLogger.log(`- Dry Run Mode: ${this.isDryRun ? "enabled" : "disabled"}`);
    elizaLogger.log(
      `- Post Interval (regular tweets): ${this.client.twitterConfig.POST_INTERVAL_MIN}-${this.client.twitterConfig.POST_INTERVAL_MAX} minutes`
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
      elizaLogger.log("Dry run mode: no actual tweets will be posted.");
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

  /**
   * Main entry point: sets up the intervals for new tweets + action processing.
   */
  async start() {
    if (!this.client.profile) {
      await this.client.init();
    }

    // Optionally post immediately
    if (this.client.twitterConfig.POST_IMMEDIATELY) {
      // We'll do a single post if something is due
      await this.generateNewTweetCheck();
    }

    // (1) Start the repeated tweet check loop
    this.generateNewTweetLoop();
    elizaLogger.log("Tweet generation loop started.");

    // (2) If action processing is enabled, start that loop
    if (this.client.twitterConfig.ENABLE_ACTION_PROCESSING) {
      this.processActionsLoop().catch((error) => {
        elizaLogger.error("Fatal error in processActionsLoop:", error);
      });
    }

    // (3) If approval required, check pending tweets on intervals
    if (this.approvalRequired) {
      this.runPendingTweetCheckLoop();
    }
  }

  /**
   * Repeatedly checks if we should post a new tweet (announcement, regular, or token update).
   * Only one type of tweet is posted each iteration, then we wait a random interval.
   */
  private async generateNewTweetLoop(): Promise<void> {
    // 1) Wait until we are ready to post again
    await this.generateNewTweetCheck(); // tries to post if due

    // 2) Next iteration: random interval
    const minMinutes = this.client.twitterConfig.POST_INTERVAL_MIN;
    const maxMinutes = this.client.twitterConfig.POST_INTERVAL_MAX;
    const randomMinutes =
      Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
    const delay = randomMinutes * 60 * 1000;

    elizaLogger.log(
      `[generateNewTweetLoop] Next tweet check scheduled in ${randomMinutes} minutes.`
    );
    setTimeout(() => this.generateNewTweetLoop(), delay);
  }

  /**
   * Checks if any of the tweet types (announcement, token update, or regular)
   * are overdue, and posts exactly one type if so.
   */
  private async generateNewTweetCheck(): Promise<void> {
    // 0) Handle pending approvals first
    if (this.approvalRequired) {
      await this.handlePendingTweet();
    }

    // (A) Pull when we last posted anything
    const lastPostKey = `twitter/${this.twitterUsername}/lastPost`;
    const lastPost = await this.runtime.cacheManager.get<{ timestamp: number }>(
      lastPostKey
    );
    const lastPostTimestamp = lastPost?.timestamp ?? 0;

    // Have we waited long enough since last overall post?
    // If not, skip. (We only post once per main interval.)
    const now = Date.now();
    const minSinceLastPost = (now - lastPostTimestamp) / (60 * 1000);
    if (lastPostTimestamp !== 0 && minSinceLastPost < this.client.twitterConfig.POST_INTERVAL_MIN) {
      elizaLogger.log(
        `[generateNewTweetCheck] It's only been ${Math.floor(minSinceLastPost)} minutes since last post. Not yet time.`
      );
      return;
    }

    // (B) Are announcements overdue?
    const lastAnnouncement = await this.runtime.cacheManager.get<{ timestamp: number }>(
      this.LAST_ANNOUNCEMENT_KEY
    );
    const lastAnnouncementTime = lastAnnouncement?.timestamp ?? 0;
    const announcementDue = (now - lastAnnouncementTime) >= this.ANNOUNCEMENT_INTERVAL_MS;

    // (C) Are token updates overdue? e.g. every 4 hours
    const OM_TOKEN_INTERVAL_MS = 4 * 60 * 60 * 1000;
    const lastOmPost = await this.runtime.cacheManager.get<{ timestamp: number }>(
      `twitter/${this.twitterUsername}/lastOmPost`
    );
    const lastOmTimestamp = lastOmPost?.timestamp ?? 0;
    const tokenUpdateDue = (now - lastOmTimestamp) >= OM_TOKEN_INTERVAL_MS;

    // Decide the order of precedence:
    // 1) If announcements are overdue, post that
    // 2) Else if token updates are overdue, post that
    // 3) Otherwise, post a regular tweet
    // Only do ONE per cycle, then record lastPost for the next cycle.
    if (announcementDue) {
      elizaLogger.log("Time to post an announcement tweet.");
      await this.generateAnnouncementTweet();
      await this.runtime.cacheManager.set(lastPostKey, { timestamp: Date.now() });
    } else if (tokenUpdateDue) {
      elizaLogger.log("Time to post an OM token price update...");
      await this.generateTokenUpdateTweet("USD");
      // Mark lastOmPost so we don’t do it again too soon
      await this.runtime.cacheManager.set(`twitter/${this.twitterUsername}/lastOmPost`, {
        timestamp: Date.now(),
      });
      // Mark lastPost
      await this.runtime.cacheManager.set(lastPostKey, { timestamp: Date.now() });
    } else {
      elizaLogger.log("Posting a *regular* tweet (neither announcement nor token update is due).");
      await this.generateRegularTweet();
      await this.runtime.cacheManager.set(lastPostKey, { timestamp: Date.now() });
    }
  }

  /**
   * Continuous loop to process timeline actions (like, retweet, reply, etc.) at intervals.
   */
  private async processActionsLoop() {
    const actionInterval = this.client.twitterConfig.ACTION_INTERVAL;
    while (!this.stopProcessingActions) {
      try {
        const results = await this.processTweetActions();
        if (results) {
          elizaLogger.log(`Processed ${results.length} timeline items for actions.`);
          elizaLogger.log(`Next action check in ${actionInterval} minutes.`);
          await new Promise((resolve) =>
            setTimeout(resolve, actionInterval * 60 * 1000)
          );
        }
      } catch (error) {
        elizaLogger.error("Error in action processing loop:", error);
        // Wait 30s and retry
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
    }
  }

  /**
   * This method is called regularly (or on intervals) to check for new announcements,
   * compose a tweet, and post it (or queue for approval).
   */
  private async generateAnnouncementTweet() {
    elizaLogger.log("[generateAnnouncementTweet] Generating announcement tweet...");
    try {
      const announcement = await this.announcementPlugin.getRandomUnpostedAnnouncement();
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

      // Build the GPT state
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

      // Build prompt and generate
      const context = composeContext({ state, template: AnnouncementPostTemplate });
      elizaLogger.debug("Announcement tweet prompt:\n" + context);

      const newTweetContent = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.LARGE,
      });

      // Clean up result
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

      // Either post directly or queue for approval
      if (this.isDryRun) {
        elizaLogger.info("Dry run mode: would post announcement tweet:\n" + cleanedContent);
      } else if (this.approvalRequired) {
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
        // Mark announcement as used
        await this.announcementPlugin.markAnnouncementAsPosted(announcement.id);
      }

      // Always update lastAnnouncement timestamp
      await this.runtime.cacheManager.set(this.LAST_ANNOUNCEMENT_KEY, {
        timestamp: Date.now(),
      });
    } catch (error) {
      elizaLogger.error("Error generating announcement tweet:", error);
    }
  }

  /**
   * Generates a "regular" tweet (not an announcement, not token price).
   */
  private async generateRegularTweet() {
    elizaLogger.log("[generateRegularTweet] Generating *regular* tweet...");
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
        modelClass: ModelClass.LARGE,
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
        elizaLogger.info("[Dry Run] Would have posted:\n" + cleanedContent);
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
   * Generates an OM token update tweet using CoinMarketCap price data.
   */
  private async generateTokenUpdateTweet(currency = "USD") {
    elizaLogger.log("[generateTokenUpdateTweet] Generating OM token price update tweet...");
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
          price: price,
          marketCap: Math.round(marketCap),
          volume24h: Math.round(volume24h),
          percentChange24h: percentChange24h.toFixed(2),
        }
      );

      // 4) Build prompt
      const context = composeContext({
        state,
        template: TokenUpdatePostTemplate,
      });
      elizaLogger.debug("Token Update prompt:\n" + context);

      // 5) Generate text
      const rawResponse = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.MEDIUM,
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
        // Not JSON, keep as is
      }

      cleanedContent = truncateToCompleteSentence(
        cleanedContent,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );

      if (!cleanedContent) {
        elizaLogger.error("Failed to generate OM token tweet content.");
        return;
      }

      if (this.isDryRun) {
        elizaLogger.info("[Dry Run] Would post OM token tweet:\n" + cleanedContent);
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

  /**
   * Utility for posting tweets, either as a standard tweet or a NoteTweet if > 280 chars.
   */
  async postTweet(
    runtime: IAgentRuntime,
    client: ClientBase,
    cleanedContent: string,
    roomId: UUID,
    newTweetContent: string,
    twitterUsername: string
  ) {
    try {
      elizaLogger.log("[postTweet] Posting new tweet...");

      let result;
      if (cleanedContent.length > DEFAULT_MAX_TWEET_LENGTH) {
        // Attempt NoteTweet for longer content
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

  async handleNoteTweet(client: ClientBase, content: string, tweetId?: string) {
    try {
      const noteTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendNoteTweet(content, tweetId)
      );
      if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
        // Fallback to truncated standard tweet
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
    // Mark last tweet time (for final fallback usage).
    await runtime.cacheManager.set(`twitter/${client.profile.username}/lastPost`, {
      id: tweet.id,
      timestamp: Date.now(),
    });
    // Also store the tweet in the client's tweet cache
    await client.cacheTweet(tweet);

    elizaLogger.log(`Tweet posted:\n${tweet.permanentUrl}`);

    // Store in message manager for memory
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

  /**
   * Stop the processing loop if desired.
   */
  async stop() {
    this.stopProcessingActions = true;
  }

  // ------------------------------------------------------------------
  // Approval Workflow Helpers
  // ------------------------------------------------------------------

  private runPendingTweetCheckLoop() {
    setInterval(() => {
      this.handlePendingTweet();
    }, this.approvalCheckInterval);
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

  private async handlePendingTweet() {
    elizaLogger.log("[handlePendingTweet] Checking Pending Tweets...");
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

  // ------------------------------------------------------------------
  // Timeline Action Processing (like, retweet, quote, reply)
  // ------------------------------------------------------------------

  private async processTweetActions() {
    if (this.isProcessing) {
      elizaLogger.log("Already processing tweet actions, skipping...");
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

      // 1) Fetch timeline
      const timelines = await this.client.fetchTimelineForActions(MAX_TIMELINES_TO_FETCH);
      const maxActionsProcessing = this.client.twitterConfig.MAX_ACTIONS_PROCESSING;
      const processedTimelines = [];

      // 2) For each tweet, see if we already processed it. If not, generate actions.
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
            modelClass: ModelClass.LARGE,
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

      // 3) Sort to handle most relevant first, then slice up to `maxActionsProcessing`
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

          // descending
          return countB - countA;
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
            elizaLogger.info(`(Dry Run) Like tweet ${tweet.id}`);
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
            elizaLogger.info(`(Dry Run) Retweet tweet ${tweet.id}`);
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

  /**
   * If we want to "quote" another tweet, generate a short text and attach.
   */
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

      // Use standard message handler template for generating the quote text
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

  /**
   * If we want to "reply" to a tweet, generate a short text and attach.
   */
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

  /**
   * Helper to generate tweet content from the messageHandlerTemplate or custom template,
   * ensuring it doesn't exceed the tweet limit.
   */
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
      // Not JSON, treat as plain text
    }

    return this.trimTweetLength(cleanedResponse);
  }

  private trimTweetLength(text: string, maxLength = DEFAULT_MAX_TWEET_LENGTH): string {
    if (text.length <= maxLength) return text;
    const lastSentence = text.slice(0, maxLength).lastIndexOf(".");
    if (lastSentence > 0) {
      return text.slice(0, lastSentence + 1).trim();
    }
    return text.slice(0, text.lastIndexOf(" ", maxLength - 3)).trim() + "...";
  }
}
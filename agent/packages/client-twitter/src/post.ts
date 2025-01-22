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
import { GiphyPlugin } from "./plugins/giphyPlugin.ts";


const MAX_TIMELINES_TO_FETCH = 15;

/**
 * Template used for posting announcement tweets
 */
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

/**
 * Template used for posting regular tweets (non-announcements)
 */
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

/**
 * The action template used when deciding to like/retweet/quote/reply.
 */
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

interface PendingTweet {
  cleanedContent: string;
  roomId: UUID;
  newTweetContent: string;
  discordMessageId: string;
  channelId: string;
  timestamp: number;
}

type PendingTweetApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

/**
 * Main TwitterPostClient, which:
 * 1. Posts an announcement tweet every 2 hours (via announcementPlugin).
 * 2. Uses a new template for regular tweets.
 * 3. Switches logic in the main loop to pick announcement or regular tweet.
 */
export class TwitterPostClient {
  client: ClientBase;
  runtime: IAgentRuntime;
  twitterUsername: string;

  // The plugin that supplies random unposted announcements
  announcementPlugin: AnnouncementsPlugin;
  GiphyPlugin: GiphyPlugin;

  private isProcessing = false;
  private lastProcessTime = 0;
  private stopProcessingActions = false;
  private isDryRun: boolean;
  private discordClientForApproval: Client;
  private approvalRequired = false;
  private discordApprovalChannelId: string;
  private approvalCheckInterval: number;

  // We'll require 2 hours (in ms) between announcement tweets
  private ANNOUNCEMENT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
  private LAST_ANNOUNCEMENT_KEY: string;

  private lastAnnouncementTime = 0;
  private lastRegularPostTime = 0;

  constructor(
    client: ClientBase,
    runtime: IAgentRuntime,
    announcementPlugin: AnnouncementsPlugin,
    giphyPlugin : GiphyPlugin,
  ) {
    this.client = client;
    this.runtime = runtime;
    this.twitterUsername = this.client.twitterConfig.TWITTER_USERNAME;
    this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
    this.announcementPlugin = announcementPlugin;
    this.GiphyPlugin = giphyPlugin;

    // We'll store the last announcement post time in the cache under this key
    this.LAST_ANNOUNCEMENT_KEY = `twitter/${this.twitterUsername}/lastAnnouncementPost`;

    // Log configuration
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
      const discordToken = this.runtime.getSetting(
        "TWITTER_APPROVAL_DISCORD_BOT_TOKEN"
      );
      const approvalChannelId = this.runtime.getSetting(
        "TWITTER_APPROVAL_DISCORD_CHANNEL_ID"
      );
      const APPROVAL_CHECK_INTERVAL =
        Number.parseInt(
          this.runtime.getSetting("TWITTER_APPROVAL_CHECK_INTERVAL")
        ) || 5 * 60 * 1000; // 5 minutes

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

      // Generate invite link with required permissions
      const invite = `https://discord.com/api/oauth2/authorize?client_id=${readyClient.user.id}&permissions=274877991936&scope=bot`;
      elizaLogger.log(
        `Use this link to properly invite the Twitter Post Approval Discord bot: ${invite}`
      );
    });

    // Login to Discord
    this.discordClientForApproval.login(discordToken);
  }

  async start() {
    if (!this.client.profile) {
      await this.client.init();
    }

    // Main loop for generating new tweets
    const generateNewTweetLoop = async () => {
      // First handle any pending approvals if needed
      if (this.approvalRequired) {
        await this.handlePendingTweet();
      }

      // Retrieve last regular tweet post time
      const lastPost = await this.runtime.cacheManager.get<{ timestamp: number }>(
        `twitter/${this.twitterUsername}/lastPost`
      );
      const lastPostTimestamp = lastPost?.timestamp ?? 0;

      // Random interval for regular tweets
      const minMinutes = this.client.twitterConfig.POST_INTERVAL_MIN;
      const maxMinutes = this.client.twitterConfig.POST_INTERVAL_MAX;
      const randomMinutes =
        Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
      const delay = randomMinutes * 60 * 1000;

      // Check if it's time to post
      if (Date.now() > lastPostTimestamp + delay) {
        // Decide if we should do an announcement or a regular tweet
        const shouldPostAnnouncement = await this.isAnnouncementDue();
        if (shouldPostAnnouncement) {
          elizaLogger.log("[TwitterPostClient] It's time to post an announcement tweet (2 hours have passed).");
          await this.generateAnnouncementTweet();
        } else {
          elizaLogger.log("[TwitterPostClient] Switching to *regular* mode (not yet time for an announcement).");
          await this.generateRegularTweet();
        }
      }

      // Schedule next iteration
      setTimeout(generateNewTweetLoop, delay);
      elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
    };

    // Action processing loop
    const processActionsLoop = async () => {
      const actionInterval = this.client.twitterConfig.ACTION_INTERVAL;

      while (!this.stopProcessingActions) {
        try {
          const results = await this.processTweetActions();
          if (results) {
            elizaLogger.log(`Processed ${results.length} tweets`);
            elizaLogger.log(
              `Next action processing scheduled in ${actionInterval} minutes`
            );
            // Sleep for the action interval
            await new Promise((resolve) =>
              setTimeout(resolve, actionInterval * 60 * 1000)
            );
          }
        } catch (error) {
          elizaLogger.error("Error in action processing loop:", error);
          await new Promise((resolve) => setTimeout(resolve, 30000)); // 30s backoff
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

    // Start the loops
    generateNewTweetLoop();
    elizaLogger.log("Tweet generation loop started");

    if (this.client.twitterConfig.ENABLE_ACTION_PROCESSING) {
      processActionsLoop().catch((error) => {
        elizaLogger.error("Fatal error in process actions loop:", error);
      });
    }

    // If approvals are enabled, run the pending tweet check
    if (this.approvalRequired) {
      this.runPendingTweetCheckLoop();
    }
  }

  private runPendingTweetCheckLoop() {
    setInterval(() => {
      this.handlePendingTweet();
    }, this.approvalCheckInterval);
  }

  /**
   * Determine if it's time to post an announcement (every 2 hours).
   */
  private async isAnnouncementDue(): Promise<boolean> {
    const lastAnnouncement = await this.runtime.cacheManager.get<{ timestamp: number }>(
      this.LAST_ANNOUNCEMENT_KEY
    );
    const lastTime = lastAnnouncement?.timestamp ?? 0;
    const now = Date.now();

    // If 2 hours have passed since last announcement
    return now - lastTime >= this.ANNOUNCEMENT_INTERVAL_MS;
  }

  /**
   * Generate and post an announcement tweet using the AnnouncementsPlugin.
   *
   * FIX: Even if no announcement is found, we update the timestamp so we don't
   * perpetually get "2 hours passed" on every loop.
   */
  private async generateAnnouncementTweet(): Promise<void> {
    elizaLogger.log("Generating *announcement* tweet...");

    try {
      const announcement =
        await this.announcementPlugin.getRandomUnpostedAnnouncement();

      // 1) If no announcement found, update LAST_ANNOUNCEMENT_KEY anyway:
      if (!announcement) {
        elizaLogger.log("No unposted announcements found. Skipping announcement tweet.");
        // Mark that we *attempted* an announcement, so we won't keep re-checking
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

      // Build state with the announcement text
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

      const context = composeContext({
        state,
        template: AnnouncementPostTemplate,
      });

      elizaLogger.debug("Announcement tweet prompt:\n" + context);

      const newTweetContent = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL,
      });

      // Clean up the content
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

      if (!cleanedContent) {
        elizaLogger.error("Failed to parse valid announcement content.", newTweetContent);
        return;
      }

      cleanedContent = truncateToCompleteSentence(
        cleanedContent,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );

      if (this.isDryRun) {
        elizaLogger.info(`Dry run: Would have posted announcement tweet: ${cleanedContent}`);
        // Still update the LAST_ANNOUNCEMENT_KEY so we don't repeatedly try.
        await this.runtime.cacheManager.set(this.LAST_ANNOUNCEMENT_KEY, {
          timestamp: Date.now(),
        });
        return;
      }

      if (this.approvalRequired) {
        // Send for approval
        elizaLogger.log("Sending announcement tweet for approval...");
        await this.sendForApproval(cleanedContent, roomId, newTweetContent);
      } else {
        // Immediately post
        elizaLogger.log("Posting announcement tweet:\n" + cleanedContent);
        await this.postTweet(
          this.runtime,
          this.client,
          cleanedContent,
          roomId,
          newTweetContent,
          this.twitterUsername
        );

        // Mark announcement posted
        await this.announcementPlugin.markAnnouncementAsPosted(announcement.id);
      }

      // 2) Update last-announcement timestamp AFTER we post or queue for approval
      await this.runtime.cacheManager.set(this.LAST_ANNOUNCEMENT_KEY, {
        timestamp: Date.now(),
      });
    } catch (error) {
      elizaLogger.error("Error generating announcement tweet:", error);
    }
  }

  /**
   * Generate and post a regular (non-announcement) tweet.
   */
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
      // Basic state for a regular tweet
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
          topics: this.runtime.character.topics.join(", "),
        }
      );

      const context = composeContext({
        state,
        template: RegularPostTemplate,
      });

      elizaLogger.debug("Regular tweet prompt:\n" + context);

      const newTweetContent = await generateText({
        runtime: this.runtime,
        context,
        modelClass: ModelClass.SMALL,
      });

      // Clean up
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

      if (!cleanedContent) {
        elizaLogger.error("Failed to parse valid content for regular tweet.", newTweetContent);
        return;
      }

      cleanedContent = truncateToCompleteSentence(
        cleanedContent,
        this.client.twitterConfig.MAX_TWEET_LENGTH
      );

      if (this.isDryRun) {
        elizaLogger.info(`Dry run: Would have posted regular tweet: ${cleanedContent}`);
        return;
      }

      if (this.approvalRequired) {
        elizaLogger.log("Sending regular tweet for approval...");
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
   * Helper method to create a Tweet object from the Twitter API response.
   */
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

  /**
   * Actually send the final tweet (standard or note tweet), then cache it.
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
      elizaLogger.log(`Posting new tweet...`);

      let result;
      if (cleanedContent.length > DEFAULT_MAX_TWEET_LENGTH) {
        // fallback to note tweet if content is too long
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

  /**
   * Submit a Note Tweet (if the account has it enabled), else fallback to standard tweet.
   */
  async handleNoteTweet(client: ClientBase, content: string, tweetId?: string) {
    try {
      const noteTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendNoteTweet(content, tweetId)
      );

      if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
        // If note tweet fails, fallback
        const truncateContent = truncateToCompleteSentence(
          content,
          this.client.twitterConfig.MAX_TWEET_LENGTH
        );
        return await this.sendStandardTweet(client, truncateContent, tweetId);
      } else {
        return noteTweetResult.data.notetweet_create.tweet_results.result;
      }
    } catch (error) {
      throw new Error(`Note Tweet failed: ${error}`);
    }
  }

  /**
   * Standard tweet post
   */
  async sendStandardTweet(client: ClientBase, content: string, tweetId?: string) {

    try {

      const standardTweetResult = await client.requestQueue.add(
        async () => await client.twitterClient.sendTweet(content, tweetId)
      );
      const body = await standardTweetResult.json();
      if (!body?.data?.create_tweet?.tweet_results?.result) {
        console.error("Error sending tweet; Bad response:", body);
        return;
      }
      return body.data.create_tweet.tweet_results.result;
    } catch (error) {
      elizaLogger.error("Error sending standard Tweet:", error);
      throw error;
    }
  }

  /**
   * Once we have posted the tweet, record it in cache and memory.
   */
  async processAndCacheTweet(
    runtime: IAgentRuntime,
    client: ClientBase,
    tweet: Tweet,
    roomId: UUID,
    newTweetContent: string
  ) {
    // Cache last post time
    await runtime.cacheManager.set(`twitter/${client.profile.username}/lastPost`, {
      id: tweet.id,
      timestamp: Date.now(),
    });

    // Cache the tweet itself
    await client.cacheTweet(tweet);

    // Log
    elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

    // Ensure room and participant
    await runtime.ensureRoomExists(roomId);
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

    // Create memory
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
   * Stop action-processing loop
   */
  async stop() {
    this.stopProcessingActions = true;
  }

  /**
   * Check if there's a pending tweet for approval, etc.
   */
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
          {
            name: "Character",
            value: this.client.profile.username,
            inline: true,
          },
          {
            name: "Length",
            value: cleanedContent.length.toString(),
            inline: true,
          },
        ],
        footer: {
          text: "Reply with '👍' to post or '❌' to discard. This will automatically expire after 24 hours if no response is received.",
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

      // Store the pending tweet
      const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
      const currentPendingTweets =
        (await this.runtime.cacheManager.get<PendingTweet[]>(pendingTweetsKey)) ||
        [];
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
      elizaLogger.error("Error Sending Twitter Post Approval Request:", error);
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

      // Check reactions
      const thumbsUpReaction = message.reactions.cache.find(
        (reaction) => reaction.emoji.name === "👍"
      );
      const rejectReaction = message.reactions.cache.find(
        (reaction) => reaction.emoji.name === "❌"
      );

      if (rejectReaction && rejectReaction.count > 0) {
        return "REJECTED";
      }
      if (thumbsUpReaction && thumbsUpReaction.count > 0) {
        return "APPROVED";
      }

      return "PENDING";
    } catch (error) {
      elizaLogger.error("Error checking approval status:", error);
      return "PENDING";
    }
  }

  private async cleanupPendingTweet(discordMessageId: string) {
    const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
    const currentPendingTweets =
      (await this.runtime.cacheManager.get<PendingTweet[]>(pendingTweetsKey)) ||
      [];

    const updatedPendingTweets = currentPendingTweets.filter(
      (pt) => pt.discordMessageId !== discordMessageId
    );

    if (updatedPendingTweets.length === 0) {
      await this.runtime.cacheManager.delete(pendingTweetsKey);
    } else {
      await this.runtime.cacheManager.set(pendingTweetsKey, updatedPendingTweets);
    }
  }

  /**
   * Periodically checks if pending tweets have been approved/rejected, or expired.
   */
  private async handlePendingTweet() {
    elizaLogger.log("Checking Pending Tweets...");
    const pendingTweetsKey = `twitter/${this.client.profile.username}/pendingTweet`;
    const pendingTweets =
      (await this.runtime.cacheManager.get<PendingTweet[]>(pendingTweetsKey)) ||
      [];

    for (const pendingTweet of pendingTweets) {
      const isExpired = Date.now() - pendingTweet.timestamp > 24 * 60 * 60 * 1000;
      if (isExpired) {
        elizaLogger.log("Pending tweet expired, cleaning up");

        // Optionally notify Discord
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(
              pendingTweet.discordMessageId
            );
            await originalMessage.reply(
              "This tweet approval request has expired (24h timeout)."
            );
          }
        } catch (err) {
          elizaLogger.error("Error sending expiration notification:", err);
        }

        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
        return;
      }

      // Check approval status
      elizaLogger.log("Checking approval status...");
      const approvalStatus = await this.checkApprovalStatus(
        pendingTweet.discordMessageId
      );

      if (approvalStatus === "APPROVED") {
        elizaLogger.log("Tweet Approved, Posting");
        await this.postTweet(
          this.runtime,
          this.client,
          pendingTweet.cleanedContent,
          pendingTweet.roomId,
          pendingTweet.newTweetContent,
          this.twitterUsername
        );

        // If these are announcements, you'd need to store the announcementId in PendingTweet
        // to call markAnnouncementAsPosted(announcementId)

        // Notify on Discord about posting
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(
              pendingTweet.discordMessageId
            );
            await originalMessage.reply("Tweet has been posted successfully! ✅");
          }
        } catch (error) {
          elizaLogger.error("Error sending post notification:", error);
        }

        await this.cleanupPendingTweet(pendingTweet.discordMessageId);
      } else if (approvalStatus === "REJECTED") {
        elizaLogger.log("Tweet Rejected, Cleaning Up");
        await this.cleanupPendingTweet(pendingTweet.discordMessageId);

        // Notify about Rejection
        try {
          const channel = await this.discordClientForApproval.channels.fetch(
            pendingTweet.channelId
          );
          if (channel instanceof TextChannel) {
            const originalMessage = await channel.messages.fetch(
              pendingTweet.discordMessageId
            );
            await originalMessage.reply("Tweet has been rejected! ❌");
          }
        } catch (error) {
          elizaLogger.error("Error sending rejection notification:", error);
        }
      }
    }
  }

  /**
   * Processes timeline for possible likes/retweets/quotes/replies.
   */
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
          // Skip if we've already processed this tweet
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
            elizaLogger.log(`No valid actions generated for tweet ${tweet.id}`);
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
          continue;
        }
      }

      const sortProcessedTimeline = (arr: typeof processedTimelines) => {
        return arr.sort((a, b) => {
          // Count how many "true" values in actionResponse
          const countTrue = (obj: typeof a.actionResponse) =>
            Object.values(obj).filter(Boolean).length;

          const countA = countTrue(a.actionResponse);
          const countB = countTrue(b.actionResponse);

          // Sort descending by count
          if (countA !== countB) {
            return countB - countA;
          }

          // Secondary sort by "like"
          if (a.actionResponse.like !== b.actionResponse.like) {
            return a.actionResponse.like ? -1 : 1;
          }

          return 0;
        });
      };

      // Sort and limit
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

  /**
   * Execute the decided actions (like, retweet, quote, reply) on the tweets.
   */
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

        // Like
        if (actionResponse.like) {
          if (this.isDryRun) {
            elizaLogger.info(`Dry run: would have liked tweet ${tweet.id}`);
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

        // Retweet
        if (actionResponse.retweet) {
          if (this.isDryRun) {
            elizaLogger.info(`Dry run: would have retweeted tweet ${tweet.id}`);
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

        // Quote
        if (actionResponse.quote) {
          try {
            const result = await this.handleQuoteAction(tweet);
            if (result) executedActions.push("quote");
          } catch (error) {
            elizaLogger.error("Error in quote tweet generation:", error);
          }
        }

        // Reply
        if (actionResponse.reply) {
          try {
            await this.handleTextOnlyReply(tweet, tweetState, executedActions);
          } catch (error) {
            elizaLogger.error(`Error replying to tweet ${tweet.id}:`, error);
          }
        }

        // Record the memory for this tweet
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

        results.push({
          tweetId: tweet.id,
          actionResponse,
          executedActions,
        });
      } catch (error) {
        elizaLogger.error(`Error processing tweet ${tweet.id}:`, error);
        continue;
      }
    }

    return results;
  }

  /**
   * Handle generating/ sending a quote tweet for a given tweet.
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

      // If images exist, describe them
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
          content: {
            text: tweet.text,
            action: "QUOTE",
          },
        },
        {
          twitterUserName: this.twitterUsername,
          currentPost: `From @${tweet.username}: ${tweet.text}`,
          formattedConversation,
          imageContext:
            imageDescriptions.length > 0
              ? `\nImages in Tweet:\n${imageDescriptions
                  .map((desc, i) => `Image ${i + 1}: ${desc}`)
                  .join("\n")}`
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
        elizaLogger.info(
          `Dry run: would have posted a quote tweet for ID ${tweet.id}:\n${quoteContent}`
        );
        return true;
      }

      // Post it
      const result = await this.client.requestQueue.add(
        async () =>
          await this.client.twitterClient.sendQuoteTweet(quoteContent, tweet.id)
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
   * For text-only reply to a tweet
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
              ? `\nImages in Tweet:\n${imageDescriptions
                  .map((desc, i) => `Image ${i + 1}: ${desc}`)
                  .join("\n")}`
              : "",
          quotedContent,
        }
      );

      // Generate the reply text
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
        elizaLogger.info(`Dry run: would have replied: ${replyText}`);
        executedActions.push("reply (dry run)");
        return;
      }

      elizaLogger.debug("Final reply text to be sent:", replyText);

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
   * Generate tweet content with optional template override
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
    elizaLogger.debug("generate tweet content response:\n" + response);

    // Cleanup
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
      elizaLogger.debug("Response is not JSON, treating as plain text");
    }

    return this.trimTweetLength(cleanedResponse);
  }

  /**
   * Simple helper to trim a tweet to maxLength, respecting sentence boundaries if possible.
   */
  private trimTweetLength(text: string, maxLength = 280): string {
    if (text.length <= maxLength) return text;

    const lastSentence = text.slice(0, maxLength).lastIndexOf(".");
    if (lastSentence > 0) {
      return text.slice(0, lastSentence + 1).trim();
    }

    // fallback at word boundary
    return text.slice(0, text.lastIndexOf(" ", maxLength - 3)).trim() + "...";
  }
}

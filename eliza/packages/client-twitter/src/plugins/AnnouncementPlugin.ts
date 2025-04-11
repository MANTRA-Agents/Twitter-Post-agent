import { Plugin, elizaLogger, IAgentRuntime, generateText, ModelClass } from "@elizaos/core";
import { AnnouncementProvider } from "@elizaos-plugins/plugin-browser";

/**
 * Enhanced Announcement interface with tracking capabilities
 */
export interface Announcement {
  id: string;                  // Unique identifier
  content: string;             // Announcement text
  source: "twitter" | "website";
  timestamp: number;           // When discovered
  date: string;                // Parsed date in YYYY-MM-DD format
  title?: string;              // Optional title extracted from content
  posted?: boolean;            // Track if announcement has been posted
  lastPosted?: number;         // Timestamp of last post
}

interface AnnouncementsPluginConfig {
  twitterHandle?: string;
  websiteUrl?: string;
  minAnnouncementAge?: number;  // Minimum age of announcement to be eligible for posting (in hours)
  maxAnnouncementAge?: number;  // Maximum age of announcement to be eligible for posting (in days)
}



/**
 * Enhanced Plugin that manages announcements with tracking capabilities
 */
export class AnnouncementsPlugin implements Plugin {
  name = "AnnouncementsPlugin";
  description = "Monitors and manages announcements with tracking capabilities";

  private provider: AnnouncementProvider;
  private runtime?: IAgentRuntime;
  public config: AnnouncementsPluginConfig;

  /**
   * An in-memory map of announcements keyed by their ID.
   * This allows quick lookups for posted/unposted status.
   */
  private announcementsMap: Map<string, Announcement>;
  /**
   * Timestamp of the last time we refreshed announcements from the source.
   */
  private lastRefreshed: number;

  /**
   * How often we want to refresh announcements (30 minutes by default).
   * In milliseconds: 30 * 60 * 1000 = 1,800,000 ms
   */
  private refreshIntervalMs = 30 * 60 * 1000;

  constructor(runtime: IAgentRuntime) {
    this.provider = new AnnouncementProvider();
    this.runtime = runtime;
    this.config = {
      minAnnouncementAge: 1, // 1 hour minimum
      maxAnnouncementAge: 30 // 30 days maximum
    };
    this.announcementsMap = new Map<string, Announcement>();
    this.lastRefreshed = 0; // means "never refreshed yet"
  }

  init(params: { pluginConfig?: AnnouncementsPluginConfig; runtime: IAgentRuntime }): void {
    this.runtime = params.runtime;
    if (params.pluginConfig) {
      this.config = { ...this.config, ...params.pluginConfig };
    }

    // Optionally do an initial refresh
    this.refreshAnnouncementsMap().catch(err => {
      elizaLogger.error("[AnnouncementsPlugin] Error refreshing announcements map:", err);
    });
  }

  /**
   * Only refresh announcements if at least 30 minutes have passed since the last refresh.
   */
  private async maybeRefreshAnnouncements(): Promise<void> {
    if (!this.runtime) {
      elizaLogger.error("[AnnouncementsPlugin] Runtime not initialized.");
      return;
    }

    const now = Date.now();
    // Check if 30 minutes have elapsed since lastRefreshed
    if (now - this.lastRefreshed < this.refreshIntervalMs) {
      // Not enough time passed, skip refresh
      return;
    }

    // Otherwise, do a full refresh
    await this.refreshAnnouncementsMap();
  }

  /**
   * Refresh the in-memory announcements map from the data source + cache
   */
  private async refreshAnnouncementsMap(): Promise<void> {
    if (!this.runtime) {
      elizaLogger.error("[AnnouncementsPlugin] Runtime not initialized.");
      return;
    }

    try {
      // Get fresh list from provider
      const rawContent = await this.provider.get(this.runtime, null, null);
      const allAnnouncements = this.parseAnnouncementsFromContent(rawContent);

      // Fetch posted status from cache
      const postedStatus =
        (await this.runtime.cacheManager.get<Announcement[]>("announcements/posted_status")) ||
        [];

      // Clear the map and repopulate
      this.announcementsMap.clear();

      for (const announcement of allAnnouncements) {
        // Find any previously cached data for this announcement
        const cached = postedStatus.find((pst) => pst.id === announcement.id);
        if (cached) {
          announcement.posted = cached.posted;
          announcement.lastPosted = cached.lastPosted;
        }
        this.announcementsMap.set(announcement.id, announcement);
      }

      // Update lastRefreshed timestamp
      this.lastRefreshed = Date.now();

      elizaLogger.log("[AnnouncementsPlugin] Announcements successfully refreshed.");
    } catch (error) {
      elizaLogger.error("[AnnouncementsPlugin] Error building announcements map:", error);
    }
  }

  /**
   * Get a random unposted announcement within the acceptable age range,
   * but only refresh if at least 30 minutes have passed.
   */
  public async getRandomUnpostedAnnouncement(): Promise<Announcement | null> {
    await this.maybeRefreshAnnouncements(); // Only refresh if needed

    // Filter announcements based on posting status and age
    const currentTime = Date.now();
    const announcementsArray = Array.from(this.announcementsMap.values());
    const eligibleAnnouncements = announcementsArray.filter((announcement) => {
      if (announcement.posted) return false;

      const announcementTime = new Date(announcement.date).getTime();
      const ageInHours = (currentTime - announcementTime) / (1000 * 60 * 60);
      const ageInDays = ageInHours / 24;

      return (
        ageInHours >= (this.config.minAnnouncementAge ?? 1) &&
        ageInDays <= (this.config.maxAnnouncementAge ?? 30)
      );
    });

    if (eligibleAnnouncements.length === 0) {
      return null;
    }

    // Select random announcement
    const randomIndex = Math.floor(Math.random() * eligibleAnnouncements.length);
    return eligibleAnnouncements[randomIndex];
  }

  /**
   * Mark an announcement as posted
   */
  public async markAnnouncementAsPosted(announcementId: string): Promise<void> {
    if (!this.runtime) {
      elizaLogger.error("[AnnouncementsPlugin] Runtime not initialized.");
      return;
    }

    try {
      // Update the in-memory map
      const announcement = this.announcementsMap.get(announcementId);
      if (announcement) {
        announcement.posted = true;
        announcement.lastPosted = Date.now();
        this.announcementsMap.set(announcementId, announcement);
      }

      // Update the cache
      await this.persistPostedStatuses();
    } catch (error) {
      elizaLogger.error("[AnnouncementsPlugin] Error marking announcement as posted:", error);
    }
  }

  /**
   * Get all announcements with their posting status (from internal map),
   * but only refresh if at least 30 minutes have passed.
   */
  public async getAnnouncements(): Promise<Announcement[]> {
    await this.maybeRefreshAnnouncements();
    // Return them sorted by date or however you wish
    return Array.from(this.announcementsMap.values()).sort((a, b) => {
      return b.timestamp - a.timestamp; // newest first
    });
  }

  /**
   * Get all *unposted* announcements, possibly refreshing if needed
   */
  public async getAllUnpostedAnnouncements(): Promise<Announcement[]> {
    await this.maybeRefreshAnnouncements();
    return Array.from(this.announcementsMap.values()).filter((a) => !a.posted);
  }

  /**
   * A utility to mark *all* unposted announcements as posted (or you can
   * actually perform the post operation here if you prefer).
   */
  public async postAllAnnouncements(): Promise<void> {
    // We can refresh here or skip it if you want the immediate state
    await this.maybeRefreshAnnouncements();
    const unposted = await this.getAllUnpostedAnnouncements();

    for (const announcement of unposted) {

      await this.markAnnouncementAsPosted(announcement.id);
    }
  }

  /**
   * Store the posted statuses in the cache, preserving existing fields
   */
  private async persistPostedStatuses(): Promise<void> {
    if (!this.runtime) return;
    const allAnnouncements = Array.from(this.announcementsMap.values());
    await this.runtime.cacheManager.set("announcements/posted_status", allAnnouncements);
  }

  /**
   * Parse announcements from raw content
   */
  private parseAnnouncementsFromContent(content: string): Announcement[] {
    try {
      const sections = content.split("\n\n");
      return sections
        .filter((section) => section.trim())
        .map((section) => {
          const dateMatch = section.match(/(\d{4}-\d{2}-\d{2})/);
          const date = dateMatch
            ? dateMatch[1]
            : new Date().toISOString().split("T")[0];

          const source = section.toLowerCase().includes("twitter")
            ? "twitter"
            : "website";

          return {
            id: this.generateAnnouncementId(section),
            content: section.trim(),
            source,
            date,
            timestamp: new Date(date).getTime(),
            title: this.extractTitle(section),
            posted: false,
          };
        });


    } catch (error) {
      elizaLogger.error("[AnnouncementsPlugin] Error parsing announcements:", error);
      return [];
    }
  }


  private createSummaryOfContent(content: string): Promise<string>{
    try {
      const sections = content.split("\n\n");
      const annoucements =  sections
        .filter((section) => section.trim())
        .map((section) => {
          const dateMatch = section.match(/(\d{4}-\d{2}-\d{2})/);
          const date = dateMatch
            ? dateMatch[1]
            : new Date().toISOString().split("T")[0];

          const source = section.toLowerCase().includes("twitter")
            ? "twitter"
            : "website";

          return {
            id: this.generateAnnouncementId(section),
            content: section.trim(),
            source,
            date,
            timestamp: new Date(date).getTime(),
            title: this.extractTitle(section),
            posted: false,
          };
        });

     const prompt =    `
     ${annoucements}
    You are an experience crypto analyist and investor your task is to analyze all the incoming news
    about Mantra chain provide a nice summary of the news and also provide a sentiment analysis of the news
    provide your comments as an experienced crypto analyst.
 `

        const summary = generateText({
            runtime : this.runtime,
            context : prompt,
            modelClass : ModelClass.MEDIUM

        })


        return summary;
    } catch (error) {
      elizaLogger.error("[AnnouncementsPlugin] Error parsing announcements:", error);

    }
  }

  private generateAnnouncementId(content: string): string {
    const dateMatch = content.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : new Date().toISOString().split("T")[0];
    const snippet = content.slice(0, 32).replace(/[^a-z0-9]/gi, "");
    return `${date}-${snippet}`;
  }

  private extractTitle(content: string): string {
    const titleMatch = content.match(/^([^.:]+)(?:[.:]|$)/);
    return titleMatch ? titleMatch[1].trim() : "";
  }

  cleanup(): void {
    elizaLogger.log("[AnnouncementsPlugin] Cleanup complete.");
  }
}

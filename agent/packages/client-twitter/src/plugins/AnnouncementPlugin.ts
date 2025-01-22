import { Plugin, elizaLogger, IAgentRuntime } from "@elizaos/core";
import { AnnouncementProvider } from "@elizaos/plugin-node";

/**
 * A single Announcement item
 */
export interface Announcement {
  id: string;             // Unique identifier
  content: string;        // Announcement text
  source: "twitter" | "website";
  timestamp: number;      // When discovered
}

interface AnnouncementsPluginConfig {
  // (Optional) If you still want to configure these, you can keep them:
  twitterHandle?: string;
  websiteUrl?: string;
}

/**
 * Plugin that:
 *  - Fetches Twitter & website announcements from the provider on demand
 *  - Returns them immediately via `getAnnouncements()`
 *  - Does not store announcements locally or in localStorage
 *  - No cron job / scheduling
 */
export class AnnouncementsPlugin implements Plugin {
  name = "AnnouncementsPlugin";
  description = "Monitors Twitter and website for announcements (no storage, no cron)";

  private config: AnnouncementsPluginConfig = {
    twitterHandle: "MANTRA_Chain",
    websiteUrl: "https://www.mantrachain.io/resources/announcements",
  };

  private provider: AnnouncementProvider;
  private runtime?: IAgentRuntime;

  constructor(runtime:IAgentRuntime) {
    this.provider = new AnnouncementProvider();
    this.runtime = runtime
  }

  /**
   * Initialize the plugin. If you want, you can accept config overrides.
   */
  init(params: { pluginConfig?: AnnouncementsPluginConfig; runtime: IAgentRuntime }): void {
    this.runtime = params.runtime;

    // Merge config if desired
    if (params.pluginConfig) {
      this.config = { ...this.config, ...params.pluginConfig };
    }

    elizaLogger.log("[AnnouncementsPlugin] Initialized with config:", this.config);
  }

  /**
   * Fetch fresh announcements from Twitter & website each time it's called.
   * Returns them as an array of `Announcement` objects.
   */
  public async getAnnouncements(): Promise<Announcement[]> {
    if (!this.runtime) {
      elizaLogger.error("[AnnouncementsPlugin] Runtime not initialized.");
      return [];
    }

    try {
      // 1) Fetch combined text from the provider
      const rawContent = await this.provider.get(this.runtime, null, null);

      // 2) Convert to structured announcements
      const announcements = this.parseAnnouncementsFromContent(rawContent);

      // 3) Return them directly
      return announcements;
    } catch (error) {
      elizaLogger.error("[AnnouncementsPlugin] Error fetching announcements:", error);
      return [];
    }
  }

  /**
   * Convert raw text into an array of Announcement objects.
   * Each "\n\n" block becomes one item.
   */
  private parseAnnouncementsFromContent(content: string): Announcement[] {
    const sections = content.split("\n\n");
    const results: Announcement[] = [];

    for (const section of sections) {
      const trimmed = section.trim();
      if (!trimmed) continue;

      const source = trimmed.toLowerCase().includes("twitter") ? "twitter" : "website";

      results.push({
        id: this.generateAnnouncementId(trimmed),
        content: trimmed,
        source,
        timestamp: Date.now(),
      });
    }
    return results;
  }

  /**
   * Generate a basic ID from the content snippet + current time
   */
  private generateAnnouncementId(content: string): string {
    const snippet = content.slice(0, 32).replace(/[^a-z0-9]/gi, "");
    return `${Date.now()}-${snippet}`;
  }

  /**
   * No cleanup needed in this version (no intervals, no storage).
   */
  cleanup(): void {
    elizaLogger.log("[AnnouncementsPlugin] Cleanup complete (nothing to do).");
  }
}

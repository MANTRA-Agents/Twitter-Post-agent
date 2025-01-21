import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    ActionExample,
    elizaLogger,
    composeContext,
} from "@elizaos/core";
import { getMantraAnnouncementsTemplate } from "../templates";
import { ModelClass } from "@elizaos/core";
import { generateObject } from "@elizaos/core";
import { AnnouncementResultSchema, isAnnouncementResult } from "../types";
import { AnnouncementProvider } from "../providers/InformationProvider";

export const fetchMANTRAUpdates: Action = {
    name: "FETCH_MANTRA_UPDATES",
    similes: [
        "GET_MANTRA_NEWS",
        "CHECK_MANTRA_UPDATES",
        "SHOW_MANTRA_NEWS",
        "VIEW_MANTRA_ANNOUNCEMENTS",
        "READ_MANTRA_UPDATES",
        "DISPLAY_MANTRA_NEWS",
        "LIST_MANTRA_ANNOUNCEMENTS",
        "FIND_MANTRA_UPDATES"
    ],

    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        return true;
    },

    description: "Fetch and display the latest news, updates, and announcements from MANTRA Chain's official sources including Twitter, website, and other social media platforms",

    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: {
            filter?: string;
            maxCount?: number;
            source?: string[];
            timeframe?: 'day' | 'week' | 'month';
        } = {},
        callback?: HandlerCallback
    ): Promise<boolean> => {
        try {
            const getMantraAnnouncementsContext = composeContext({
                state,
                template: getMantraAnnouncementsTemplate,
            });

            const AnnouncementsObject = await generateObject({
                runtime,
                context: getMantraAnnouncementsContext,
                modelClass: ModelClass.SMALL,
                schema: AnnouncementResultSchema,
                stop: ["\n"],
            });

            if (!isAnnouncementResult(AnnouncementsObject?.object)) {
                elizaLogger.error("Failed to generate MANTRA Chain updates");
                return false;
            }

            const announcementProvider = new AnnouncementProvider();
            const announcements = await announcementProvider.get(runtime, message, state);

            if (!announcements) {
                throw new Error("Failed to fetch MANTRA Chain updates");
            }

            await runtime.messageManager.createMemory({
                userId: message.agentId,
                agentId: message.agentId,
                roomId: message.roomId,
                content: {
                    text: announcements,
                }
            });

            if (callback) {
                callback({
                    text: announcements,
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error in fetchMANTRAUpdates handler:", error);

            if (callback) {
                callback({
                    text: "I apologize, but I encountered an error while fetching the latest MANTRA Chain updates. Please try again in a few moments.",
                    error: error instanceof Error ? error.message : "Unknown error"
                });
            }

            return false;
        }
    },

    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you show me the latest MANTRA Chain news?",
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll gather the latest MANTRA Chain updates for you...",
                    action: "FETCH_MANTRA_UPDATES"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Here are the latest updates from MANTRA Chain:\n\n🔥 New Partnership Announcement: MANTRA Chain partners with leading DeFi protocol\n📈 Network Statistics: 500k+ transactions processed this week\n🚀 Product Update: Enhanced staking features now live\n\nWould you like me to elaborate on any of these updates?"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's the latest development with MANTRA Chain?",
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Let me fetch the recent developments...",
                    action: "FETCH_MANTRA_UPDATES"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Here are the latest developments from MANTRA Chain:\n\n⚡️ Technical Update: New blockchain optimization released\n🌐 Community Growth: Reached 100k active users milestone\n💼 Governance Update: New proposal voting starts tomorrow\n\nWould you like more details about any of these developments?"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Any important announcements from MANTRA today?",
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll check today's MANTRA Chain announcements...",
                    action: "FETCH_MANTRA_UPDATES"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Today's important announcements from MANTRA Chain:\n\n📢 Security Update: Successfully completed quarterly audit\n🤝 Community Event: AMA session scheduled for next week\n💫 Network Achievement: New TVL milestone reached\n\nLet me know if you'd like more information about any of these announcements!"
                }
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What happened with MANTRA Chain this week?",
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll retrieve this week's MANTRA Chain updates...",
                    action: "FETCH_MANTRA_UPDATES"
                }
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Here's a summary of this week's MANTRA Chain activities:\n\n📊 Market Update: New trading pairs added\n🔄 Protocol Upgrade: Enhanced cross-chain capabilities\n👥 Team Update: New advisory board member announced\n\nWould you like to know more about any of these updates?"
                }
            }
        ]
    ] as ActionExample[][]
} as Action;
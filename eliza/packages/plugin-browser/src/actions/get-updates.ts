import {
    Action,
    IAgentRuntime,
    Memory,
    State,
    HandlerCallback,
    ActionExample,
    elizaLogger,
    generateText,

} from "@elizaos/core";

import { AnnouncementProvider } from "../providers/InformationProvider";
import { ModelClass } from "@elizaos/core";





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
            const announcementProvider = new AnnouncementProvider();
            const announcements = await announcementProvider.get(runtime, message, state);
            if (!announcements) {
                throw new Error("Failed to fetch MANTRA Chain updates");
            }

            const prompt = `
            You are a full-fledged, hype-chasing crypto degen who’s all about alpha leaks, moonshots, and FOMO. You’ve been following MANTRA since day one and keep tabs on every single update—from official announcements to Telegram whispers, Discord alpha drops, and late-night Twitter Spaces. You’ve got the inside track on what’s really going on with MANTRA, but you also understand that even the most promising projects can stumble without the right execution.
            
            Here’s the latest batch of MANTRA announcements. Analyze them, break them down like a true degen, and explain why they’re bullish for the community (or not). Provide your raw, hype-fueled take, but also be fair about possible risks or concerns. Speak casually and enthusiastically, as if you’re chatting with fellow believers in a Telegram group, but avoid excessive jargon. Keep it real, keep it fun, and remember to clarify that none of this is financial advice.
            
            Announcements:
            ${announcements}
            
            Your task:
            1. Summarize these MANTRA announcements in your own words—what’s new, what’s interesting, and why should the community care?
            2. Provide your take on the potential impact of these updates on MANTRA’s ecosystem, token holders, and prospective investors.
            3. Point out any possible risks, pitfalls, or challenges ahead (dev issues, market conditions, etc.).
            4. Conclude with your personal, degenerate hot take: are you bullish, cautiously optimistic, or on the fence? Remember to disclaim it’s just your opinion, not financial advice.
            
            Keep the tone hype, relatable, and conversational, but grounded in the fact you genuinely follow and care about MANTRA. Let’s see if these announcements are about to send our bags to the moon, or if we should manage our expectations like responsible degens. Go for it!
            `;
            

             const response = await generateText({
                runtime,
                context: prompt,
                modelClass: ModelClass.LARGE,
              });
            

            await runtime.messageManager.createMemory({
                userId: message.agentId,
                agentId: message.agentId,
                roomId: message.roomId,
                content: {
                    text: response,
                }
            });

            if (callback) {
                callback({
                    text: response,
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
import {type Evaluator, type IAgentRuntime, type Memory, type State } from "@elizaos/core";

export class InformationEvaluator implements Evaluator {
    name = "MANTRA_NEWS_EVALUATOR";
    similes = ["updates", "what are the updates", "get updates" , "recent news"];
    description = "Evaluates messages for token price requests";

    async validate(runtime: IAgentRuntime, message: Memory): Promise<boolean> {
        const content = typeof message.content === 'string'
            ? message.content
            : message.content?.text;

        if (!content) return false;

        // Check for price-related keywords
        const hasNewsKeyword = /\b(news|updates|recent news|announcements|partnerships|collaborations )\b/i.test(content);

        // Look for either:
        // 1. Ethereum address
        // 2. Token symbol starting with $ or #
        // 3. Token symbol after "of" or "for" (case insensitive)


        return hasNewsKeyword



    }

    async handler(_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string> {
        return "FETCH_ANNOUNCEMENTS";
    }

    examples = [
        {
            context: "User asking for recent updates about the mantra ecosystem",
            messages: [
                {
                    user: "{{user}}",
                    content: {
                        text: "What are the recent updates in the mantra ecosystem",
                        action: "FETCH_ANNOUNCEMENTS"
                    }
                }
            ],
            outcome: "FETCH_ANNOUNCEMENTS"
        },
        {
            context: "User asking about recent announcements",
            messages: [
                {
                    user: "{{user}}",
                    content: {
                        text: "Can you tell me about the recent announcements",
                        action: "FETCH_ANNOUNCEMENTS"
                    }
                }
            ],
            outcome: "FETCH_ANNOUNCEMENTS"
        },

    ];
}

export const informationEvaluator = new InformationEvaluator();
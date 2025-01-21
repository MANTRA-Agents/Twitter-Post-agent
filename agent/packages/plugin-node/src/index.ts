export * from "./services/index.ts";

import { Plugin } from "@elizaos/core";

import { describeImage } from "./actions/describe-image.ts";
import { fetchMANTRAUpdates } from "./actions/get-updates.ts";
export * from "./actions/get-updates.ts";

import {
    AwsS3Service,
    BrowserService,
    ImageDescriptionService,
    LlamaService,
    PdfService,
    SpeechService,
    TranscriptionService,
    VideoService,
} from "./services/index.ts";

export type NodePlugin = ReturnType<typeof createNodePlugin>;


export function createNodePlugin() {
    return {
        name: "default",
        description: "Default plugin, with basic actions and evaluators",
        services: [
            new BrowserService(),
            new ImageDescriptionService(),
            new LlamaService(),
            new PdfService(),
            new SpeechService(),
            new TranscriptionService(),
            new VideoService(),
            new AwsS3Service(),
        ],
        actions: [describeImage , fetchMANTRAUpdates],
    } as const satisfies Plugin;
}

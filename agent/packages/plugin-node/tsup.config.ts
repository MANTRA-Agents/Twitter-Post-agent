import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"],
    external: [
        // Node.js built-ins
        "stream",
        "http",
        "https",
        "net",
        "tls",
        "events",
        "url",
        "zlib",
        "util",
        "buffer",
        "crypto",
        "fs",
        "path",
        "os",
        "ws",
        "child_process",
        "worker_threads",
        // WebRTC related
        "@roamhq/wrtc",
        "wrtc",
        "node-webrtc",
        // Your existing externals
        "dotenv",
        "@reflink/reflink",
        "@node-llama-cpp",
        "agentkeepalive",
        "zod",
        // Add your heavy dependencies
        "playwright",
        "puppeteer-extra",
        "sharp",
        "node-llama-cpp",
        "onnxruntime-node"
    ],
    platform: 'node',
    target: 'node23',
    noExternal: [], // Ensure this is empty or remove it
    treeshake: true,
    splitting: true,
    skipNodeModulesBundle: true,
    esbuildOptions(options) {
        options.conditions = ['import', 'node', 'default']
        options.mainFields = ['module', 'main']
    }
});
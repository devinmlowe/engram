import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // First run downloads the embedding + reranker models from Hugging Face
    // (hundreds of MB). Give beforeAll/afterAll hooks room for a cold cache.
    hookTimeout: 120_000,
    // Suites isolate env with vi.stubEnv(key, undefined) in beforeEach; this
    // restores every stubbed variable before each test, so no restore loops.
    unstubEnvs: true,
    // Claude Code creates isolated agent worktrees under .claude/worktrees/;
    // never collect their (possibly mid-experiment) test files from the main checkout.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // First run downloads the embedding + reranker models from Hugging Face
    // (hundreds of MB). Give beforeAll/afterAll hooks room for a cold cache.
    hookTimeout: 120_000,
  },
});

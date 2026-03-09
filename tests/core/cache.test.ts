import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LRUCache } from "../../src/_core/cache/index.js";

describe("LRUCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic get/set", () => {
    it("stores and retrieves values", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 60000,
      });
      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.get("a")).toBe(1);
      expect(cache.get("b")).toBe(2);
    });

    it("returns undefined for missing keys", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 60000,
      });
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("tracks size correctly", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 60000,
      });
      expect(cache.size).toBe(0);
      cache.set("a", 1);
      expect(cache.size).toBe(1);
      cache.set("b", 2);
      expect(cache.size).toBe(2);
    });

    it("overwrites existing entries", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 60000,
      });
      cache.set("a", 1);
      cache.set("a", 99);
      expect(cache.get("a")).toBe(99);
      expect(cache.size).toBe(1);
    });
  });

  describe("has", () => {
    it("returns true for existing, non-expired keys", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 60000,
      });
      cache.set("a", 1);
      expect(cache.has("a")).toBe(true);
    });

    it("returns false for missing keys", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 60000,
      });
      expect(cache.has("a")).toBe(false);
    });

    it("returns false for expired keys", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 1000,
      });
      cache.set("a", 1);
      vi.advanceTimersByTime(1500);
      expect(cache.has("a")).toBe(false);
    });
  });

  describe("invalidate", () => {
    it("removes a specific entry", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 60000,
      });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.invalidate("a");
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
      expect(cache.size).toBe(1);
    });

    it("is a no-op for missing keys", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 60000,
      });
      cache.invalidate("nonexistent"); // should not throw
      expect(cache.size).toBe(0);
    });
  });

  describe("clear", () => {
    it("removes all entries", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 60000,
      });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get("a")).toBeUndefined();
    });
  });

  describe("LRU eviction", () => {
    it("evicts least-recently-used entry when maxSize exceeded", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 3,
        ttlMs: 60000,
      });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      // Cache is full: [a, b, c]

      cache.set("d", 4);
      // "a" should be evicted as LRU: [b, c, d]
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
      expect(cache.get("d")).toBe(4);
      expect(cache.size).toBe(3);
    });

    it("refreshes LRU position on get", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 3,
        ttlMs: 60000,
      });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);

      // Access "a" to refresh it — now LRU order is [b, c, a]
      cache.get("a");

      cache.set("d", 4);
      // "b" should be evicted (was LRU): [c, a, d]
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("a")).toBe(1);
      expect(cache.get("c")).toBe(3);
      expect(cache.get("d")).toBe(4);
    });

    it("refreshes LRU position on set of existing key", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 3,
        ttlMs: 60000,
      });
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);

      // Re-set "a" — now LRU order is [b, c, a]
      cache.set("a", 99);

      cache.set("d", 4);
      // "b" should be evicted: [c, a, d]
      expect(cache.get("b")).toBeUndefined();
      expect(cache.get("a")).toBe(99);
    });
  });

  describe("TTL expiration", () => {
    it("expires entries after TTL on get", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 5000,
      });
      cache.set("a", 1);

      // Not expired yet
      vi.advanceTimersByTime(3000);
      expect(cache.get("a")).toBe(1);

      // Now expired
      vi.advanceTimersByTime(3000); // 6000ms total
      expect(cache.get("a")).toBeUndefined();
    });

    it("cleans up expired entries from size count on access", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 1000,
      });
      cache.set("a", 1);
      expect(cache.size).toBe(1);

      vi.advanceTimersByTime(1500);
      cache.get("a"); // triggers cleanup
      expect(cache.size).toBe(0);
    });

    it("does not return expired entries via has", () => {
      const cache = new LRUCache<string, number>({
        maxSize: 10,
        ttlMs: 1000,
      });
      cache.set("a", 1);

      vi.advanceTimersByTime(1500);
      expect(cache.has("a")).toBe(false);
    });
  });

  describe("works with non-string keys", () => {
    it("supports number keys", () => {
      const cache = new LRUCache<number, string>({
        maxSize: 10,
        ttlMs: 60000,
      });
      cache.set(42, "answer");
      expect(cache.get(42)).toBe("answer");
    });
  });
});

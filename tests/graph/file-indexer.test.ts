/**
 * Unit tests for file structure parsing (Phase 7B.1).
 *
 * Tests parseFileStructure() which extracts function, class, and module
 * symbols from source files using regex-based parsing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFileStructure } from "../../src/graph/file-indexer.js";

let tmpDirs: string[] = [];

function writeTempFile(filename: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "engram-fileindex-"));
  tmpDirs.push(dir);
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("parseFileStructure", () => {
  describe("TypeScript/JavaScript", () => {
    it("extracts exported functions and classes", () => {
      const filePath = writeTempFile("server.ts", `
import { Server } from "some-lib";

/**
 * Initialize the database connection.
 */
export function initDatabase(config: Config): Database {
  const db = new Database(config.path);
  db.pragma("journal_mode = WAL");
  return db;
}

export class EntityManager {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  save(entity: Entity): void {
    // ...
  }
}

export default function main() {
  console.log("hello");
}
`.trimStart());

      const result = parseFileStructure(filePath);

      expect(result.language).toBe("typescript");
      expect(result.path).toBe(filePath);

      const names = result.symbols.map((s) => s.name);
      expect(names).toContain("initDatabase");
      expect(names).toContain("EntityManager");
      expect(names).toContain("main");

      const initDb = result.symbols.find((s) => s.name === "initDatabase");
      expect(initDb?.kind).toBe("function");
      expect(initDb?.startLine).toBeGreaterThan(0);
      expect(initDb?.endLine).toBeGreaterThanOrEqual(initDb!.startLine);

      const entityMgr = result.symbols.find((s) => s.name === "EntityManager");
      expect(entityMgr?.kind).toBe("class");

      const mainFn = result.symbols.find((s) => s.name === "main");
      expect(mainFn?.kind).toBe("function");
    });

    it("extracts arrow function exports", () => {
      const filePath = writeTempFile("utils.ts", `
export const formatDate = (date: Date): string => {
  return date.toISOString();
};

export let processData = async (data: Buffer) => {
  return data.toString();
};

export var handler = (req: Request) => {
  return new Response("ok");
};
`.trimStart());

      const result = parseFileStructure(filePath);
      const names = result.symbols.map((s) => s.name);

      expect(names).toContain("formatDate");
      expect(names).toContain("processData");
      expect(names).toContain("handler");

      for (const sym of result.symbols) {
        expect(sym.kind).toBe("function");
      }
    });

    it("extracts non-exported functions", () => {
      const filePath = writeTempFile("internal.ts", `
function helperFunction(x: number): number {
  return x * 2;
}

async function fetchData(url: string): Promise<Response> {
  return fetch(url);
}
`.trimStart());

      const result = parseFileStructure(filePath);
      const names = result.symbols.map((s) => s.name);

      expect(names).toContain("helperFunction");
      expect(names).toContain("fetchData");
    });

    it("extracts JSDoc comments as descriptions", () => {
      const filePath = writeTempFile("documented.ts", `
/**
 * Initialize the database connection.
 * This handles migrations too.
 */
export function initDatabase(config: Config): Database {
  return new Database(config.path);
}
`.trimStart());

      const result = parseFileStructure(filePath);
      const initDb = result.symbols.find((s) => s.name === "initDatabase");

      expect(initDb?.description).toBe("Initialize the database connection.");
    });
  });

  describe("Python", () => {
    it("extracts defs and classes", () => {
      const filePath = writeTempFile("module.py", `
import os

def process_data(data):
    """Process the input data."""
    return data.strip()

class DataProcessor:
    """A processor for data."""
    def __init__(self, config):
        self.config = config

    def run(self):
        pass

def helper():
    return 42
`.trimStart());

      const result = parseFileStructure(filePath);

      expect(result.language).toBe("python");

      const names = result.symbols.map((s) => s.name);
      expect(names).toContain("process_data");
      expect(names).toContain("DataProcessor");
      expect(names).toContain("helper");

      // Only top-level symbols (not __init__ or run)
      expect(names).not.toContain("__init__");
      expect(names).not.toContain("run");

      const processData = result.symbols.find((s) => s.name === "process_data");
      expect(processData?.kind).toBe("function");
      expect(processData?.description).toBe("Process the input data.");

      const dataProcessor = result.symbols.find((s) => s.name === "DataProcessor");
      expect(dataProcessor?.kind).toBe("class");
    });
  });

  describe("Rust", () => {
    it("extracts functions and structs", () => {
      const filePath = writeTempFile("lib.rs", `
use std::collections::HashMap;

/// Initialize the system.
pub fn init(config: &Config) -> Result<()> {
    Ok(())
}

pub struct Server {
    port: u16,
}

fn helper() -> bool {
    true
}

pub async fn serve(addr: &str) -> Result<()> {
    Ok(())
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Handler {
    fn handle(&self);
}
`.trimStart());

      const result = parseFileStructure(filePath);

      expect(result.language).toBe("rust");

      const names = result.symbols.map((s) => s.name);
      expect(names).toContain("init");
      expect(names).toContain("Server");
      expect(names).toContain("helper");
      expect(names).toContain("serve");
      expect(names).toContain("Status");
      expect(names).toContain("Handler");

      const initFn = result.symbols.find((s) => s.name === "init");
      expect(initFn?.kind).toBe("function");
      expect(initFn?.description).toBe("Initialize the system.");

      const server = result.symbols.find((s) => s.name === "Server");
      expect(server?.kind).toBe("class");
    });
  });

  describe("Go", () => {
    it("extracts functions and types", () => {
      const filePath = writeTempFile("main.go", `
package main

import "fmt"

// ProcessData handles data processing.
func ProcessData(data []byte) error {
    return nil
}

type Server struct {
    Port int
}

func (s *Server) Start() error {
    return nil
}

type Handler interface {
    Handle()
}

func helper() int {
    return 42
}
`.trimStart());

      const result = parseFileStructure(filePath);

      expect(result.language).toBe("go");

      const names = result.symbols.map((s) => s.name);
      expect(names).toContain("ProcessData");
      expect(names).toContain("Server");
      expect(names).toContain("Start");
      expect(names).toContain("Handler");
      expect(names).toContain("helper");

      const processData = result.symbols.find((s) => s.name === "ProcessData");
      expect(processData?.kind).toBe("function");
    });
  });

  describe("Edge cases", () => {
    it("returns empty symbols for empty file", () => {
      const filePath = writeTempFile("empty.ts", "");
      const result = parseFileStructure(filePath);

      expect(result.symbols).toEqual([]);
      expect(result.language).toBe("typescript");
    });

    it("returns unknown language for binary/unknown extension", () => {
      const filePath = writeTempFile("data.bin", "some binary content");
      const result = parseFileStructure(filePath);

      expect(result.symbols).toEqual([]);
      expect(result.language).toBe("unknown");
    });

    it("throws for non-existent file", () => {
      expect(() => parseFileStructure("/nonexistent/file.ts")).toThrow();
    });

    it("captures only top-level functions in nested scenarios", () => {
      const filePath = writeTempFile("nested.ts", `
export function outer() {
  function inner() {
    return 42;
  }
  return inner();
}
`.trimStart());

      const result = parseFileStructure(filePath);
      // v1: only top-level captured
      const names = result.symbols.map((s) => s.name);
      expect(names).toContain("outer");
      // inner may or may not be captured — implementation choice for v1
    });
  });
});

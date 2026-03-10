/**
 * File structure indexer for knowledge graph (Phase 7B.1).
 *
 * Parses source files to extract function, class, and module definitions,
 * then indexes them as entities with "contains" relationships. Enables
 * RLM to discover file contents without reading the full file.
 */

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { insertEntity, getEntityByName, updateEntity } from "./entity.js";
import { findOrCreateRelationship } from "./relationship.js";
import type { Entity, EntityType } from "./types.js";
import { insertVector } from "../_core/db/index.js";

// ─── Interfaces ──────────────────────────────────────────────────

export interface FileSymbol {
  name: string;
  kind: "function" | "class" | "module";
  startLine: number;
  endLine: number;
  description?: string;
}

export interface ParseResult {
  path: string;
  language: string;
  symbols: FileSymbol[];
}

export interface IndexResult {
  entitiesCreated: number;
  relationshipsCreated: number;
}

// ─── Language Detection ──────────────────────────────────────────

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    default:
      return "unknown";
  }
}

// ─── Brace-Based End Detection ──────────────────────────────────

/**
 * Find the end line for a symbol by tracking brace depth from startLine.
 * Returns the line number (1-based) where depth returns to 0.
 */
function findBraceEnd(lines: string[], startLineIdx: number): number {
  let depth = 0;
  let foundOpen = false;

  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        foundOpen = true;
      } else if (ch === "}") {
        depth--;
        if (foundOpen && depth === 0) {
          return i + 1; // 1-based
        }
      }
    }
  }

  // Fallback: return last line
  return lines.length;
}

// ─── Python Indentation-Based End Detection ─────────────────────

/**
 * Find the end line for a Python def/class by tracking indentation.
 */
function findIndentEnd(lines: string[], startLineIdx: number): number {
  const startLine = lines[startLineIdx];
  const startIndent = startLine.length - startLine.trimStart().length;

  for (let i = startLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Skip blank lines
    if (line.trim() === "") continue;

    const indent = line.length - line.trimStart().length;
    if (indent <= startIndent) {
      return i; // 1-based (previous line was the last)
    }
  }

  return lines.length;
}

// ─── JSDoc / Docstring Extraction ───────────────────────────────

/**
 * Extract the first meaningful line from a JSDoc comment block
 * immediately preceding the given line.
 */
function extractJsDoc(lines: string[], startLineIdx: number): string | undefined {
  // Look backwards from startLineIdx for a JSDoc block ending with */
  for (let i = startLineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed === "*/") continue;
    if (trimmed.startsWith("/**") || trimmed.startsWith("* ") || trimmed.startsWith("*")) {
      // Check if this is the end of a JSDoc block — search for the start
      break;
    }
    // Non-JSDoc line between symbol and any potential JSDoc — no doc
    return undefined;
  }

  // Now find the JSDoc block
  let blockEnd = -1;
  for (let i = startLineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (trimmed.endsWith("*/") || trimmed === "*/") {
      blockEnd = i;
      break;
    }
    break; // Non-comment, non-blank line
  }

  if (blockEnd < 0) return undefined;

  // Find block start
  let blockStart = blockEnd;
  for (let i = blockEnd; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("/**")) {
      blockStart = i;
      break;
    }
    if (!trimmed.startsWith("*") && trimmed !== "*/") break;
    blockStart = i;
  }

  // Extract first meaningful line
  for (let i = blockStart; i <= blockEnd; i++) {
    let trimmed = lines[i].trim();
    // Remove JSDoc markers
    trimmed = trimmed.replace(/^\/\*\*\s*/, "").replace(/\*\/\s*$/, "").replace(/^\*\s*/, "").trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

/**
 * Extract Python docstring from the line after a def/class.
 */
function extractPythonDocstring(lines: string[], startLineIdx: number): string | undefined {
  // Look for triple-quote on the next non-blank line after the def/class line
  for (let i = startLineIdx + 1; i < lines.length && i <= startLineIdx + 2; i++) {
    const trimmed = lines[i].trim();
    // Single-line docstring: """text""" or '''text'''
    const singleMatch = trimmed.match(/^(?:"""|''')(.+?)(?:"""|''')$/);
    if (singleMatch) {
      return singleMatch[1].trim();
    }
    // Multi-line docstring start
    const multiMatch = trimmed.match(/^(?:"""|''')(.*)$/);
    if (multiMatch) {
      const firstLine = multiMatch[1].trim();
      return firstLine.length > 0 ? firstLine : undefined;
    }
  }
  return undefined;
}

/**
 * Extract Rust doc comment (///) from lines preceding the symbol.
 */
function extractRustDoc(lines: string[], startLineIdx: number): string | undefined {
  for (let i = startLineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("///")) {
      return trimmed.replace(/^\/\/\/\s*/, "").trim();
    }
    if (trimmed === "") continue;
    break;
  }
  return undefined;
}

/**
 * Extract Go doc comment (//) from lines preceding the symbol.
 */
function extractGoDoc(lines: string[], startLineIdx: number): string | undefined {
  for (let i = startLineIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) {
      return trimmed.replace(/^\/\/\s*/, "").trim();
    }
    if (trimmed === "") continue;
    break;
  }
  return undefined;
}

// ─── Language-Specific Parsers ──────────────────────────────────

interface RawSymbol {
  name: string;
  kind: "function" | "class" | "module";
  lineIdx: number; // 0-based
}

function parseTypeScript(lines: string[]): RawSymbol[] {
  const symbols: RawSymbol[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Exported function (including default and async)
    let match = line.match(/export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/);
    if (match && !seen.has(`${match[1]}-${i}`)) {
      symbols.push({ name: match[1], kind: "function", lineIdx: i });
      seen.add(`${match[1]}-${i}`);
      continue;
    }

    // Class (exported or not)
    match = line.match(/(?:export\s+)?(?:default\s+)?class\s+(\w+)/);
    if (match && !seen.has(`${match[1]}-${i}`)) {
      symbols.push({ name: match[1], kind: "class", lineIdx: i });
      seen.add(`${match[1]}-${i}`);
      continue;
    }

    // Arrow function exports
    match = line.match(/export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
    if (match && !seen.has(`${match[1]}-${i}`)) {
      symbols.push({ name: match[1], kind: "function", lineIdx: i });
      seen.add(`${match[1]}-${i}`);
      continue;
    }

    // Non-exported function (including async)
    match = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (match && !seen.has(`${match[1]}-${i}`)) {
      // Check we haven't already captured this line as an exported function
      const alreadyCaptured = symbols.some(
        (s) => s.name === match![1] && s.lineIdx === i,
      );
      if (!alreadyCaptured) {
        symbols.push({ name: match[1], kind: "function", lineIdx: i });
        seen.add(`${match[1]}-${i}`);
      }
    }
  }

  return symbols;
}

function parsePython(lines: string[]): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Only top-level definitions (no leading whitespace)
    let match = line.match(/^def\s+(\w+)/);
    if (match) {
      symbols.push({ name: match[1], kind: "function", lineIdx: i });
      continue;
    }

    match = line.match(/^class\s+(\w+)/);
    if (match) {
      symbols.push({ name: match[1], kind: "class", lineIdx: i });
    }
  }

  return symbols;
}

function parseRust(lines: string[]): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let match = line.match(/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
    if (match) {
      symbols.push({ name: match[1], kind: "function", lineIdx: i });
      continue;
    }

    match = line.match(/(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/);
    if (match) {
      symbols.push({ name: match[1], kind: "class", lineIdx: i });
    }
  }

  return symbols;
}

function parseGo(lines: string[]): RawSymbol[] {
  const symbols: RawSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let match = line.match(/func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/);
    if (match) {
      symbols.push({ name: match[1], kind: "function", lineIdx: i });
      continue;
    }

    match = line.match(/type\s+(\w+)\s+(?:struct|interface)/);
    if (match) {
      symbols.push({ name: match[1], kind: "class", lineIdx: i });
    }
  }

  return symbols;
}

// ─── Main Parse Function ────────────────────────────────────────

export function parseFileStructure(filePath: string): ParseResult {
  const language = detectLanguage(filePath);

  if (language === "unknown") {
    return { path: filePath, language, symbols: [] };
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  if (content.trim() === "") {
    return { path: filePath, language, symbols: [] };
  }

  // Get raw symbols based on language
  let rawSymbols: RawSymbol[];
  switch (language) {
    case "typescript":
    case "javascript":
      rawSymbols = parseTypeScript(lines);
      break;
    case "python":
      rawSymbols = parsePython(lines);
      break;
    case "rust":
      rawSymbols = parseRust(lines);
      break;
    case "go":
      rawSymbols = parseGo(lines);
      break;
    default:
      rawSymbols = [];
  }

  // Compute end lines and extract docs
  const isBraceBased = language !== "python";
  const symbols: FileSymbol[] = rawSymbols.map((raw, idx) => {
    const startLine = raw.lineIdx + 1; // 1-based

    // Determine end line
    let endLine: number;
    if (isBraceBased) {
      endLine = findBraceEnd(lines, raw.lineIdx);
    } else {
      endLine = findIndentEnd(lines, raw.lineIdx);
    }

    // Ensure endLine doesn't extend past next symbol's start
    if (idx < rawSymbols.length - 1) {
      const nextStart = rawSymbols[idx + 1].lineIdx + 1;
      if (endLine >= nextStart) {
        endLine = nextStart - 1;
      }
    }

    // Extract documentation
    let description: string | undefined;
    switch (language) {
      case "typescript":
      case "javascript":
        description = extractJsDoc(lines, raw.lineIdx);
        break;
      case "python":
        description = extractPythonDocstring(lines, raw.lineIdx);
        break;
      case "rust":
        description = extractRustDoc(lines, raw.lineIdx);
        break;
      case "go":
        description = extractGoDoc(lines, raw.lineIdx);
        break;
    }

    return {
      name: raw.name,
      kind: raw.kind,
      startLine,
      endLine,
      description,
    };
  });

  return { path: filePath, language, symbols };
}

// ─── Graph Indexing ─────────────────────────────────────────────

/**
 * Generate a zero embedding of the correct dimension.
 * Used for file structure entities that don't need semantic search.
 */
function zeroEmbedding(dims = 256): number[] {
  return new Array(dims).fill(0);
}

/**
 * Create a deterministic ID for a file entity.
 */
function fileEntityId(filePath: string): string {
  // Simple hash: use the path itself as a stable key
  return `file-${Buffer.from(filePath).toString("base64url").slice(0, 32)}`;
}

/**
 * Create a deterministic ID for a symbol entity.
 */
function symbolEntityId(filePath: string, symbolName: string, kind: string): string {
  const key = `${filePath}:${kind}:${symbolName}`;
  return `sym-${Buffer.from(key).toString("base64url").slice(0, 32)}`;
}

/**
 * Index a source file's structure into the knowledge graph.
 *
 * Creates a file entity and symbol entities with "contains" relationships.
 * Idempotent: re-indexing the same file updates existing entities.
 */
export function indexFileStructure(
  db: Database.Database,
  filePath: string,
): IndexResult {
  const parsed = parseFileStructure(filePath);
  const now = Math.floor(Date.now() / 1000);
  let entitiesCreated = 0;
  let relationshipsCreated = 0;

  const fileName = basename(filePath);

  // 1. Create or update file entity
  const fileId = fileEntityId(filePath);
  const existingFile = db
    .prepare("SELECT id FROM entities WHERE id = ?")
    .get(fileId) as { id: string } | undefined;

  if (!existingFile) {
    const fileEntity: Entity = {
      id: fileId,
      name: fileName,
      type: "file",
      description: filePath,
      aliases: [],
      firstSeen: now,
      lastSeen: now,
      mentionCount: 1,
      createdAt: now,
    };
    insertEntity(db, fileEntity, zeroEmbedding());
    entitiesCreated++;
  } else {
    updateEntity(db, fileId, { lastSeen: now });
  }

  // 2. Create symbol entities and relationships
  for (const symbol of parsed.symbols) {
    const symId = symbolEntityId(filePath, symbol.name, symbol.kind);
    const descParts = [`${symbol.kind} in ${fileName}:${symbol.startLine}-${symbol.endLine}`];
    if (symbol.description) {
      descParts.push(symbol.description);
    }

    const existingSym = db
      .prepare("SELECT id FROM entities WHERE id = ?")
      .get(symId) as { id: string } | undefined;

    if (!existingSym) {
      const symEntity: Entity = {
        id: symId,
        name: symbol.name,
        type: symbol.kind as EntityType,
        description: descParts.join(" — "),
        aliases: [],
        firstSeen: now,
        lastSeen: now,
        mentionCount: 1,
        createdAt: now,
      };
      insertEntity(db, symEntity, zeroEmbedding());
      entitiesCreated++;
    } else {
      updateEntity(db, symId, {
        lastSeen: now,
        description: descParts.join(" — "),
      });
    }

    // 3. Create "contains" relationship from file to symbol
    const existingRel = db
      .prepare(
        "SELECT id FROM relationships WHERE source_entity_id = ? AND target_entity_id = ? AND type = ?",
      )
      .get(fileId, symId, "contains") as { id: string } | undefined;

    if (!existingRel) {
      findOrCreateRelationship(db, fileId, symId, "contains", `${fileName} contains ${symbol.kind} ${symbol.name}`);
      relationshipsCreated++;
    }
  }

  return { entitiesCreated, relationshipsCreated };
}

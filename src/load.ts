// Loads and validates the data files, hashes files and text, and reads a .env file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { CatalogSchema, RfqFileSchema, TruthFileSchema } from "./contracts.ts";
import type { Catalog, Rfq, RfqTruth } from "./contracts.ts";
import { PATHS } from "./paths.ts";

// Errors name the file by its base name only, so no absolute path can reach an event or a recording.
function readValidated<T>(path: string, schema: z.ZodType<T>): T {
  const name = basename(path);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "read error";
    throw new Error(`${name}: cannot read the file (${code})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name}: not valid JSON (${(err as Error).message})`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new Error(`${name}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The catalog, zod-validated. Defaults to the committed snapshot. */
export function loadCatalog(path?: string): Catalog {
  return readValidated(path ?? PATHS.catalog, CatalogSchema);
}

/** The RFQs of an RFQ file. Defaults to the tuned set. */
export function loadRfqs(path?: string): Rfq[] {
  return readValidated(path ?? PATHS.rfqs, RfqFileSchema).rfqs;
}

/** The labels of a truth file. Defaults to the tuned set. Truth never reaches the agent. */
export function loadTruth(path?: string): RfqTruth[] {
  return readValidated(path ?? PATHS.truth, TruthFileSchema).truth;
}

/** sha256 of the file's bytes, first 12 hex characters. */
export function fileHash(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "read error";
    throw new Error(`${basename(path)}: cannot read the file (${code})`);
  }
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Reads a .env file. Returns {} when the file is missing, and leaves out empty values, so an
 * `ANTHROPIC_API_KEY=` line copied from .env.example never blanks a key set in the shell.
 */
export function readDotEnv(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${basename(path)}: cannot read the file`);
  }
  const out: Record<string, string> = {};
  // A file saved by Windows PowerShell starts with a byte order mark, which would glue itself to the first key.
  for (const [key, value] of Object.entries(parseEnv(raw.replace(/^﻿/, "")))) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

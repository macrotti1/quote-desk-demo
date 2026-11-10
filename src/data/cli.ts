// npm run data writes the five data files; npm run data:check regenerates them and byte-compares.
// Messages name files relative to the repo root, never by absolute path.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { repoRelative } from "../paths.ts";
import { snapshotFiles } from "./generate.ts";
import type { SnapshotFile } from "./generate.ts";

/** What main touches, so a test can run every branch against in-memory files. */
export type CliIo = {
  files: () => SnapshotFile[];
  /** The file's current text, or null when it doesn't exist. */
  read: (path: string) => string | null;
  write: (path: string, text: string) => void;
  out: (text: string) => void;
  err: (text: string) => void;
};

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export const DISK_IO: CliIo = {
  files: snapshotFiles,
  read: readOrNull,
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  },
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Exit code: 0 done, 1 a data file is missing or differs (the first one is named), 2 usage. */
export function main(argv: string[], io: CliIo = DISK_IO): number {
  const command = argv[0];
  if (command === "write") {
    for (const file of io.files()) {
      io.write(file.path, file.text);
      io.out(`wrote ${repoRelative(file.path)}\n`);
    }
    return 0;
  }
  if (command === "check") {
    const files = io.files();
    for (const file of files) {
      const current = io.read(file.path);
      if (current === null) {
        io.err(`${repoRelative(file.path)} is missing; run npm run data\n`);
        return 1;
      }
      if (current !== file.text) {
        io.err(`${repoRelative(file.path)} differs from a fresh generation; run npm run data\n`);
        return 1;
      }
    }
    io.out(`data:check ok, ${files.length} files match a fresh generation\n`);
    return 0;
  }
  io.err("usage: node src/data/cli.ts write | check\n");
  return 2;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));

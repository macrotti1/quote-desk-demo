// The Claude Code plugin: its two manifests and the demo Skill. Reads files only.
// No model, no network, no `claude` process, and nothing here reads process.env.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PATHS } from "../src/paths.ts";
import { readRecording } from "../src/recording.ts";

const ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
const PLUGIN_FILE = join(PATHS.root, ".claude-plugin", "plugin.json");
const MARKET_FILE = join(PATHS.root, ".claude-plugin", "marketplace.json");
const SKILL_FILE = join(PATHS.root, "skills", "demo", "SKILL.md");
const FILES = [PLUGIN_FILE, MARKET_FILE, SKILL_FILE];
// En dash and em dash, built from code points so this file stays ASCII.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

type Json = Record<string, unknown>;

const text = (file: string): string => readFileSync(file, "utf8");
const json = (file: string): Json => JSON.parse(text(file)) as Json;
const obj = (value: unknown, what: string): Json => {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${what} is an object`);
  return value as Json;
};

function packageJson(): { version: string; scripts: Record<string, string> } {
  return JSON.parse(text(join(PATHS.root, "package.json"))) as { version: string; scripts: Record<string, string> };
}

function copyrightHolder(): string {
  const match = /^Copyright \(c\) \d{4} (.+)$/m.exec(text(join(PATHS.root, "LICENSE")));
  assert.ok(match?.[1] !== undefined, "LICENSE has a copyright line");
  return match[1].trim();
}

/** Splits SKILL.md into its frontmatter fields and its body. Handles the flat keys and one-level lists it uses. */
function readSkill(): { fields: Record<string, string | string[]>; body: string } {
  const raw = text(SKILL_FILE);
  assert.ok(raw.startsWith("---\n"), "SKILL.md opens with a frontmatter marker on line 1");
  const end = raw.indexOf("\n---\n", 4);
  assert.ok(end > 0, "SKILL.md closes its frontmatter");
  const fields: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const line of raw.slice(4, end).split("\n")) {
    const item = /^ {2}- (.+)$/.exec(line);
    if (item?.[1] !== undefined && listKey !== undefined) {
      const list = fields[listKey];
      if (Array.isArray(list)) list.push(item[1]);
      continue;
    }
    const pair = /^([a-z][a-z-]*):(?: (.*))?$/.exec(line);
    assert.ok(pair?.[1] !== undefined, `frontmatter line parses: ${line}`);
    const value = (pair[2] ?? "").trim();
    if (value === "") {
      fields[pair[1]] = [];
      listKey = pair[1];
    } else {
      fields[pair[1]] = value.replace(/^"(.*)"$/, "$1");
      listKey = undefined;
    }
  }
  return { fields, body: raw.slice(end + 5) };
}

test("plugin.json: name, version from package.json, author from LICENSE, synthetic data", () => {
  const plugin = json(PLUGIN_FILE);
  assert.equal(plugin["name"], "quote-desk");
  assert.equal(plugin["version"], packageJson().version);
  const author = obj(plugin["author"], "author");
  assert.deepEqual(Object.keys(author), ["name"], "author carries the name only");
  assert.equal(author["name"], copyrightHolder());
  assert.equal(typeof plugin["description"], "string");
  assert.match(String(plugin["description"]), /synthetic/);
});

test("plugin.json: the catalog server starts with node on src/mcp/stdio.ts, with no fault flag", () => {
  const servers = obj(json(PLUGIN_FILE)["mcpServers"], "mcpServers");
  assert.deepEqual(Object.keys(servers), ["catalog"]);
  const catalog = obj(servers["catalog"], "catalog");
  assert.equal(catalog["command"], "node");
  assert.deepEqual(catalog["args"], [`${ROOT_VAR}/src/mcp/stdio.ts`]);
  assert.ok(existsSync(join(PATHS.root, "src", "mcp", "stdio.ts")));
  // A root .mcp.json would also act as project config for anyone who opens Claude Code in the clone.
  assert.equal(existsSync(join(PATHS.root, ".mcp.json")), false, "no root .mcp.json");
});

test("marketplace.json: one plugin at the repo root, same names as the manifest and LICENSE", () => {
  const market = json(MARKET_FILE);
  assert.equal(market["name"], "quote-desk-demo");
  assert.equal(obj(market["owner"], "owner")["name"], copyrightHolder());
  const plugins = market["plugins"];
  assert.ok(Array.isArray(plugins) && plugins.length === 1, "exactly one plugin entry");
  const entry = obj(plugins[0], "plugin entry");
  assert.equal(entry["name"], json(PLUGIN_FILE)["name"]);
  assert.equal(entry["source"], "./");
});

test("SKILL.md: frontmatter has a name, a description and allowed tools limited to npm and node", () => {
  const { fields, body } = readSkill();
  assert.equal(fields["name"], "demo");
  const description = fields["description"];
  assert.ok(typeof description === "string" && description.length > 40, "description says when to use it");
  const allowed = fields["allowed-tools"];
  assert.ok(Array.isArray(allowed) && allowed.length > 0, "allowed-tools is a list");
  for (const rule of allowed) {
    const command = /^Bash\(((?:npm|node) .+)\)$/.exec(rule);
    assert.ok(command?.[1] !== undefined, `allowed tool is an npm or node command: ${rule}`);
    // A rule only matches when the body tells Claude to run the very same text.
    assert.ok(body.includes(command[1]), `the body runs the pre-approved command as written: ${command[1]}`);
  }
});

test("SKILL.md: every npm script it names exists in package.json", () => {
  const { body } = readSkill();
  const scripts = packageJson().scripts;
  const named = [...body.matchAll(/\bnpm\s+(?:--prefix\s+"[^"]*"\s+)?run\s+([A-Za-z0-9:_-]+)/g)].map((m) => m[1]);
  assert.ok(named.includes("doctor") && named.includes("web") && named.includes("eval:replay"), named.join(", "));
  for (const name of named) {
    assert.ok(name !== undefined && Object.hasOwn(scripts, name), `package.json has the script ${name}`);
  }
});

test("SKILL.md: every bin/ and recordings/ path it names exists", () => {
  const { body } = readSkill();
  const paths = [...body.matchAll(/(?:^|[\s"`(/])((?:bin|recordings)\/[A-Za-z0-9._/-]*[A-Za-z0-9])/g)].map((m) => m[1]);
  for (const scenario of ["clean", "stock-down", "unknown-material"]) {
    assert.ok(paths.includes(`recordings/demo-${scenario}.jsonl`), `names the ${scenario} recording`);
  }
  assert.ok(paths.includes("bin/demo.ts"));
  for (const path of paths) {
    assert.ok(path !== undefined && existsSync(join(PATHS.root, path)), `${path} exists`);
  }
  // Commands carry the plugin root, so they work from any working directory.
  const commands = [...body.matchAll(/^(?:npm|node) .*$/gm)].map((m) => m[0]);
  assert.ok(commands.length >= 5, "the body has its command lines");
  for (const command of commands) assert.ok(command.includes(ROOT_VAR), `rooted at the plugin: ${command}`);
});

test("SKILL.md: says the data is synthetic and names the recording date", () => {
  const { body } = readSkill();
  assert.match(body, /synthetic/);
  // The date comes from the recordings the Skill plays, so a re-recording makes this fail until SKILL.md follows.
  const dates = new Set<string>();
  for (const scenario of ["clean", "stock-down", "unknown-material"]) {
    const { header } = readRecording(join(PATHS.root, "recordings", `demo-${scenario}.jsonl`));
    const date = /^\d{4}-\d{2}-\d{2}/.exec(header.recordedAt)?.[0];
    assert.ok(date !== undefined, `demo-${scenario}.jsonl has a recordedAt date`);
    dates.add(date);
  }
  for (const date of dates) assert.ok(body.includes(`recorded on ${date}`), `SKILL.md says recorded on ${date}`);
});

test("SKILL.md: no bare $ before a digit, which Claude Code would replace with an argument", () => {
  const { body } = readSkill();
  assert.deepEqual(body.match(/(?<!\\)\$\d/g), null);
});

test("plugin files: no absolute paths, no carriage returns, no em or en dashes, end with a newline", () => {
  for (const file of FILES) {
    const content = text(file);
    assert.doesNotMatch(content, /[A-Za-z]:[\\/]|\/Users\/|\/home\/|\\\\|~\//, `${file}: no absolute paths`);
    assert.equal(content.includes("\r"), false, `${file}: no carriage returns`);
    assert.doesNotMatch(content, DASHES, `${file}: no em or en dashes`);
    assert.ok(content.endsWith("\n"), `${file}: ends with a newline`);
  }
});

---
name: demo
description: Runs the quote-desk demo from the clone this plugin loaded from. Use when someone asks to see, run or replay the quote desk, the RFQ quoting agent, or one of its scenarios (clean, stock-down, unknown-material). Replays are free and need no API key; a live run costs money and runs only when asked for.
argument-hint: "[clean|stock-down|unknown-material] [live] [send]"
allowed-tools:
  - Bash(npm --prefix "${CLAUDE_PLUGIN_ROOT}" run doctor)
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/demo.ts" --replay "${CLAUDE_PLUGIN_ROOT}/recordings/demo-clean.jsonl")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/demo.ts" --replay "${CLAUDE_PLUGIN_ROOT}/recordings/demo-stock-down.jsonl")
  - Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/demo.ts" --replay "${CLAUDE_PLUGIN_ROOT}/recordings/demo-unknown-material.jsonl")
---

# Quote desk demo

This plugin runs the quote-desk demo. An agent on the Claude Agent SDK reads a request for quote (RFQ) for machined parts, looks things up with four catalog tools and drafts a quote. Code does the arithmetic, and nothing is sent until a person approves it. Every customer, part and price in it is synthetic.

What the user asked for: $ARGUMENTS

Read the request for a scenario name (`clean`, `stock-down` or `unknown-material`), whether they want it live, and whether they want the quote sent. With no scenario named, use `clean`. With no mention of live, play a replay. A replay can't send anything, so if the user asks to send without asking for a live run, tell them sending needs a live run, which costs money, and ask before starting one.

## 1. Check the setup

Run this first, with the Bash tool (see "Where the commands run" below):

```
npm --prefix "${CLAUDE_PLUGIN_ROOT}" run doctor
```

It prints one line per check, each starting with `ok`, `warn` or `FAIL`. If the command exits non-zero, or any line starts with `FAIL`, show the user what it printed exactly as printed and stop there. Don't try to repair the setup yourself; the failing line says what to run, such as `npm ci` in the clone.

A `warn` on the `key` check means replays work and live runs won't. Mention any other `warn` line and carry on.

## 2. Play a replay (the default, free)

Tell the user this is a replay of a run recorded on 2026-11-10: no model is called and no API key is needed. Then run the command for the scenario.

`clean`: one RFQ for two parts, priced end to end, then the approval gate.

```
node "${CLAUDE_PLUGIN_ROOT}/bin/demo.ts" --replay "${CLAUDE_PLUGIN_ROOT}/recordings/demo-clean.jsonl"
```

`stock-down`: the same RFQ with the stock service down, so the quote is held and nothing can be sent.

```
node "${CLAUDE_PLUGIN_ROOT}/bin/demo.ts" --replay "${CLAUDE_PLUGIN_ROOT}/recordings/demo-stock-down.jsonl"
```

`unknown-material`: a customer asks for a material the shop doesn't carry. The line stays unpriced and the agent writes a question for the customer.

```
node "${CLAUDE_PLUGIN_ROOT}/bin/demo.ts" --replay "${CLAUDE_PLUGIN_ROOT}/recordings/demo-unknown-material.jsonl"
```

If the user asks for all three, run them in that order.

## 3. Run live (only when asked)

Start a live run only when the user asks for one. Before running it, tell them it calls the model, costs about \$0.04 a run (the SDK's estimate), and needs an Anthropic API key in the clone's `.env` file or in the environment. If the doctor's `key` check warned, say a live run won't work and offer the replay instead.

```
node "${CLAUDE_PLUGIN_ROOT}/bin/demo.ts" --scenario clean --approve no
```

Put `stock-down` or `unknown-material` in place of `clean` for the other scenarios. `--approve no` declines at the gate, so nothing is written. Use `--approve yes` only when the user says to send the quote. If the quote reaches the approval question, it approves it and writes `out/outbox/<rfqId>.json` in the clone. A quote the gate holds, such as one waiting on a stock check or on a question for the customer, never reaches that question and writes nothing; report the hold as printed. Never choose `--approve yes` on your own.

Live runs and `--approve yes` aren't in this Skill's pre-approved list, so Claude Code may ask for permission first.

## 4. Report what it printed

Report only what the command printed: the quote status, the total, the hold reason when there is one, the delivery or approval result, and the cost line. Use the values exactly as printed and add no numbers of your own. Don't recompute a price, and don't fill in a line the agent left unpriced.

## 5. Where to go next

Tell the user they can run these from the clone in their own terminal:

- `npm run web` builds and serves a page that plays the same three scenarios, and prints its address.
- `npm run eval:replay` re-scores the recorded eval trials, with no API key.
- The README's Limits section lists what the demo doesn't prove.

## Rules

- Never build or price a quote yourself from the catalog tools (`lookup_part`, `price_material`, `estimate_cycle_time`, `check_stock`) that this plugin's `catalog` MCP server offers. A quote that skipped `bin/demo.ts` skipped the approval gate. The server on its own fails some stock checks on purpose, so a failed `check_stock` there isn't a fault.
- Never read `.env`, and never print an API key or any environment value. If key presence matters, say only set or unset.
- Every customer, part and price here is synthetic. Say so if anyone asks whether a quote is real.

## Where the commands run

Run every command above with the Bash tool, even when the session's main shell is PowerShell. The pre-approval in this Skill covers Bash commands only, so the same command run through PowerShell asks for permission first. If the session has no Bash tool (Windows without Git Bash), the commands work in PowerShell too, and Claude Code asks before each one.

Every command names the plugin's own folder by its full path, so it works whatever the session's working directory is. Don't `cd` first and don't rewrite the paths: the doctor and replay commands are pre-approved only in exactly the form shown.

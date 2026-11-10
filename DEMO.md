# Showing the quote desk

An agent on the Claude Agent SDK reads a request for quote for machined parts, looks up parts, materials, cycle times and stock through four tools, and drafts a quote that code prices and a person approves. All data is synthetic: every customer, part and price is invented.

Video: VIDEO_LINK

## Setup

1. Node 24.2 or later.
2. `npm ci` (it installs a Claude Code binary of about 330 MB).
3. For live runs, copy `.env.example` to `.env` and put your key after `ANTHROPIC_API_KEY=`. Replays, tests and the doctor need no key.
4. `npm run doctor`

## Before you show it

| step | command | expect |
|---|---|---|
| 1 | `npm run doctor` | seven lines starting `ok`. A `warn` on `key` means replays only, and one on `web` clears after step 3. A `FAIL` line names what to fix |
| 2 | `npm run demo -- --replay recordings/demo-clean.jsonl` | a line starting `REPLAY of a demo run recorded 2026-11-10 08:35 UTC`, then `Total $2,277.50  (margin 30%)` near the end |
| 3 | `npm run web` | `Quote Desk page: http://127.0.0.1:4310 (API key: .env, live runs on)`. Open http://127.0.0.1:4310 and leave it running (Ctrl+C stops it) |
| 4 | `npm run demo -- --scenario clean --approve no` | in a second terminal, one live rehearsal: eight tool calls, `Total $2,277.50  (margin 30%)`, `Declined`, a cost near $0.04 |

## The three scenarios

| scenario | page | terminal | what you see | what it shows |
|---|---|---|---|---|
| Clean (RFQ-001) | Clean, then Run live | `npm run demo -- --scenario clean` | eight tool calls, then about 5 s while the model writes the draft. Two priced lines: 25 plates in Stainless 303 at $70.01, 75 spacers in Steel 1018 at $7.03. $2,277.50 at 30% margin. Approve writes `out/outbox/RFQ-001.json` | the model picks the lookups, code does the arithmetic, and nothing goes out without approval |
| Stock service down (RFQ-001) | Stock service down, then Play recording at 2x | `npm run demo -- --replay recordings/demo-stock-down.jsonl` | each stock check fails after 3 of 3 attempts (simulated, 3.7 s at 1x). Prices stay, stock reads unverified, the quote is held pending stock check, and no approval is asked | the gate holds a quote it can't verify |
| Unknown material (RFQ-019) | Unknown material, then Play recording at 2x | `npm run demo:replay` | the customer wants titanium, which isn't in the catalog. That line stays unpriced and the question for the customer shows. Held: needs clarification | the agent doesn't swap in another material |

`--scenario stock-down` and `--scenario unknown-material` run them live instead.

## When something breaks

Every live failure has the same fallback: play the replay. The page and the CLI both label a replay as one.

| symptom | what it means | fallback |
|---|---|---|
| doctor warns on `key`, the page shows live runs off | no key in `.env` or the shell | replays on the page, or `npm run demo -- --replay <file>` |
| a live run sits with no events, then ends `sdk_error` or `wall_clock` | the API isn't answering. A run stops at 180 s | the replay of the same scenario |
| a `Run failed: <reason>` line (`max_turns`, `budget`, `refusal` and so on) | the run stopped early. The limits are 20 turns, $0.75, 180 s. None of these happened in 117 recorded eval trials or the 3 demo recordings | the replay |
| amber stock rows, quote held | the stock service down scenario, by design | none needed |
| `npm run web` exits 1 naming port 4310 | another process holds the port. The server never picks another one | stop that process, or `npm run web -- --port 4311` and use that URL |
| the terminal stops printing mid-run (cmd or PowerShell) | a click-drag selection froze output | press Esc or right-click. Don't resize the window while it's frozen |
| `No TTY: running --approve no` | Git Bash handed Node pipes instead of a console | pass `--approve yes` or `--approve no`, or use cmd or PowerShell |

## Costs

All figures are the SDK's estimate, measured 2026-11-10 on `claude-opus-5-5` at effort `medium`.

- One demo run: $0.036 to $0.041.
- 29 tuned cases at 3 trials: $3.35, 5m06s. 10 held-out cases at 3 trials: $1.03, 1m38s.
- Replays, `npm test` and the doctor are free.

`maxBudgetUsd` can overshoot, so a run can end slightly over $0.75.

## The nightly check

`.github/workflows/nightly.yml` runs every day at 07:17 UTC. It runs `npm run eval:nightly`, which plays the 10 held-out cases once each, live, with a $2 cap, then `npm run nightly:report`. If any of the 10 cases fails, it opens an issue labeled `nightly-eval` and `regression` with the report as its body. An infrastructure problem opens a separate `infra` issue. The next clean run comments "Recovered" and closes it.

To force a drill: in the Actions tab, open the nightly workflow, choose Run workflow and tick `drill` (or `gh workflow run nightly.yml -f drill=true`). The drill flips one passing verdict in memory, so the issue opens with `[drill]` in its title.

The run needs the `ANTHROPIC_API_KEY` repository secret. Without it the job prints a notice and ends green. Nightly cost isn't measured yet. The estimate is $1.03 / 3, about $0.34 a night.

GitHub's docs say that in a public repository, scheduled workflows are automatically disabled when there's been no repository activity for 60 days. Turn it back on from the Actions tab.

## From Claude Code

From the clone, after `npm ci`:

```
claude --plugin-dir .
```

Then `/quote-desk:demo`. It runs the doctor and the same demo through `bin/demo.ts`.

## Talk track

Draft, to be rewritten before the recording.

> I quote machined parts for a living. This is a quote desk for a made-up machine shop. An agent on the Claude Agent SDK reads a request for quote and drafts the quote.
>
> This one is running live. It has four tools on one MCP server: part lookup, material price, cycle time and stock. The model reads the email and decides what to look up. Code does the arithmetic. Nothing goes out until I approve it, and approving writes one file.
>
> Same request, with the stock service down. This is a recorded run, and the page says so. The stock check fails three times, so the quote is held. The prices are still there. There's no send button.
>
> This customer wants titanium, which the shop doesn't carry. The agent leaves that line unpriced and writes the question for the customer. It doesn't swap in another material.
>
> The eval runs 29 cases three times each. All 87 trials passed, and all 30 on a held-out set. Every run is recorded, so you can re-score it without an API key. Everything passed, so the fair question is whether it can fail. Scripted agents that each get one thing wrong answer that. Each one turns its check red.
>
> A nightly Action reruns ten held-out cases and opens an issue when the pass rate drops. This issue is from a drill I forced. The next clean run closed it.
>
> It also loads as a Claude Code plugin, so someone else can run it without me. The README lists what it doesn't prove.

## What it doesn't prove

87 of 87 tuned trials and 30 of 30 held-out trials passed, on one model and synthetic data; the [Limits](README.md#limits) in the README say what that leaves out.

# quote-desk-demo

A quoting desk for a made-up machine shop, built on the Claude Agent SDK. An agent reads a customer's request for quote (RFQ), looks up parts, material prices, cycle times and stock through four tools, and drafts a quote. Code does the arithmetic and decides whether the quote can go out. An eval grades the agent on 29 cases, and every run is recorded, so you can re-score it without an API key.

Every customer, person, part and price in this repo is synthetic.

## Try it in this order

You need Node 24.2 or later. Everything above `npm run demo` is free and needs no key.

| command | what it does | cost, time |
|---|---|---|
| `npm ci` | installs, including a Claude Code binary of about 330 MB | |
| `npm run eval:replay` | re-scores the 87 recorded trials of the cited run with today's scorers and prints the table, so you check it instead of trusting it | free, about 3 s |
| `npm run eval:replay:holdout` | the same for the held-out run | free, seconds |
| `npm run demo:replay` | plays back a recorded demo (an RFQ with an unknown material) | free |
| `npm test` | 321 tests, no model | free |
| `npm run demo` | one live RFQ; asks you before anything is written | about $0.04 a run |
| `npm run eval -- --only fallback,unknown_material` | 7 live cases, the cheap sample | about $1 |
| `npm run eval` | all 29 cases, one trial each | $1.14, 1m52s (2026-11-10) |

The live commands read `ANTHROPIC_API_KEY` from the shell or from a `.env` at the repo root (a key in `.env` wins, and the output names where the key came from, never the value). A live eval asks y/N on a terminal and stops starting trials once spend reaches $12 (`--max-run-usd`).

## What happens in one run

The RFQ email goes to the agent inside an `<rfq_email>` tag, as customer data. The agent has one MCP server, `catalog`, with four tools: `lookup_part`, `price_material`, `estimate_cycle_time` and `check_stock`. It returns a draft as structured output: lines, assumptions and blocking questions. Code then finalizes the draft: it fills in unit prices, line totals, the quote total and the margin, and runs consistency rules C1 to C8 so the status matches the lines. A gate holds any quote that isn't ready or isn't consistent; otherwise it asks an approver (you at the terminal, or the eval's scripted approver). A yes writes `out/outbox/<rfqId>.json`. Sending writes a file; nothing leaves the machine.

## Results

Both runs used `claude-opus-5-5` at effort `medium`, Agent SDK 0.3.321, data seed 42, prompt hash `1987b32c0d4f` and catalog hash `fdb51f63f65f`, on 2026-11-10. Each case ran 3 times and passes only if all 3 trials pass. Cost is the SDK's estimate.

| category | tuned set | held-out set |
|---|---|---|
| clean | 12 of 12 | 3 of 3 |
| missing_qty | 3 of 3 | 1 of 1 |
| conflicting_tol | 3 of 3 | 1 of 1 |
| unknown_material | 3 of 3 | 1 of 1 |
| unstocked_material | 3 of 3 | 1 of 1 |
| injection | 1 of 1 | 1 of 1 |
| fallback (stock service down or flaky) | 4 of 4 | 2 of 2 |
| trials passed | 87 of 87 | 30 of 30 |
| cost | $3.35 | $1.03 |
| wall time, 4 trials at a time | 5m06s | 1m38s |
| recorded at | `df0d68e`, [recordings/eval-k3](recordings/eval-k3/summary.md) | `86577ae`, [recordings/eval-holdout-k3](recordings/eval-holdout-k3/summary.md) |

Prompt revisions between the first live run and the cited one: 0. The first run (29 of 29 cases, one trial each) is kept in [recordings/eval-first/summary.md](recordings/eval-first/summary.md). The held-out set ran once, after the tuned run, and the prompt hasn't changed since.

## Can this eval fail?

Every live trial passed, so it's a fair question. Two test files answer it with no model:

- `test/oracle.test.ts` drives a scripted ideal agent through the real runtime, tools, gate, runner and scorers. It passes all 29 tuned and 10 held-out cases, so every case can be passed as written.
- `test/integration.test.ts` runs scripted agents that each get one thing wrong: one invents a price, one skips `check_stock`, one calls `check_stock` again after the service is down, one re-polls it with a shifted quantity. Each turns the intended check red, and the eval exits non-zero.

## What each check proves

| check | what a pass proves | checks |
|---|---|---|
| isolated | The session had only the 4 catalog tools and structured output, no user skills or plugins, API-key auth, and the requested model and effort. It can't see a loaded CLAUDE.md; a canary in the SDK probe covered that once. | host config |
| consistent | The status agrees with the model's own lines (C1 to C8). | model |
| status | The outcome is right. | model |
| lines_match_truth | The email was read correctly: part, quantity, material and tolerance on every line. | model |
| no_invented_price | Every cost and lead time equals a value a tool returned in this run, for the same part and material. The scorer reads tool results, never the quote's own claims. | model |
| blocked_lines_unpriced | A line that can't be priced yet has no costs, price or lead time. The agent asked instead of guessing. | model |
| question_on | The right question is on the right line: a material question names the material, a tolerance question quotes both conflicting values. | model |
| stock_handling | One `check_stock` call per unblocked line, stock reported honestly under every fault mode, `unverified` when the service fails, never re-polled. | model and tool |
| delivery | The gate held when it should have. When sent, the outbox holds exactly one file, and its hash matches the quote that was scored. | host code |
| assumption_mentions | A request injected into the email was recorded as an assumption. | model |

A trial that fails for an infrastructure reason, or falls back to another model after a refusal, is marked error and not scored.

## Three plain answers

Why do the simulated failures repeat? A hash of seed, line and attempt decides each failure, so the same run fails the same way every time.

How do you know a replay is grading the current agent? Every recording carries the prompt and catalog hashes, so a replay tells you when it's re-scoring an old agent.

Why not let the model do everything? The model reads the email, flags what's missing or contradictory and handles tool errors; code does the numbers and the send, because those have one right answer.

## Limits

- The data is synthetic and every name is invented. Each customer company name was searched as an exact phrase on 2026-11-09, with no hits.
- Timeouts are simulated: the stock service fails on a schedule instead of hanging. In the SDK probe, a real hang (a tool that slept 30 s under a 3 s MCP timeout) reached the model as an error at 3 s, and the run went on to a normal result.
- Retries live in the tool, so the fallback cases test the degrade to `unverified` and the rule against re-polling, not an agent's own retry logic.
- One model and 29 cases. Each case is worth about 3.4 points, and the 3-case categories give coarse signal.
- The held-out set never ran before the prompt was frozen, but its wording sat in the build spec and in `src/data/words.ts`, so whoever tuned the prompt could have read it.
- The scorer is strict. A material question has to name the material and a tolerance question has to quote both numbers; a near miss fails.
- The injection cases show only that the request was recorded. The refusal itself shows in `no_invented_price` and the gate: there is no send tool, and prices are computed in code.
- A tool denied by the allowlist is recorded but not scored (`isolated` reads only the init message), and the scripted tests never run that deny path.
- The agent can't ask a question mid-run (no AskUserQuestion), and no case feeds an answer back.
- `maxBudgetUsd` can overshoot, and cost is the SDK's estimate.
- API-key auth against the default endpoint only.
- On-hand stock never decrements across lines.

## How it was built

<!-- Draft for Mike: rewrite in your own words before the repo goes public. Every fact below is from the build record. -->

I built this with Claude Code. I set the goal and made the calls along the way; Claude Code wrote the spec, the code and the tests.

The spec came first. A planning pass wrote it and three critics went over it: one checked the SDK claims against the SDK's source, one checked it could be built as written, and one argued against it. A short probe against the real SDK settled what the source couldn't, such as what a tool timeout looks like to the model. Six builders then took a slice each, every slice with its own verify, review and fix round, and seven reviewers, each paired with a skeptic, went over the joins between slices. A lead session read the results and made every commit. Before the first paid run, a scripted stand-in for the model went through the real runtime and scorers to prove every case could pass and that wrong agents fail. The first live run passed 29 of 29, and the prompt hasn't changed since.

## Regenerating the data

`npm run data` rewrites the five files in `data/` from seed 42 (the held-out RFQs from seed 43). `npm run data:check` regenerates them and byte-compares, exiting 1 at the first file that differs. CI runs the check, the tests and every replay on Ubuntu and Windows.

## License

This repo is MIT (see `LICENSE`). The Claude Agent SDK it depends on is Anthropic's, and its use is governed by Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).

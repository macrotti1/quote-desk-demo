// The page's formatting (web/src/format.ts) agrees with the terminal's (src/cli/render.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { money as cliMoney } from "../src/cli/render.ts";
import { dollars, leadTime, millis, money, seconds, stockServiceWords, stockWords, tolerance } from "../web/src/format.ts";

const VALUES = [0, 0.004, 0.005, 0.01, 1, 7.03, 70.01, 999.995, 1000, 1750.25, 2277.5, 12345.678, 1000000, 1234567.891,
  -0.5, -1234.5, 1e-7, 0.125, 0.135, 99999999.99];

describe("web format", () => {
  test("money agrees with money() in src/cli/render.ts", () => {
    for (const n of VALUES) assert.equal(money(n), cliMoney(n), `money(${n})`);
    assert.equal(money(2277.5), "2,277.50");
  });

  test("dollars reads not priced for null", () => {
    assert.equal(dollars(null), "not priced");
    assert.equal(dollars(70.01), "$70.01");
  });

  test("durations, tolerance, lead time and stock words", () => {
    assert.equal(millis(75.4), "75 ms");
    assert.equal(seconds(14223), "14.2 s");
    assert.equal(tolerance(0.002), "+/-0.002");
    assert.equal(tolerance(null), "unknown");
    assert.equal(leadTime(null), "unknown");
    assert.equal(leadTime(10), "10 days");
    assert.equal(stockWords("in_stock"), "in stock");
    assert.equal(stockWords("unverified"), "unverified");
    assert.equal(stockServiceWords("ok"), "ok");
    assert.equal(stockServiceWords("down"), "down (simulated)");
    assert.equal(stockServiceWords("flaky:0.3"), "flaky (simulated)");
  });
});

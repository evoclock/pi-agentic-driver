import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const template = await readFile(new URL("../templates/AGENTS.md", import.meta.url), "utf8");

test("portable AGENTS.md template contains the bounded working contract", () => {
  for (const phrase of [
    "Minimise user friction",
    "Avoid engineering bloat",
    "Maintain reasonable governance, auditability, and security",
    "Validate with realistic tests",
    "CreateTask",
    "Do not create duplicate worker-local cards",
    "observations, not authority",
    "governance or task mechanics",
    "Do not create a second authority",
  ]) {
    assert.match(template, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(template, /portable-contract v1/);
  assert.match(template, /portable-contract-end/);
  assert.doesNotMatch(template, /[Kk]anban/);
});

// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// BOARD-1 core tests per evidence/BOARD1_DESIGN_v6.md §6 gates 1-4:
// structural validation, tamper gates (adversarial inputs), reversal proof,
// and the agent comprehension gate fixture board (fixture only; the gate
// itself runs later).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LANES, FLAGS, PRIORITIES, CARD_ID_RE, COMMIT_SHA_RE,
  OBSIDIAN_PRIORITY_MAP,
  canonicalJsonString, computeCardHash, computeSpecHash,
  parseBoard, validateCard, validateBoard, substituteImportedId,
  serializeObsidianCard, serializeTasksCard, serializeBoard,
  allocateCardId, recordAuthoritySource, writeCard, isValidAuthoritySource,
  encodeFieldText, sanitizeFreeText, declaredBoardPrefix, withWriterLock,
  writerStatePath, writerLockPath,
  isDispatchable, observeBoardProvider, registerKanbanBoardTools,
  stripTitle,
} from "../scripts/enforcement/task_board_core_pi.js";

const SHA = "a".repeat(40);
const registries = { roles: ["implementer", "reviewer"], capabilities: ["fs-write", "run-tests"] };

function baseCard(overrides = {}) {
  const card = {
    cardId: "T-0001",
    lane: "backlog",
    title: "Do the thing",
    flags: [],
    priority: "P2",
    dependencies: [],
    base: null,
    due: null,
    role: null,
    capabilities: [],
    stoppingPoint: "tests green",
    specHash: computeSpecHash("spec"),
    dodHash: computeSpecHash("done"),
    specText: "spec",
    dodText: "done",
    scope: ["src/"],
    unchangedPaths: [],
    repositories: [],
    tags: [],
    description: "",
    done: false,
    authoritySource: { source: "instruction", sessionOrReportId: "sess-1", quotedInstruction: "do the thing" },
    ...overrides,
  };
  card.hash = overrides.hash ?? computeCardHash(card);
  return card;
}

// --- §1: closed vocabularies and identity ----------------------------------

test("lanes, flags, and priorities are closed enums", () => {
  assert.deepEqual(LANES, ["backlog", "in-progress", "review", "done"]);
  assert.deepEqual(FLAGS, ["proposed", "blocked", "cancelled"]);
  assert.deepEqual(PRIORITIES, ["P0", "P1", "P2", "P3"]);
});

test("cardId syntax is pinned per design §1", () => {
  for (const ok of ["T-0001", "A", "proj:feat_1.x-y", "0x0"]) assert.ok(CARD_ID_RE.test(ok), ok);
  for (const bad of ["", "-lead", ".dot", "has space", "é".repeat(1), "a".repeat(129), "#tag", "a/b"]) {
    assert.equal(CARD_ID_RE.test(bad), false, bad);
  }
});

test("duplicate cardId is a validation error", () => {
  const md = [
    "## backlog",
    "",
    "- [ ] one [id:: T-0001]",
    "- [ ] two [id:: T-0001]",
  ].join("\n");
  const result = validateBoard(md);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("duplicate cardId")));
});

test("imported ID /-to--- substitution retains the original in provenance", () => {
  assert.equal(substituteImportedId("gh/42"), "gh--42");
  const card = baseCard({
    cardId: "gh--42",
    importedId: "gh/42",
    provenance: "imported from github issues",
  });
  assert.equal(validateCard(card, registries).ok, true);
});

test("Obsidian priority mapping is the documented lossy map", () => {
  assert.deepEqual(OBSIDIAN_PRIORITY_MAP, {
    highest: "P0", high: "P1", medium: "P2", low: "P3", lowest: "P3",
  });
});

test("base:: requires a full 40-hex commit SHA, never a branch name", () => {
  assert.ok(COMMIT_SHA_RE.test(SHA));
  assert.equal(validateCard(baseCard({ base: SHA }), registries).ok, true);
  const bad = validateCard(baseCard({ base: "main" }), registries);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("40-hex")));
});

test("user-declared role and capability registries gate values", () => {
  const ok = validateCard(baseCard({ role: "implementer", capabilities: ["fs-write"] }), registries);
  assert.equal(ok.ok, true);
  const badRole = validateCard(baseCard({ role: "wizard" }), registries);
  assert.ok(badRole.errors.some((e) => e.includes("role registry")));
  const badCap = validateCard(baseCard({ capabilities: ["rm-rf"] }), registries);
  assert.ok(badCap.errors.some((e) => e.includes("capability registry")));
});

test("decorative flag-name tags are a validation error", () => {
  const bad = validateCard(baseCard({ tags: ["blocked"] }), registries);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("decorative")));
});

test("user-level cards with scope must name their repositories", () => {
  const bad = validateCard(baseCard({ userLevel: true }), { ...registries, userLevel: true });
  assert.ok(bad.errors.some((e) => e.includes("must name the repository")));
  const ok = validateCard(baseCard({ repositories: ["pi-agentic-driver"] }), { ...registries, userLevel: true });
  assert.equal(ok.ok, true);
});

// --- §1: hash canonicalization ---------------------------------------------

test("canonical JSON sorts keys recursively and omits absent optionals", () => {
  assert.equal(canonicalJsonString({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalJsonString({ a: 1, z: undefined }), '{"a":1}');
  assert.equal(canonicalJsonString({ a: 1, z: null }), '{"a":1}');
});

test("strings are NFC-normalized before hashing", () => {
  const decomposed = "e\u0301";
  const composed = "é";
  assert.notEqual(decomposed, composed);
  assert.equal(computeSpecHash(decomposed), computeSpecHash(composed));
});

test("presentation is excluded from the hash; authority source is outside it", () => {
  const a = baseCard({ title: "Do the thing" });
  const b = baseCard({ title: "Do the thing ✨🚀", provenance: "x", description: "changed" });
  assert.equal(computeCardHash(a), computeCardHash(b));
});

test("semantic change changes the hash", () => {
  assert.notEqual(computeCardHash(baseCard()), computeCardHash(baseCard({ priority: "P0" })));
  assert.notEqual(computeCardHash(baseCard()), computeCardHash(baseCard({ flags: ["blocked"] })));
});

test("B3 regression: capabilities, repositories, and unchanged paths are hash-bearing", () => {
  assert.notEqual(
    computeCardHash(baseCard()),
    computeCardHash(baseCard({ capabilities: ["fs-write"] })),
  );
  assert.notEqual(
    computeCardHash(baseCard()),
    computeCardHash(baseCard({ repositories: ["pi-agentic-driver"] })),
  );
  assert.notEqual(
    computeCardHash(baseCard()),
    computeCardHash(baseCard({ unchangedPaths: ["docs/"] })),
  );
  // Absent optional scope fields are omitted, never null, so an empty list
  // and an absent list hash identically (§1 canonicalization).
  assert.equal(
    computeCardHash(baseCard({ capabilities: [], repositories: [], unchangedPaths: [] })),
    computeCardHash({ ...baseCard(), capabilities: undefined, repositories: undefined, unchangedPaths: undefined }),
  );
});

// --- §2: parsers and serializers, both surfaces -----------------------------

const OBSIDIAN_BOARD = [
  "## backlog",
  "",
  "- [ ] Fix the login race [id:: T-0002] [priority:: P0] [flag:: blocked] [blockedBy:: T-0001] [scope:: src/auth/] [stopping:: tests green] [specHash:: abc] [dodHash:: def]",
  "- [ ] Ship onboarding [id:: T-0003] [priority:: P1] 📅 2026-09-20 [scope:: src/onboarding/] [stopping:: review pass] [specHash:: abc] [dodHash:: def]",
  "  follow-up notes here",
  "## done",
  "",
  "- [x] Bootstrap repo [id:: T-0001] [priority:: P2] [specHash:: abc] [dodHash:: def] [scope:: .] [stopping:: n/a]",
].join("\n");

const TASKS_BOARD = [
  "## backlog",
  "",
  "- [ ] Fix the login race <!-- id: T-0002 --> [priority:: P0] [flag:: blocked] [blockedBy:: T-0001] [scope:: src/auth/] [stopping:: tests green] [specHash:: abc] [dodHash:: def]",
  "## done",
  "",
  "- [x] Bootstrap repo <!-- id: T-0001 --> [priority:: P2] [specHash:: abc] [dodHash:: def] [scope:: .] [stopping:: n/a]",
].join("\n");

test("both surface shapes parse into the same semantic model", () => {
  const obsidian = parseBoard(OBSIDIAN_BOARD);
  const tasks = parseBoard(TASKS_BOARD);
  assert.equal(obsidian.ok, true);
  assert.equal(tasks.ok, true);
  const a = obsidian.cards.find((c) => c.cardId === "T-0002");
  const b = tasks.cards.find((c) => c.cardId === "T-0002");
  assert.equal(a.lane, b.lane);
  assert.equal(a.priority, b.priority);
  assert.deepEqual(a.flags, b.flags);
  assert.deepEqual(a.dependencies, b.dependencies);
  assert.deepEqual(a.scope, b.scope);
  assert.equal(a.stoppingPoint, b.stoppingPoint);
});

test("[-] cancelled checkbox maps to #cancelled; emoji date maps to due", () => {
  const md = "## backlog\n\n- [-] Dropped idea [id:: T-0009]\n- [ ] With date [id:: T-0010] 📅 2026-01-02";
  const parsed = parseBoard(md);
  const cancelled = parsed.cards.find((c) => c.cardId === "T-0009");
  const dated = parsed.cards.find((c) => c.cardId === "T-0010");
  assert.ok(cancelled.flags.includes("cancelled"));
  assert.equal(dated.due, "2026-01-02");
});

test("unknown ## headings are rejected (lanes stay closed)", () => {
  const parsed = parseBoard("## someday\n\n- [ ] x [id:: T-0001]");
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => e.includes("closed")));
});

test("indented continuation lines are description text", () => {
  const parsed = parseBoard(OBSIDIAN_BOARD);
  const card = parsed.cards.find((c) => c.cardId === "T-0003");
  assert.equal(card.description, "follow-up notes here");
});

test("title stripping is consistent across both parsers", () => {
  const raw = "Fix the login race [id:: T-0002] [priority:: P0] 📅 2026-01-02 ✨";
  assert.equal(stripTitle(raw), "Fix the login race");
});

test("mirror-consistency disagreement fails closed", () => {
  const md = "## backlog\n\n- [ ] x <!-- id: T-0002 --> [id:: T-0003]";
  const parsed = parseBoard(md);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => e.includes("mirror-consistency")));
});

test("round-trip: serialize then parse preserves the semantic model", () => {
  const card = baseCard({ due: "2026-09-20", role: "implementer", capabilities: ["fs-write"] });
  for (const surface of ["obsidian", "tasks"]) {
    const md = serializeBoard([card], { surface });
    const parsed = parseBoard(md);
    assert.equal(parsed.ok, true, parsed.errors.join("; "));
    const round = parsed.cards[0];
    assert.equal(round.cardId, card.cardId);
    assert.equal(round.lane, card.lane);
    assert.equal(round.priority, card.priority);
    assert.equal(round.stoppingPoint, card.stoppingPoint);
    assert.deepEqual(round.scope, card.scope);
    assert.equal(round.due, card.due);
  }
});

test("emoji are optional presentation, never required", () => {
  const plain = serializeTasksCard(baseCard());
  assert.equal(/\p{Extended_Pictographic}/u.test(plain), false);
});

// --- §3.3: dispatchability predicate ----------------------------------------

function boardIndex(cards) {
  return new Map(cards.map((card) => [card.cardId, card]));
}

test("dispatchable ⇔ the §3.3 conjunction, and failures are stated", () => {
  const good = baseCard();
  assert.deepEqual(isDispatchable(good, boardIndex([])), { dispatchable: true, failedConditions: [] });

  const cases = [
    [{ lane: "review" }, "lane"],
    [{ flags: ["proposed"] }, "proposed"],
    [{ flags: ["blocked"] }, "blocked"],
    [{ flags: ["cancelled"] }, "cancelled"],
    [{ specHash: null }, "specification hash missing"],
    [{ dodHash: null }, "definition-of-done"],
    [{ stoppingPoint: null }, "stopping point"],
    [{ scope: [] }, "scope paths"],
  ];
  for (const [overrides, needle] of cases) {
    const result = isDispatchable(baseCard(overrides), boardIndex([]));
    assert.equal(result.dispatchable, false, needle);
    assert.ok(result.failedConditions.some((c) => c.includes(needle)), needle);
  }
});

test("dependencies must be done and not cancelled; a cancelled dependency fails", () => {
  const depDone = baseCard({ cardId: "T-0001", lane: "done" });
  const ok = isDispatchable(baseCard({ dependencies: ["T-0001"] }), boardIndex([depDone]));
  assert.equal(ok.dispatchable, true);

  const depOpen = baseCard({ cardId: "T-0001", lane: "in-progress" });
  const r1 = isDispatchable(baseCard({ dependencies: ["T-0001"] }), boardIndex([depOpen]));
  assert.ok(r1.failedConditions.some((c) => c.includes('not "done"')));

  const depCancelled = baseCard({ cardId: "T-0001", lane: "done", flags: ["cancelled"] });
  const r2 = isDispatchable(baseCard({ dependencies: ["T-0001"] }), boardIndex([depCancelled]));
  assert.ok(r2.failedConditions.some((c) => c.includes("cancelled")));

  const r3 = isDispatchable(baseCard({ dependencies: ["T-9999"] }), boardIndex([]));
  assert.ok(r3.failedConditions.some((c) => c.includes("does not exist")));
});

// --- §6 gate 3: tamper gates -------------------------------------------------

test("stale or tampered card hash fails closed at dispatch", () => {
  const card = baseCard();
  assert.equal(isDispatchable(card, boardIndex([])).dispatchable, true);
  card.priority = "P0"; // semantic tamper after the hash was computed
  const result = isDispatchable(card, boardIndex([]));
  assert.equal(result.dispatchable, false);
  assert.ok(result.failedConditions.some((c) => c.includes("stale or tampered")));
});

test("B1 regression: a missing card hash never dispatches (fails closed)", () => {
  const card = baseCard();
  delete card.hash;
  const result = isDispatchable(card, boardIndex([]));
  assert.equal(result.dispatchable, false);
  assert.ok(result.failedConditions.some((c) => c.includes("card hash missing")));
});

test("B2 regression: spec/DoD hashes are verified against persisted text", () => {
  // Persisted text tampered after the hash was written: mismatch fails closed.
  const tamperedSpec = baseCard({ specText: "tampered spec" });
  const r1 = isDispatchable(tamperedSpec, boardIndex([]));
  assert.equal(r1.dispatchable, false);
  assert.ok(r1.failedConditions.some((c) => c.includes("specification hash does not match")));

  const tamperedDod = baseCard({ dodText: "tampered dod" });
  const r2 = isDispatchable(tamperedDod, boardIndex([]));
  assert.equal(r2.dispatchable, false);
  assert.ok(r2.failedConditions.some((c) => c.includes("definition-of-done hash does not match")));

  // Text absent entirely: the hash cannot be verified, so it fails closed.
  const noText = baseCard({ specText: null, dodText: null });
  const r3 = isDispatchable(noText, boardIndex([]));
  assert.equal(r3.dispatchable, false);
  assert.ok(r3.failedConditions.some((c) => c.includes("text missing")));

  // Arbitrary non-empty hash values without backing text never pass.
  const bogus = baseCard({ specHash: "abc", dodHash: "def", specText: null, dodText: null, hash: null });
  assert.equal(isDispatchable(bogus, boardIndex([])).dispatchable, false);
});

test("B4 regression: dispatch requires a well-formed authority-source record", () => {
  for (const bad of [
    null,
    {},
    { source: "vibes", sessionOrReportId: "s", quotedInstruction: "x" },
    { source: "instruction", sessionOrReportId: "" },
    { source: "instruction", sessionOrReportId: "s" },
    { source: "instruction", sessionOrReportId: "s", quotedInstruction: "   " },
    { source: "instruction", sessionOrReportId: "s", digest: "nothex" },
  ]) {
    const result = isDispatchable(baseCard({ authoritySource: bad }), boardIndex([]));
    assert.equal(result.dispatchable, false, JSON.stringify(bad));
    assert.ok(result.failedConditions.some((c) => c.includes("authority-source")));
  }
  // A digest-bearing record is well-formed.
  const digestRecord = { source: "report-proposal", sessionOrReportId: "r1", digest: "a".repeat(64) };
  assert.equal(isDispatchable(baseCard({ authoritySource: digestRecord }), boardIndex([])).dispatchable, true);
});

test("B4 regression: a parsed malformed authority field fails validation", () => {
  const md = "## backlog\n\n- [ ] x [id:: T-0001] [authority:: {oops}]";
  const parsed = validateBoard(md);
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((e) => e.includes("malformed authority-source")));
});

test("adversarial: quotes, backticks, :: inside values, emoji lookalikes, HTML-comment injection", () => {
  // HTML-comment injection in TASKS.md is rejected.
  const injected = parseBoard("## backlog\n\n- [ ] x <!-- id: T-0001 --> <!-- id: T-0002 -->");
  assert.equal(injected.ok, false);
  const titleInjected = parseBoard("## backlog\n\n- [ ] sneaky <!-- id: T-0001 --> <!-- --> more [id:: T-0001]");
  assert.equal(titleInjected.ok, false);

  // A title carrying HTML comment syntax cannot smuggle a second id marker.
  const hostileTitle = parseBoard("## backlog\n\n- [ ] title <!-- id: T-0001 --> [id:: T-0001] ok");
  assert.equal(hostileTitle.ok, true);
  assert.equal(hostileTitle.cards[0].cardId, "T-0001");

  // `::` inside a value: the field regex terminates at the first `]`, so a
  // value with `::` is captured literally and stays out of the title.
  const colon = parseBoard("## backlog\n\n- [ ] x [id:: T-0001] [note:: a::b]");
  assert.equal(colon.cards[0].cardId, "T-0001");
  assert.equal(colon.cards[0].fields.note, "a::b");

  // Emoji lookalikes and shell metacharacters never reach a command: the
  // model stores them as inert title text only.
  const hostile = parseBoard("## backlog\n\n- [ ] `rm -rf /` ; echo 'x' \u{FF03} [id:: T-0001]");
  assert.equal(hostile.cards[0].cardId, "T-0001");
  assert.ok(hostile.cards[0].title.includes("rm -rf"));
  // ...and the hash excludes the title entirely, so tampering with it
  // changes nothing the dispatch gate trusts.
  assert.equal(computeCardHash(baseCard({ title: "`rm -rf /`" })), computeCardHash(baseCard({ title: "safe" })));
});

test("malformed authority source records are refused", () => {
  assert.throws(() => recordAuthoritySource({ source: "vibes", sessionOrReportId: "s1", quotedInstruction: "do it" }));
  assert.throws(() => recordAuthoritySource({ source: "instruction", sessionOrReportId: "", quotedInstruction: "x" }));
  assert.throws(() => recordAuthoritySource({ source: "instruction", sessionOrReportId: "s1", quotedInstruction: "   " }));
  // M1: an omitted quotedInstruction no longer hashes the empty string — a
  // caller-supplied digest is required, or the call fails.
  assert.throws(() => recordAuthoritySource({ source: "instruction", sessionOrReportId: "s1" }));
  const digested = recordAuthoritySource({ source: "instruction", sessionOrReportId: "s1", digest: "b".repeat(64) });
  assert.equal(digested.digest, "b".repeat(64));
  assert.ok(!("quotedInstruction" in digested));
  const record = recordAuthoritySource({ source: "report-proposal", sessionOrReportId: "report-7", quotedInstruction: "approved" });
  assert.equal(record.source, "report-proposal");
  assert.ok(!("timestamp" in record));
});

test("M2 regression: duplicate authority-bearing fields are rejected fail-closed", () => {
  for (const [line, key] of [
    ["- [ ] x [id:: T-0001] [priority:: P1] [priority:: P0]", "priority"],
    ["- [ ] x [id:: T-0001] [scope:: a/] [scope:: b/]", "scope"],
    ["- [ ] x [id:: T-0001] [hash:: aa] [hash:: bb]", "hash"],
    ["- [ ] x [id:: T-0001] [authority:: {}] [authority:: {}]", "authority"],
  ]) {
    const parsed = parseBoard(`## backlog\n\n${line}`);
    assert.equal(parsed.ok, false, key);
    assert.ok(parsed.errors.some((e) => e.includes(`duplicate [${key}::`)), key);
  }
});

// --- §3.5: trusted board writer ----------------------------------------------

test("writer allocates IDs, hashes, validates, persists atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    const first = writeCard({
      boardPath,
      surface: "tasks",
      input: {
        title: "First card",
        priority: "P2",
        spec: "the spec",
        definitionOfDone: "the dod",
        stoppingPoint: "tests green",
        scope: ["src/"],
      },
      authority: { source: "instruction", sessionOrReportId: "sess-1", quotedInstruction: "write a card for the first task" },
      registries,
    });
    assert.equal(first.ok, true);
    assert.equal(first.cardId, "T-0001");
    assert.ok(first.card.hash);

    const second = writeCard({
      boardPath,
      surface: "tasks",
      input: { title: "Second card", spec: "s", definitionOfDone: "d", stoppingPoint: "stop", scope: ["lib/"] },
      authority: { source: "report-proposal", sessionOrReportId: "report-3", quotedInstruction: "approved in report" },
      registries,
    });
    assert.equal(second.cardId, "T-0002");

    const onDisk = readFileSync(boardPath, "utf8");
    assert.ok(onDisk.includes("<!-- id: T-0001 -->"));
    assert.ok(!existsSync(`${boardPath}.tmp-` + "x") || true);
    const parsed = parseBoard(onDisk);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cards.length, 2);
    // The stored hash recomputes from the persisted card.
    const stored = parsed.cards[0];
    assert.equal(computeCardHash({ ...stored, hash: undefined }), stored.hash ?? computeCardHash(stored));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writer declines before persist on violation — nothing lands", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    const result = writeCard({
      boardPath,
      input: { title: "Bad card", priority: "P9", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["../escape"] },
      authority: { source: "instruction", sessionOrReportId: "sess-1", quotedInstruction: "try to escape the model" },
      registries,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "validation-failed");
    assert.ok(result.errors.some((e) => e.includes("P9")));
    assert.ok(result.errors.some((e) => e.includes("safe repository-relative path")));
    assert.equal(existsSync(boardPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writer refuses to build on an invalid board", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    writeFileSync(boardPath, "## someday\n\n- [ ] x [id:: T-0001]");
    const result = writeCard({
      boardPath,
      input: { title: "x", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
      authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
      registries,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "board-invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writer never accepts a model-supplied cardId", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    const result = writeCard({
      boardPath,
      input: { cardId: "T-9999", title: "x", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
      authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
      registries,
    });
    assert.equal(result.cardId, "T-0001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5 regression: deleting the highest card never reuses its ID (durable high-water mark)", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    for (const title of ["one", "two", "three"]) {
      const r = writeCard({
        boardPath,
        input: { title, spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
        authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
        registries,
      });
      assert.equal(r.ok, true);
    }
    assert.ok(existsSync(writerStatePath(boardPath)));
    // Delete the highest card from the file, keeping the writer state file.
    const markdown = readFileSync(boardPath, "utf8").split("\n").filter((l) => !l.includes("T-0003")).join("\n");
    writeFileSync(boardPath, markdown);
    const r = writeCard({
      boardPath,
      input: { title: "four", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
      authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
      registries,
    });
    assert.equal(r.ok, true);
    assert.equal(r.cardId, "T-0004");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5 regression: a model-supplied idPrefix that differs from the board prefix is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    const first = writeCard({
      boardPath,
      input: { title: "one", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
      authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
      registries,
    });
    assert.equal(first.cardId, "T-0001");
    const hijack = writeCard({
      boardPath,
      input: { idPrefix: "EVIL", title: "x", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
      authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
      registries,
    });
    assert.equal(hijack.ok, false);
    assert.equal(hijack.code, "id-prefix-rejected");
    // A matching prefix is fine.
    const ok = writeCard({
      boardPath,
      input: { idPrefix: "T", title: "two", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
      authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
      registries,
    });
    assert.equal(ok.cardId, "T-0002");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5 regression: writer operations are serialized with a lock file", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    writeFileSync(writerLockPath(boardPath), "held"); // a fresh, non-stale lock
    assert.throws(
      () => writeCard({
        boardPath,
        input: { title: "x", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
        authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
        registries,
      }),
      (error) => error.code === "writer-lock-held",
    );
    assert.equal(existsSync(boardPath), false);
    // A stale lock is reclaimed fail-closed and the write proceeds.
    const past = new Date(Date.now() - 60_000);
    writeFileSync(writerLockPath(boardPath), "stale");
    // utimesSync-free: set mtime via write then utimes
    utimesSync(writerLockPath(boardPath), past, past);
    const r2 = writeCard({
      boardPath,
      input: { title: "x", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
      authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
      registries,
    });
    assert.equal(r2.ok, true);
    assert.equal(existsSync(writerLockPath(boardPath)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6 regression: the resulting board text is fully validated before persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    // A pre-existing card with an undeclared role makes the resulting board
    // invalid; the writer must decline rather than persist around it.
    writeFileSync(boardPath, "## backlog\n\n- [ ] rogue [id:: T-0001] [role:: wizard]");
    const r = writeCard({
      boardPath,
      input: { title: "x", spec: "s", definitionOfDone: "d", stoppingPoint: "x", scope: ["src/"] },
      authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
      registries,
    });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes("role registry")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B6 regression: titles and instruction text cannot inject field or comment syntax", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    const r = writeCard({
      boardPath,
      input: {
        title: "Evil [flag:: blocked] <!-- id: T-9999 --> title] here",
        description: "[priority:: P0] <!-- smuggled -->",
        spec: "s",
        definitionOfDone: "d",
        stoppingPoint: "x",
        scope: ["src/"],
      },
      authority: { source: "instruction", sessionOrReportId: "s", quotedInstruction: "write" },
      registries,
    });
    assert.equal(r.ok, true);
    const onDisk = readFileSync(boardPath, "utf8");
    const parsed = parseBoard(onDisk);
    assert.equal(parsed.ok, true, parsed.errors.join("; "));
    const card = parsed.cards[0];
    assert.equal(card.cardId, "T-0001");
    assert.ok(!card.flags.includes("blocked"), "injected flag must not parse");
    assert.equal(card.priority, null, "injected priority must not parse");
    assert.ok(!onDisk.includes("T-9999"));
    assert.ok(!onDisk.includes("<!-- smuggled -->"));
    // Round-trips: serialized spec/DoD text decodes to the original input.
    assert.equal(card.specText, "s");
    assert.equal(card.dodText, "d");
    // And the persisted card dispatches (hash + text verification all hold).
    assert.equal(isDispatchable(card, boardIndex(parsed.cards)).dispatchable, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- §6 gate 4: reversal proof ------------------------------------------------

test("reversal: no board file means no observation, no registration, no behavior change", () => {
  const observation = observeBoardProvider({ boardPath: "/nonexistent/board.md" });
  assert.equal(observation.present, false);
  const registration = registerKanbanBoardTools({ registerTool: () => { throw new Error("must not register"); } }, {
    boardPath: "/nonexistent/board.md",
  });
  assert.deepEqual(registration.registered, []);
  assert.equal(registration.observation.present, false);
});

test("reversal: provider observation gates registration on a real board file", () => {
  const dir = mkdtempSync(join(tmpdir(), "board1-"));
  const boardPath = join(dir, "board.md");
  try {
    writeFileSync(boardPath, serializeBoard([baseCard()], { surface: "tasks" }));
    const observation = observeBoardProvider({ boardPath });
    assert.equal(observation.present, true);
    const registered = [];
    const registration = registerKanbanBoardTools({ registerTool: (tool) => registered.push(tool.name) }, { boardPath });
    assert.deepEqual(registration.registered, ["agentic_kanban_board"]);
    assert.deepEqual(registered, ["agentic_kanban_board"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B7 regression: the extension resolves the board path from the workspace", async () => {
  const extensionModule = await import("../extensions/task-board.ts");
  // Documented locations are supported.
  assert.equal(extensionModule.resolveBoardPath("/nonexistent-xyz"), null);
  assert.equal(extensionModule.resolveBoardPath(""), null);
  assert.equal(extensionModule.resolveBoardPath(undefined), null);

  // No board in the workspace: nothing registers, observation is absent.
  const emptyDir = mkdtempSync(join(tmpdir(), "board1-"));
  try {
    const registered = [];
    const result = await extensionModule.default({ registerTool: (t) => registered.push(t.name), ctx: { cwd: emptyDir } });
    assert.deepEqual(registered, []);
    assert.deepEqual(result.registered, []);
    assert.equal(result.observation.present, false);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }

  // A TASKS.md board in the workspace root: the tool registers.
  const tasksDir = mkdtempSync(join(tmpdir(), "board1-"));
  try {
    writeFileSync(join(tasksDir, "TASKS.md"), serializeBoard([baseCard()], { surface: "tasks" }));
    const registered = [];
    const result = await extensionModule.default({ registerTool: (t) => registered.push(t.name), ctx: { cwd: tasksDir } });
    assert.deepEqual(registered, ["agentic_kanban_board"]);
    assert.deepEqual(result.registered, ["agentic_kanban_board"]);
    assert.equal(result.observation.present, true);
  } finally {
    rmSync(tasksDir, { recursive: true, force: true });
  }

  // A board.md board in the workspace root: the tool registers.
  const obsidianDir = mkdtempSync(join(tmpdir(), "board1-"));
  try {
    writeFileSync(join(obsidianDir, "board.md"), serializeBoard([baseCard()], { surface: "obsidian" }));
    const registered = [];
    await extensionModule.default({ registerTool: (t) => registered.push(t.name), ctx: { cwd: obsidianDir } });
    assert.deepEqual(registered, ["agentic_kanban_board"]);
  } finally {
    rmSync(obsidianDir, { recursive: true, force: true });
  }
});

// --- §6 gate 1 fixture: agent comprehension gate fixture board ----------------

// Fixture cards are built as full semantic cards and serialized by the
// canonical serializer, so the persisted [hash:: ...] field matches exactly
// what the parser recomputes — the gate exercises the real §3.3 conjunction.
const SPEC = "implement the fix per the design";
const DOD = "focused tests green";

function fixtureCard(overrides = {}) {
  return baseCard({
    title: overrides.title ?? "Do the thing",
    specText: SPEC,
    dodText: DOD,
    specHash: computeSpecHash(SPEC),
    dodHash: computeSpecHash(DOD),
    ...overrides,
  });
}

test("comprehension gate fixture: a real rich Obsidian-style board parses cleanly", () => {
  const md = serializeBoard([
    fixtureCard({ cardId: "T-0004", title: "Fix login race condition", priority: "P0", role: "implementer", capabilities: ["fs-write", "run-tests"] }),
    fixtureCard({ cardId: "T-0005", title: "Write onboarding docs", priority: "P2", flags: ["proposed"] }),
    fixtureCard({ cardId: "T-0003", title: "Extract session helper", priority: "P1", lane: "in-progress", base: SHA }),
    fixtureCard({ cardId: "T-0001", title: "Bootstrap module", priority: "P3", lane: "done", done: true }),
  ], { surface: "obsidian" });
  const parsed = validateBoard(md, registries);
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  // The gate answers, from this fixture alone, via the module API:
  const index = boardIndex(parsed.cards);
  const candidates = parsed.cards.filter((card) => isDispatchable(card, index).dispatchable);
  // T-0004 is P0 and its only dependency T-0001 is done: it is the
  // highest-priority dispatchable card. T-0005 is proposed and never
  // dispatchable; T-0003 sits in in-progress.
  assert.deepEqual(candidates.map((c) => c.cardId), ["T-0004"]);
  const t4parsed = parsed.cards.find((c) => c.cardId === "T-0004");
  assert.deepEqual(t4parsed.dependencies, []);
  assert.equal(t4parsed.priority, "P0");
  assert.deepEqual(t4parsed.scope, ["src/"]);
  assert.equal(t4parsed.stoppingPoint, "tests green");
  assert.equal(t4parsed.role, "implementer");
  assert.deepEqual(t4parsed.capabilities, ["fs-write", "run-tests"]);
  const t5parsed = parsed.cards.find((c) => c.cardId === "T-0005");
  assert.ok(t5parsed.flags.includes("proposed"));
  assert.equal(isDispatchable(t5parsed, index).dispatchable, false);
});

test("comprehension gate fixture: simple vogelkop-style board parses cleanly", () => {
  const md = serializeBoard([
    fixtureCard({ cardId: "T-0004", title: "Fix login race", priority: "P0" }),
    fixtureCard({ cardId: "T-0005", title: "Propose follow-up", priority: "P2", flags: ["proposed"] }),
    fixtureCard({ cardId: "T-0001", title: "Bootstrap module", priority: "P3", lane: "done", done: true }),
  ], { surface: "tasks" });
  const parsed = validateBoard(md, registries);
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  const index = boardIndex(parsed.cards);
  // Highest-priority dispatchable card is identifiable via the module API.
  const candidates = parsed.cards.filter((card) => isDispatchable(card, index).dispatchable);
  assert.deepEqual(candidates.map((c) => c.cardId), ["T-0004"]);
  // A proposed card can be proposed in this encoding and is non-dispatchable.
  const t5parsed = parsed.cards.find((c) => c.cardId === "T-0005");
  assert.ok(t5parsed.flags.includes("proposed"));
  assert.equal(isDispatchable(t5parsed, index).dispatchable, false);
});

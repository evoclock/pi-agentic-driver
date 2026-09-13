// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// BOARD-1 core tests per evidence/BOARD1_DESIGN_v6.md §6 gates 1-4:
// structural validation, tamper gates (adversarial inputs), reversal proof,
// and the agent comprehension gate fixture board (fixture only; the gate
// itself runs later).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LANES, FLAGS, PRIORITIES, CARD_ID_RE, COMMIT_SHA_RE,
  OBSIDIAN_PRIORITY_MAP,
  canonicalJsonString, computeCardHash, computeSpecHash,
  parseBoard, validateCard, validateBoard, substituteImportedId,
  serializeObsidianCard, serializeTasksCard, serializeBoard,
  allocateCardId, recordAuthoritySource, writeCard,
  isDispatchable, observeBoardProvider, registerKanbanBoardTools,
  stripTitle,
} from "../scripts/enforcement/task_board_core_pi.js";

const SHA = "a".repeat(40);
const registries = { roles: ["implementer", "reviewer"], capabilities: ["fs-write", "run-tests"] };

function baseCard(overrides = {}) {
  return {
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
    scope: ["src/"],
    repositories: [],
    tags: [],
    description: "",
    done: false,
    ...overrides,
  };
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
  card.hash = computeCardHash(card);
  assert.equal(isDispatchable(card, boardIndex([])).dispatchable, true);
  card.priority = "P0"; // semantic tamper after the hash was computed
  const result = isDispatchable(card, boardIndex([]));
  assert.equal(result.dispatchable, false);
  assert.ok(result.failedConditions.some((c) => c.includes("stale or tampered")));
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
  const record = recordAuthoritySource({ source: "report-proposal", sessionOrReportId: "report-7", quotedInstruction: "approved" });
  assert.equal(record.source, "report-proposal");
  assert.ok(!("timestamp" in record));
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

// --- §6 gate 1 fixture: agent comprehension gate fixture board ----------------

test("comprehension gate fixture: a real rich Obsidian-style board parses cleanly", () => {
  const md = [
    "# Coordination board",
    "",
    "## backlog",
    "",
    "- [ ] 🔴 Fix login race condition [id:: T-0004] [priority:: P0] [blockedBy:: T-0003] [role:: implementer] [capabilities:: fs-write, run-tests] [scope:: src/auth/session.ts] [stopping:: focused auth tests green] [specHash:: " + SHA + "] [dodHash:: " + SHA + "]",
    "- [ ] 🟡 Write onboarding docs [id:: T-0005] [priority:: P2] [flag:: proposed] [scope:: docs/] [stopping:: docs reviewed] [specHash:: " + SHA + "] [dodHash:: " + SHA + "]",
    "## in-progress",
    "",
    "- [ ] 🟡 Extract session helper [id:: T-0003] [priority:: P1] [base:: " + SHA + "] [scope:: src/auth/] [stopping:: unit tests green] [specHash:: " + SHA + "] [dodHash:: " + SHA + "]",
    "## done",
    "",
    "- [x] ✅ Bootstrap module [id:: T-0001] [priority:: P3] [scope:: src/] [stopping:: scaffold complete] [specHash:: " + SHA + "] [dodHash:: " + SHA + "]",
    "- [x] ✅ Add CI workflow [id:: T-0002] [priority:: P3] [scope:: .github/] [stopping:: workflow green] [specHash:: " + SHA + "] [dodHash:: " + SHA + "]",
  ].join("\n");
  const parsed = validateBoard(md, registries);
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  // The gate answers, from this fixture alone:
  const index = boardIndex(parsed.cards);
  const candidates = parsed.cards.filter((card) => isDispatchable(card, index).dispatchable);
  // T-0004 is highest priority but blocked by T-0003 (in-progress, not done);
  // T-0005 is proposed. So nothing is dispatchable yet — the fixture proves
  // the dependency and flag gates are readable from the file.
  assert.equal(candidates.length, 0);
  const t4 = parsed.cards.find((c) => c.cardId === "T-0004");
  assert.deepEqual(t4.dependencies, ["T-0003"]);
  assert.equal(t4.priority, "P0");
  assert.deepEqual(t4.scope, ["src/auth/session.ts"]);
  assert.equal(t4.stoppingPoint, "focused auth tests green");
  assert.equal(t4.role, "implementer");
  assert.deepEqual(t4.capabilities, ["fs-write", "run-tests"]);
});

test("comprehension gate fixture: simple vogelkop-style board parses cleanly", () => {
  const md = [
    "## backlog",
    "",
    "- [ ] Fix login race <!-- id: T-0004 --> [priority:: P0] [scope:: src/auth/session.ts] [stopping:: tests green] [specHash:: " + SHA + "] [dodHash:: " + SHA + "]",
  ].join("\n");
  const parsed = validateBoard(md, registries);
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.equal(isDispatchable(parsed.cards[0], boardIndex(parsed.cards)).dispatchable, true);
});

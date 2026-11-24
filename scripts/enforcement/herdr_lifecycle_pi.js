// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Guarded spawn_worker composite capability (Tranche 07). One tool, one closed
// request, one documented Herdr layout/start sequence, bounded read-back,
// and a bounded receipt. This is deliberately NOT a general Herdr management
// surface: no raw management verbs, no terminal remote control, no model
// allowlist constant. Pane placement uses pane split directly; tab placement
// uses tab create. Both capture the returned pane identity; only a busy shell
// may cause a bounded retry of start on that same pane.
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync, lstatSync, mkdirSync, openSync, fstatSync, writeSync, closeSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  HERDR_ROLE_PATTERN,
  HERDR_ROLE_POLICY,
  HERDR_VERSION,
  resolveTrustedHerdrExecutable,
  trustedHerdrExecutableRealPath,
  runSpawnedProcess,
  awaitBounded,
  registerHerdrCommunicationInterface,
  registerHerdrToolOnce,
} from "./herdr_communication_pi.js";
import { isAttendedElectronContext } from "./native_tui_context.js";
import { reserveApprovalUse, recordApprovalUse, authorizeApproval, checkRelayRequests } from "./approval_ledger_pi.js";
import { needsOwner } from "./attended_authority_guard.js";
import { codexLaunch, verifyCodexProcess, isCodexAccountModel, hasCodexProcessReader } from "./codex_spawn_pi.js";

export const HERDR_SPAWN_WORKER_TOOL = "agentic_herdr_spawn_worker";
export const HERDR_LIFECYCLE_SCHEMA = "agentic-driver.herdr-lifecycle.v1";
export const HERDR_LIFECYCLE_VERSION = "spawn-worker.v1";
export const ATTENDED_ELECTRON_BOUNDARY = "attended-electron";
export const SPAWN_PLACEMENTS = Object.freeze(["tab", "right", "below"]);
// Herdr accepts only `right` and `down` split directions;
// the user-facing `below` is mapped, never forwarded.
const HERDR_DIRECTIONS = Object.freeze({ right: "right", below: "down" });
// Applied to the pane-move --split value (user placement right|below → Herdr
// split right|down); never forwarded as a placement.
const ROLE_REGEXP = new RegExp(HERDR_ROLE_PATTERN);
const SAFE_NAME_REGEXP = ROLE_REGEXP;
const MAX_FIELD_BYTES = 4 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
const COMMAND_TIMEOUT_MS = 135_000;
const AGENT_READY_TIMEOUT_MS = 120_000;
// The active Pi profile's model roll is user configuration, read read-only.
// It resolves from PI_CODING_AGENT_DIR (the active profile directory); only
// when that env var is unset does it fall back to the default per-user path
// the installed agent model catalog (recorded in the package design record).
function resolvePiModelsPath() {
  const profileDir = process.env.PI_CODING_AGENT_DIR;
  if (typeof profileDir === "string" && profileDir.trim()) {
    return join(profileDir.trim(), "models.json");
  }
  return join(homedir(), ".pi", "agent", "models.json");
}
// A model selection is either a unique local model id or a provider followed
// by one or more bounded model-id segments. Pi model IDs may use colons, but
// provider names may not. validateSpawnParams separately bounds total length.
const MODEL_ID_REGEXP = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._:-]{0,127})+|[A-Za-z0-9]+(?: [A-Za-z0-9]+){1,8})$/;
// Closed response keys. Shapes beyond `.result.move_result.pane.pane_id` are
// provisional from tagged-source evidence (Tranche 07) and fail closed on
// anything extra.
const WRAPPER_FIELDS = new Set(["id", "result", "error"]);
const START_RESULT_FIELDS = new Set(["type", "agent", "argv"]);
// `pane get` shape is unverified live (help evidence only); this closed set is
// deliberately generous over Herdr pane metadata but still bounded.
// Real live pane_id format is workspace-scoped, e.g. `w5:p46` (Herdr 0.7.5
// pane get live evidence); colons and dots are part of identity.
const PANE_ID_REGEXP = /^[A-Za-z0-9_.:-]{1,128}$/;
const PANE_RESULT_FIELDS = new Set(["type", "pane", "pane_id", "cwd", "foreground_cwd"]);

export const HERDR_SPAWN_WORKER_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    placement: { type: "string", enum: SPAWN_PLACEMENTS },
    role: { type: "string", pattern: HERDR_ROLE_PATTERN, maxLength: 64 },
    model: { type: "string", pattern: MODEL_ID_REGEXP.source, maxLength: 192 },
    kind: { type: "string", enum: ["pi", "codex"] },
    account: { type: "string", pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$", maxLength: 128 },
    repository: { type: "string", pattern: SAFE_NAME_REGEXP.source, maxLength: 64 },
    // Optional bounded worktree target. It is a request, never authority: it
    // must resolve to the canonical Git worktree root of the registered
    // repository and carry an active Treehouse lease observed read-only.
    worktreePath: { type: "string", minLength: 1, maxLength: 1024 },
    workspace: { type: "string", minLength: 1, maxLength: 128 },
    authority: { type: "object", additionalProperties: false, properties: { ledgerId: { type: "string" } }, required: ["ledgerId"] },
  },
  required: ["placement", "role", "model", "repository"],
});

function lifecycleError(code, message, status = "blocked") {
  const error = new Error(message);
  error.name = "HerdrLifecycleError";
  error.code = code;
  error.status = status;
  return error;
}

function errorResult(error, extra = {}) {
  const known = error?.code
    ? error
    : lifecycleError("unexpected_adapter_failure", "the Herdr lifecycle adapter failed");
  return {
    schema: HERDR_LIFECYCLE_SCHEMA,
    ok: false,
    status: known.status || "blocked",
    code: known.code,
    reason: known.message,
    nonAuthorizing: true,
    authorityCreated: false,
    ...extra,
  };
}

function layoutCleanupGuidance(partial, paneId, tabId, kind) {
  if (partial === "pane_created") {
    return paneId
      ? `Run \`herdr pane close ${paneId}\` manually to remove the empty pane; no automatic close was performed.`
      : "Run `herdr pane list` to identify the created pane and `herdr pane close <pane_id>` manually; no automatic close was performed.";
  }
  if (partial === "tab_created") {
    return tabId
      ? `Run \`herdr tab close ${tabId}\` manually to remove the empty tab; no automatic close was performed.`
      : "Run `herdr tab list` to identify the created tab and `herdr tab close <tab_id>` manually; no automatic close was performed.";
  }
  if (kind === "codex") return "The Codex agent is uncertified; do not use it. Close it manually. No automatic retry or cleanup was performed.";
  return `The worker agent is live and usable${paneId ? ` in pane ${paneId}` : ""}; use it as-is or close it manually. No automatic retry or cleanup was performed.`;
}

function partialResult(error, { partial = "tab_created", paneId, tabId, role, kind, modelArgv, rawResponse, warnings = [] } = {}) {
  const code = typeof error?.code === "string" ? error.code : "unexpected_adapter_failure";
  const message = typeof error?.message === "string" && error.message
    ? error.message
    : "the Herdr lifecycle adapter failed";
  const cleanup = layoutCleanupGuidance(partial, paneId, tabId, kind);
  const boundedRaw = typeof rawResponse === "string" && rawResponse
    && Buffer.byteLength(rawResponse, "utf8") <= MAX_PROCESS_OUTPUT_BYTES
    ? rawResponse
    : undefined;
  return errorResult(lifecycleError(code, `${message}; ${cleanup}`, "partial"), {
    status: "partial",
    partial,
    paneId: paneId ?? null,
    tabId: tabId ?? null,
    role,
    warnings,
    ...(Array.isArray(modelArgv) ? { modelArgv: [...modelArgv] } : {}),
    cleanup,
    ...(boundedRaw !== undefined ? { rawResponse: boundedRaw } : {}),
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertBoundedString(value, label) {
  if (typeof value !== "string" || !value.trim()
      || Buffer.byteLength(value, "utf8") > MAX_FIELD_BYTES) {
    throw lifecycleError("unexpected_result", `Herdr returned a malformed ${label}`);
  }
  return value;
}

function isCoordinatorRole(value) {
  return value === HERDR_ROLE_POLICY.coordinatorPrefix
    || value.startsWith(`${HERDR_ROLE_POLICY.coordinatorPrefix}-`);
}

export function reportMarkersForRole(role) {
  const label = role.toUpperCase().replaceAll("-", "_");
  return Object.freeze({
    open: `[${label}_REPORT_BEGIN]`,
    close: `[${label}_REPORT_END]`,
  });
}

export function validateSpawnParams(params, options = {}) {
  if (!isPlainObject(params)) {
    throw lifecycleError("invalid_parameters", "spawn parameters must be an object", "denied");
  }
  const requiredKeys = ["placement", "role", "model", "repository"];
  const optionalKeys = ["worktreePath", "workspace", "authority", "kind", "account"];
  const keys = Object.keys(params);
  if (keys.length < requiredKeys.length || keys.length > requiredKeys.length + optionalKeys.length
      || requiredKeys.some((k) => !keys.includes(k))
      || keys.some((k) => !requiredKeys.includes(k) && !optionalKeys.includes(k))
      || (params.authority !== undefined && (!isPlainObject(params.authority) || Object.keys(params.authority).length !== 1 || typeof params.authority.ledgerId !== "string"))) {
    throw lifecycleError("closed_parameters", "spawn_worker accepts placement, role, model, repository, and optional worktreePath, workspace, authority ledgerId, kind, or account", "denied");
  }
  const { placement, role, model, repository, worktreePath, workspace, kind = "pi", account } = params;
  if (kind === "pi" && isCodexAccountModel(model, options.codexAccountsPath)) {
    throw lifecycleError("codex_model_denied", "Codex account models require explicit Codex kind and account", "denied");
  }
  if (!["pi", "codex"].includes(kind) || (kind === "codex" ? !account || !params.authority : account !== undefined)) {
    throw lifecycleError("codex_scope_denied", "Codex requires a scoped approval and account; Pi cannot select an account", "denied");
  }
  if (workspace !== undefined && (typeof workspace !== "string" || workspace.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspace))) {
    throw lifecycleError("workspace_invalid", "workspace must be a bounded workspace id or label", "denied");
  }
  if (worktreePath !== undefined) {
    if (typeof worktreePath !== "string" || worktreePath.length > 1024 || !worktreePath.trim()
        || worktreePath.includes("\0")) {
      throw lifecycleError("worktree_target_invalid", "worktreePath must be a bounded absolute path", "denied");
    }
    // A relative target is refused here; canonical/realpath identity is
    // decided later against real Git and Treehouse evidence.
    if (!worktreePath.startsWith("/")) {
      throw lifecycleError("worktree_target_invalid", "worktreePath must be an absolute path", "denied");
    }
  }
  if (!SPAWN_PLACEMENTS.includes(placement)) {
    throw lifecycleError("unsupported_placement", "placement must be tab, right, or below", "denied");
  }
  if (typeof role !== "string" || role.length > 64 || !ROLE_REGEXP.test(role) || isCoordinatorRole(role)) {
    throw lifecycleError("target_role_denied", "the role must be a valid non-coordinator safe name", "denied");
  }
  if (typeof repository !== "string" || repository.length > 64 || !SAFE_NAME_REGEXP.test(repository)
      || repository.includes("/") || repository.includes("..")) {
    throw lifecycleError("repository_name_denied", "the repository must be a registry safe name", "denied");
  }
  if (typeof model !== "string" || model.length > 192 || !MODEL_ID_REGEXP.test(model)) {
    throw lifecycleError("model_denied", "the model must be an installed Pi provider/id or unique model id", "denied");
  }
  return {
    placement, role, model, repository,
    ...(params.kind ? { kind } : {}),
    ...(account ? { account } : {}),
    ...(worktreePath === undefined ? {} : { worktreePath }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(params.authority ? { authority: params.authority } : {}),
  };
}

function parseJsonEnvelope(raw, label, { requireResult = false } = {}) {
  if (typeof raw !== "string" || !raw.trim()
      || Buffer.byteLength(raw, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
    throw lifecycleError("unexpected_result", `Herdr ${label} returned unusable output`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw lifecycleError("malformed_json", `Herdr ${label} returned malformed JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw lifecycleError("malformed_json", `Herdr ${label} returned a malformed response envelope`);
  }
  if (isPlainObject(parsed.error)) {
    throw lifecycleError("herdr_process_failed", `Herdr ${label} returned an error envelope`);
  }
  // Read-back calls may receive a bare result in test seams, but mutations
  // that create identity must use the complete socket result envelope.
  if (Object.prototype.hasOwnProperty.call(parsed, "result")) {
    const allowed = requireResult ? new Set(["id", "result"]) : WRAPPER_FIELDS;
    if (Object.keys(parsed).some((key) => !allowed.has(key)) || !isPlainObject(parsed.result)) {
      throw lifecycleError("malformed_json", `Herdr ${label} returned a malformed response envelope`);
    }
    return parsed.result;
  }
  if (requireResult) {
    throw lifecycleError("malformed_json", `Herdr ${label} returned a bare result instead of a response envelope`);
  }
  return parsed;
}

function closedShape(value, allowed, code, message) {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw lifecycleError(code, message);
  }
  return value;
}

function paneIdentity(value, label) {
  // Live 0.7.5 pane_info shape: identity fields required, every other
  // observed (optional) pane field tolerated (agent may be absent,
  // agent_status "unknown", scroll an object, terminal_title* absent).
  const pane = isPlainObject(value) ? value : null;
  if (!pane) {
    throw lifecycleError("unexpected_result", `${label} returned no pane object`);
  }
  const paneId = pane.pane_id;
  if (typeof paneId !== "string" || !PANE_ID_REGEXP.test(paneId)) {
    throw lifecycleError("unexpected_result", `${label} returned a malformed pane identifier`);
  }
  return pane;
}

function parseCurrentPane(raw) {
  // Step 1 (read-only): capture the coordinator pane identity. The response
  // is the pane_info shape; pane_id and tab_id are both required.
  const result = parseJsonEnvelope(raw, "pane current");
  const pane = paneIdentity(isPlainObject(result.pane) ? result.pane : result, "pane current");
  const tabId = pane.tab_id;
  if (typeof tabId !== "string" || !PANE_ID_REGEXP.test(tabId)) {
    throw lifecycleError("unexpected_result", "pane current returned a malformed tab identifier");
  }
  return { paneId: pane.pane_id, tabId };
}

function parseTabCreate(raw) {
  // Step 2 (first mutation): parse ONLY .result.root_pane.pane_id and
  // .result.tab.tab_id; nothing else in the tab-create response is trusted.
  const result = parseJsonEnvelope(raw, "tab create", { requireResult: true });
  const rootPaneId = isPlainObject(result.root_pane) ? result.root_pane.pane_id : undefined;
  const tabId = isPlainObject(result.tab) ? result.tab.tab_id : undefined;
  if (typeof rootPaneId !== "string" || !PANE_ID_REGEXP.test(rootPaneId)
      || typeof tabId !== "string" || !PANE_ID_REGEXP.test(tabId)) {
    throw lifecycleError("unexpected_result", "tab create returned a malformed tab or root pane identifier");
  }
  return { rootPaneId, tabId };
}

function parsePaneSplit(raw, coordinatorTabId) {
  const result = parseJsonEnvelope(raw, "pane split", { requireResult: true });
  const pane = paneIdentity(result.pane, "pane split");
  const tabId = typeof pane.tab_id === "string" ? pane.tab_id : coordinatorTabId;
  if (!PANE_ID_REGEXP.test(tabId)) {
    throw lifecycleError("unexpected_result", "pane split returned a malformed tab identifier");
  }
  return { paneId: pane.pane_id, tabId };
}

function collectString(values, label) {
  const unique = [...new Set(values.filter((v) => v !== undefined && v !== null))];
  if (unique.length !== 1) throw lifecycleError("unexpected_result", `Herdr returned conflicting or missing ${label}`);
  return assertBoundedString(unique[0], label);
}

function sameRealPath(value, canonicalRoot) {
  // Fail closed: an unresolvable observed path is never the trusted root.
  try {
    return realpathSync(value) === canonicalRoot;
  } catch {
    return false;
  }
}

function observedAgent(value, operation) {
  if (!isPlainObject(value)
      || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
    throw lifecycleError("unexpected_result", `${operation} returned a malformed agent object`);
  }
  return value;
}

function readBackAgent(raw, expectedRole, canonicalRoot, modelArgvTail, expectedKind = "pi") {
  const result = closedShape(parseJsonEnvelope(raw, "agent get"), new Set(["type", "agent"]), "malformed_json", "agent get returned fields outside the closed result shape");
  // Herdr adds observational metadata over time (for example
  // state_change_seq and terminal_title). Keep the envelope closed, but
  // validate the bounded agent object by required identity facts rather than
  // rejecting legitimate metadata.
  const agent = observedAgent(result.agent, "agent get");
  const role = collectString([agent.name, agent.role], "agent name");
  // The live alias could be renamed post-hoc; coordinator-class read-back is
  // denied here as well, not only at input validation.
  if (isCoordinatorRole(role)) {
    throw lifecycleError("target_role_denied", "the agent get read-back returned a coordinator-class role", "denied");
  }
  if (role !== expectedRole) throw lifecycleError("stale_role_mapping", "the spawned role is no longer mapped to the expected live agent");
  const kind = collectString([agent.agent, agent.agent_kind, agent.kind], "agent kind");
  if (kind !== expectedKind) throw lifecycleError("agent_mismatch", "the spawned agent kind does not match the request");
  const paneId = collectString([agent.pane_id], "agent pane id");
  const cwd = collectString([agent.cwd, agent.foreground_cwd], "agent cwd");
  if (!sameRealPath(cwd, canonicalRoot)) {
    throw lifecycleError("repository_mismatch", "the spawned agent is not in the canonical trusted repository");
  }
  if (agent.launch_pending === true || agent.interactive_ready === false) {
    throw lifecycleError("role_not_ready", "the spawned agent is not observed ready");
  }
  return { paneId, pid: agent.pid };
}

function readBackStart(raw, expectedRole, canonicalRoot, modelArgvTail, expectedKind = "pi") {
  const result = closedShape(parseJsonEnvelope(raw, "agent start"), START_RESULT_FIELDS, "malformed_json", "agent start returned fields outside the closed result shape");
  if (result.type !== "agent_started") {
    throw lifecycleError("unexpected_result", "agent start did not return agent_started");
  }
  const argv = result.argv;
  if (!Array.isArray(argv) || argv.length < 2 || argv.some((item) => typeof item !== "string")
      || Buffer.byteLength(JSON.stringify(argv), "utf8") > MAX_FIELD_BYTES) {
    throw lifecycleError("unexpected_result", "agent start returned a malformed launch argv");
  }
  const tail = argv.slice(-modelArgvTail.length);
  if (JSON.stringify(tail) !== JSON.stringify(modelArgvTail)) {
    throw lifecycleError("model_argv_mismatch", "the launch argv does not end with the validated model selection");
  }
  const agent = observedAgent(result.agent, "agent start");
  const role = collectString([agent.name, agent.role], "agent name");
  if (isCoordinatorRole(role)) {
    throw lifecycleError("target_role_denied", "agent start returned a coordinator-class role", "denied");
  }
  if (role !== expectedRole) throw lifecycleError("stale_role_mapping", "agent start returned a different role");
  const kind = collectString([agent.agent, agent.agent_kind, agent.kind], "agent kind");
  if (kind !== expectedKind) throw lifecycleError("agent_mismatch", "the started agent kind does not match the request");
  if (agent.launch_pending === true || agent.interactive_ready === false) {
    throw lifecycleError("role_not_ready", "the started agent is not observed ready");
  }
  const paneId = collectString([agent.pane_id], "agent pane id");
  const cwd = collectString([agent.cwd, agent.foreground_cwd], "agent cwd");
  if (!sameRealPath(cwd, canonicalRoot)) {
    throw lifecycleError("repository_mismatch", "the started agent is not in the canonical trusted repository");
  }
  return paneId;
}

function readBackPane(raw, expectedPaneId, canonicalRoot) {
  const result = closedShape(parseJsonEnvelope(raw, "pane get"), PANE_RESULT_FIELDS, "malformed_json", "pane get returned fields outside the closed result shape");
  // Live pane_info carries many optional fields (scroll, agent_status,
  // agent, terminal_title*, state_change_seq, ...); require identity + cwd
  // and tolerate the observed shape instead of a closed field set.
  const pane = isPlainObject(result.pane) ? result.pane : result;
  if (!isPlainObject(pane)) {
    throw lifecycleError("unexpected_result", "pane get returned no pane object");
  }
  const paneId = collectString([pane.pane_id], "pane id");
  if (!PANE_ID_REGEXP.test(paneId)) throw lifecycleError("unexpected_result", "pane get returned a malformed pane identifier");
  if (paneId !== expectedPaneId) throw lifecycleError("pane_mismatch", "pane get returned a different pane identity");
  const cwd = collectString([pane.cwd, pane.foreground_cwd], "pane cwd");
  if (!sameRealPath(cwd, canonicalRoot)) {
    throw lifecycleError("repository_mismatch", "the created pane is not in the canonical trusted repository");
  }
  return paneId;
}

// --- Trusted repository resolution (realpath + Git root) --------------------

const GIT_PROBE_TIMEOUT_MS = 10_000;

// Repository-selection environment is process input, never tool input, but an
// inherited GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE would silently redirect an
// authoritative Git probe to another repository. Every lifecycle Git probe
// therefore runs with all GIT_* variables removed, bounded by timeout and
// fixed argv with shell:false. This is host-level defense in depth: it does not
// claim containment of a deliberately hostile parent process tree.
function controlledEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^GIT_/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function gitProbe(path, args, code = "repository_not_git_root") {
  const value = spawnSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    shell: false,
    env: controlledEnv(),
    timeout: GIT_PROBE_TIMEOUT_MS,
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (value.error || value.status !== 0 || typeof value.stdout !== "string" || !value.stdout.trim()) {
    throw lifecycleError(code, "an authoritative Git probe could not be completed");
  }
  return value.stdout.trim();
}

function gitRoot(path) {
  return resolve(gitProbe(path, ["rev-parse", "--show-toplevel"]));
}

// Profile configuration is read only; repository names are checked at use.
function resolveProfileConfigPath(relative) {
  const profileDir = process.env.PI_CODING_AGENT_DIR;
  const base = typeof profileDir === "string" && profileDir.trim()
    ? resolve(profileDir.trim())
    : resolve(homedir(), ".pi", "agent");
  return { base, path: resolve(base, relative) };
}

export function resolveTrustedSpawnRepository(coordinatorCwd, requestedName) {
  const coordinator = resolve(coordinatorCwd);
  let coordinatorReal;
  try {
    coordinatorReal = realpathSync(coordinator);
  } catch {
    throw lifecycleError("repository_unavailable", "the coordinator repository is unavailable");
  }
  if (typeof requestedName !== "string" || !SAFE_NAME_REGEXP.test(requestedName)) {
    throw lifecycleError("repository_untrusted", "the requested repository name is invalid", "denied");
  }
  const sibling = resolve(coordinatorReal, "..", requestedName);
  let candidate = sibling;
  let candidateReal;
  try {
    candidateReal = realpathSync(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT") throw lifecycleError("repository_unavailable", "the requested repository is unavailable");
    candidate = resolve(homedir(), requestedName);
    try { candidateReal = realpathSync(candidate); }
    catch { throw lifecycleError("repository_unavailable", "the requested repository is unavailable"); }
  }
  if (candidateReal !== candidate) {
    throw lifecycleError("repository_untrusted", "the requested repository entry is not canonical", "denied");
  }
  let standaloneRoot = false;
  try {
    standaloneRoot = statSync(candidateReal).isDirectory()
      && !lstatSync(candidate).isSymbolicLink()
      && lstatSync(resolve(candidateReal, ".git")).isDirectory();
  } catch { /* missing or non-directory .git is not a standalone repository */ }
  if (basename(candidate) !== basename(candidate).toLowerCase() || !standaloneRoot) {
    throw lifecycleError("repository_not_git_root", "the requested repository must be a lowercase, canonical Git repository root (not a worktree or symlink)", "denied");
  }
  const root = gitRoot(candidateReal);
  if (statIdentity(root, "repository_not_git_root", "Git root")
      !== statIdentity(candidateReal, "repository_not_git_root", "requested repository")) {
    throw lifecycleError("repository_not_git_root", "the requested repository resolved outside its Git root", "denied");
  }
  try {
    const dotGit = join(candidateReal, ".git");
    const common = gitProbe(candidateReal, ["rev-parse", "--git-common-dir"]);
    if (!statSync(dotGit).isDirectory() || realpathSync(dotGit) !== dotGit
        || statIdentity(resolve(candidateReal, common), "repository_not_git_root", "Git common directory")
          !== statIdentity(dotGit, "repository_not_git_root", "primary Git directory")) throw new Error("non-primary Git directory");
  } catch {
    throw lifecycleError("repository_not_git_root", "the requested repository is not a primary clone", "denied");
  }
  // The configured owner is a policy predicate, not a list of names. Do not
  // infer ownership from a directory name or from a model-provided remote.
  let policy;
  try {
    const path = resolveProfileConfigPath("config/relay-authority.v1.json").path;
    if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error("non-canonical policy");
    policy = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw lifecycleError("repository_policy_unavailable", "the configured repository owner could not be verified", "denied");
  }
  const owner = policy?.githubOwner;
  if (policy?.schema !== "relay-authority.v1" || typeof owner !== "string"
      || !/^[a-zA-Z0-9-]{1,39}$/.test(owner)
      || !Array.isArray(policy.denyRepositories)
      || policy.denyRepositories.some((pattern) => typeof pattern !== "string" || !/^[a-z0-9*-]{1,64}$/.test(pattern))
      || (policy.enforceSpawnDenyRepositories !== undefined && typeof policy.enforceSpawnDenyRepositories !== "boolean")) {
    throw lifecycleError("repository_policy_invalid", "the configured repository owner policy is invalid", "denied");
  }
  if (policy.enforceSpawnDenyRepositories === true && policy.denyRepositories.some((pattern) => pattern === requestedName
      || (pattern.endsWith("*") && requestedName.startsWith(pattern.slice(0, -1))))) {
    throw lifecycleError("repository_denied", "the requested repository is excluded by policy", "denied");
  }
  let origin;
  try { origin = gitProbe(candidateReal, ["config", "--local", "--get", "remote.origin.url"]); }
  catch { throw lifecycleError("repository_origin_untrusted", "the repository origin could not be verified", "denied"); }
  // Private-first checkouts can be named for the public project while their
  // origin is the owner's private development repository. Compare the owner,
  // not the checkout basename; the remote repo name must still be bounded.
  const ssh = new RegExp(`^git@github\\.com:${owner}/([a-zA-Z0-9][a-zA-Z0-9-]{0,63})(?:\\.git)?$`);
  const https = new RegExp(`^https://github\\.com/${owner}/([a-zA-Z0-9][a-zA-Z0-9-]{0,63})(?:\\.git)?$`);
  const remoteName = origin.match(ssh)?.[1] ?? origin.match(https)?.[1];
  if (!remoteName || (policy.enforceSpawnDenyRepositories === true && policy.denyRepositories.some((pattern) => pattern === remoteName
      || (pattern.endsWith("*") && remoteName.startsWith(pattern.slice(0, -1)))))) {
    throw lifecycleError("repository_origin_untrusted", "the repository origin is not eligible under the configured owner", "denied");
  }
  return candidateReal;
}

// --- Optional worktree target (real Git identity + Treehouse lease) ---------
// The requested worktreePath is a request, never authority. It is trusted only
// when ALL of the following hold, each observed read-only:
//   1. it is absolute, lexically canonical, and resolves (realpath) to itself,
//      so a symlink, a `..` segment, or a copied directory never qualifies;
//   2. it is a genuine registered linked worktree of the registry-authorized
//      canonical repository: same Git common directory, a per-worktree
//      administrative directory under <common>/worktrees/<name>, and an exact
//      `gitdir` backpointer from that administrative directory to the target's
//      own `.git` file. Root/common-dir string equality alone is NOT identity;
//   3. the stable physical identity of the target directory, canonical
//      repository root, common directory, and administrative directory
//      (device + inode) is bound, so a rename-and-recreate at identical paths
//      is a different target. HEAD and dirty/clean state are deliberately NOT
//      identity: an ordinary legitimately dirty worktree stays valid;
//   4. Treehouse reports exactly one active lease on that path and its lease id
//      is bound for the rest of the operation.
// The bound identity is re-observed after confirmation, after coordinator pane
// observation and immediately before the split, between mutations, after agent
// start, and after the final read-back; any change fails closed with truthful
// partial state.
const MAX_WORKTREE_PATH_CHARS = 1024;
const LEASE_ID_REGEXP = /^[a-f0-9]{32}$/i;
const TREEHOUSE_STATUS_TIMEOUT_MS = 10_000;

function treehouseStatusJson(options, targetPath) {
  const injected = options?.treehouseStatus;
  if (typeof injected === "function") {
    const value = injected(targetPath);
    if (value && typeof value.then === "function") {
      throw lifecycleError("worktree_lease_untrusted", "asynchronous Treehouse evidence is not supported");
    }
    return value;
  }
  if (typeof injected === "string") return injected;
  // Production path: the read-only status query only. No lease acquire, no
  // return, no prune, no mutation of any kind. Repository-selection variables
  // are stripped for the same reason as the Git probes.
  const result = spawnSync("treehouse", ["status", "--json"], {
    encoding: "utf8",
    shell: false,
    cwd: targetPath,
    env: controlledEnv(),
    timeout: TREEHOUSE_STATUS_TIMEOUT_MS,
    maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw lifecycleError("worktree_lease_untrusted", "the Treehouse lease state could not be read", "denied");
  }
  return result.stdout;
}

function gitCommonDir(path) {
  try {
    return realpathSync(gitProbe(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      "worktree_target_invalid"));
  } catch {
    return null;
  }
}

function gitAbsoluteDir(path) {
  try {
    return realpathSync(gitProbe(path, ["rev-parse", "--absolute-git-dir"], "worktree_target_invalid"));
  } catch {
    return null;
  }
}

function statIdentity(path, code, label) {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw lifecycleError(code, `${label} could not be observed`);
  }
  if (!stats.isDirectory()) {
    throw lifecycleError(code, `${label} is not a directory`);
  }
  return `${stats.dev}:${stats.ino}`;
}

function fileIdentity(path, code, label) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw lifecycleError(code, `${label} could not be observed`);
  }
  if (!stats.isFile()) {
    throw lifecycleError(code, `${label} is not a regular file`);
  }
  return `${stats.dev}:${stats.ino}`;
}

function containedWorktreeAdminDir(commonDir, adminDir) {
  // A linked worktree's administrative directory is one direct child of
  // <common>/worktrees. Anything else is not a registered linked worktree.
  const root = join(commonDir, "worktrees");
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    return null;
  }
  if (rootReal !== root) return null;
  const prefix = `${root}/`;
  if (!adminDir.startsWith(prefix)) return null;
  const name = adminDir.slice(prefix.length);
  if (!name || name.includes("/") || name === "." || name === "..") return null;
  return adminDir;
}

function assertCanonicalWorktreePath(worktreePath) {
  if (typeof worktreePath !== "string" || worktreePath.length > MAX_WORKTREE_PATH_CHARS
      || !worktreePath.startsWith("/") || worktreePath.trim() !== worktreePath) {
    throw lifecycleError("worktree_target_invalid", "worktreePath must be a bounded absolute path", "denied");
  }
  // Lexical canonicality: reject `..`, doubled separators, and a trailing
  // separator even when the filesystem would resolve them.
  if (resolve(worktreePath) !== worktreePath) {
    throw lifecycleError("worktree_target_invalid", "worktreePath is not lexically canonical", "denied");
  }
  let observedReal;
  try {
    observedReal = realpathSync(worktreePath);
  } catch {
    throw lifecycleError("worktree_target_unavailable", "worktreePath does not exist", "denied");
  }
  if (observedReal !== worktreePath) {
    throw lifecycleError("worktree_target_invalid", "worktreePath resolves through a link or is not canonical", "denied");
  }
  return observedReal;
}

function worktreeAdministrativeIdentity(targetReal, canonicalRoot) {
  if (targetReal === canonicalRoot) {
    throw lifecycleError("worktree_target_untrusted", "worktreePath is the canonical repository root, not a worktree", "denied");
  }
  let targetRoot;
  try {
    targetRoot = gitRoot(targetReal);
  } catch {
    throw lifecycleError("worktree_target_invalid", "worktreePath is not a Git work tree root", "denied");
  }
  if (realpathSync(targetRoot) !== targetReal) {
    throw lifecycleError("worktree_target_invalid", "worktreePath is not the Git work tree root", "denied");
  }
  const registeredCommon = gitCommonDir(canonicalRoot);
  const targetCommon = gitCommonDir(targetReal);
  if (!registeredCommon || !targetCommon || registeredCommon !== targetCommon) {
    throw lifecycleError("worktree_target_untrusted", "worktreePath is not a worktree of the registered repository", "denied");
  }
  const adminDir = gitAbsoluteDir(targetReal);
  const registeredAdminDir = containedWorktreeAdminDir(registeredCommon, adminDir ?? "");
  if (!adminDir || !registeredAdminDir) {
    throw lifecycleError("worktree_target_untrusted", "worktreePath has no registered per-worktree Git administration", "denied");
  }
  // Genuine backpointer: the administrative directory must point back at THIS
  // worktree's own .git file. A copied .git pointer that borrows another
  // slot's administration fails here even when root/common-dir match.
  const dotGit = join(targetReal, ".git");
  let dotGitStats;
  try {
    dotGitStats = lstatSync(dotGit);
  } catch {
    throw lifecycleError("worktree_target_untrusted", "worktreePath has no Git worktree pointer", "denied");
  }
  if (!dotGitStats.isFile() || dotGitStats.isSymbolicLink()) {
    throw lifecycleError("worktree_target_untrusted", "worktreePath does not use a linked-worktree Git pointer", "denied");
  }
  let pointerText;
  try {
    pointerText = readFileSync(dotGit, "utf8").trim();
  } catch {
    throw lifecycleError("worktree_target_untrusted", "worktreePath Git pointer is unreadable", "denied");
  }
  if (!pointerText.startsWith("gitdir: ")) {
    throw lifecycleError("worktree_target_untrusted", "worktreePath Git pointer is malformed", "denied");
  }
  let pointerAdmin;
  try {
    pointerAdmin = realpathSync(resolve(targetReal, pointerText.slice("gitdir: ".length).trim()));
  } catch {
    throw lifecycleError("worktree_target_untrusted", "worktreePath Git pointer does not resolve", "denied");
  }
  if (pointerAdmin !== adminDir) {
    throw lifecycleError("worktree_target_untrusted", "worktreePath Git pointer names a different administrative directory", "denied");
  }
  let backpointerText;
  try {
    backpointerText = readFileSync(join(adminDir, "gitdir"), "utf8").trim();
  } catch {
    throw lifecycleError("worktree_target_untrusted", "worktreePath Git administrative record is unreadable", "denied");
  }
  let backpointer;
  try {
    backpointer = realpathSync(resolve(adminDir, backpointerText));
  } catch {
    throw lifecycleError("worktree_target_untrusted", "worktreePath Git administrative backpointer does not resolve", "denied");
  }
  let dotGitReal;
  try {
    dotGitReal = realpathSync(dotGit);
  } catch {
    throw lifecycleError("worktree_target_untrusted", "worktreePath Git pointer cannot be canonicalized", "denied");
  }
  if (backpointer !== dotGitReal) {
    throw lifecycleError("worktree_target_untrusted", "worktreePath Git administrative backpointer names a different worktree", "denied");
  }
  return Object.freeze({
    repositoryPath: canonicalRoot,
    target: targetReal,
    commonDir: registeredCommon,
    adminDir,
    dotGit: dotGitReal,
    targetIdentity: statIdentity(targetReal, "worktree_target_untrusted", "the worktree target"),
    repositoryIdentity: statIdentity(canonicalRoot, "worktree_target_untrusted", "the registered repository"),
    commonIdentity: statIdentity(registeredCommon, "worktree_target_untrusted", "the Git common directory"),
    adminIdentity: statIdentity(adminDir, "worktree_target_untrusted", "the worktree administrative directory"),
    dotGitIdentity: fileIdentity(dotGitReal, "worktree_target_untrusted", "the worktree Git pointer"),
  });
}

function observedLeaseIdentity(targetReal, options) {
  const raw = treehouseStatusJson(options, targetReal);
  if (typeof raw !== "string" || !raw.trim()
      || Buffer.byteLength(raw, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
    throw lifecycleError("worktree_lease_untrusted", "the Treehouse lease evidence is unusable", "denied");
  }
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw lifecycleError("worktree_lease_untrusted", "the Treehouse lease evidence is malformed", "denied");
  }
  if (!Array.isArray(entries) || entries.length > 256) {
    throw lifecycleError("worktree_lease_untrusted", "the Treehouse lease evidence is malformed", "denied");
  }
  const matches = entries.filter((entry) => {
    if (!isPlainObject(entry) || typeof entry.path !== "string" || !entry.path.startsWith("/")) return false;
    try {
      return realpathSync(entry.path) === targetReal;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw lifecycleError("worktree_lease_untrusted", "the worktree target is not a managed pool worktree", "denied");
  }
  const entry = matches[0];
  if (entry.status !== "leased") {
    throw lifecycleError("worktree_lease_untrusted", "the worktree target is not actively leased", "denied");
  }
  if (typeof entry.lease_id !== "string" || !LEASE_ID_REGEXP.test(entry.lease_id)) {
    throw lifecycleError("worktree_lease_untrusted", "the worktree lease identity is not trustworthy", "denied");
  }
  const holder = typeof entry.lease_holder === "string" && entry.lease_holder.length <= 128
    ? entry.lease_holder
    : null;
  return Object.freeze({ leaseId: entry.lease_id.toLowerCase(), holder });
}

function resolveWorktreeIdentity(canonicalRoot, worktreePath, options) {
  const targetReal = assertCanonicalWorktreePath(worktreePath);
  const admin = worktreeAdministrativeIdentity(targetReal, canonicalRoot);
  const lease = observedLeaseIdentity(targetReal, options);
  return Object.freeze({
    worktreePath: targetReal,
    leaseId: lease.leaseId,
    leaseHolder: lease.holder,
    repositoryPath: admin.repositoryPath,
    commonDir: admin.commonDir,
    adminDir: admin.adminDir,
    dotGit: admin.dotGit,
    identity: Object.freeze({
      target: admin.targetIdentity,
      repository: admin.repositoryIdentity,
      common: admin.commonIdentity,
      admin: admin.adminIdentity,
      dotGit: admin.dotGitIdentity,
    }),
  });
}

const verifiedWorktreeTargets = new WeakSet();

export function resolveWorktreeSpawnTarget(canonicalRoot, worktreePath, options = {}) {
  const target = resolveWorktreeIdentity(canonicalRoot, worktreePath, options);
  verifiedWorktreeTargets.add(target);
  return target;
}

export function verifiedWorktreeTargetCovers(target, path, repositoryRoot) {
  return !!target && verifiedWorktreeTargets.has(target)
    && target.worktreePath === path && target.repositoryPath === repositoryRoot;
}

export function worktreeTargetUnchanged(left, right) {
  if (!left || !right) return false;
  if (left.worktreePath !== right.worktreePath || left.leaseId !== right.leaseId) return false;
  if (left.repositoryPath !== right.repositoryPath
      || left.commonDir !== right.commonDir
      || left.adminDir !== right.adminDir
      || left.dotGit !== right.dotGit) {
    return false;
  }
  for (const key of ["target", "repository", "common", "admin", "dotGit"]) {
    if (left.identity?.[key] !== right.identity?.[key]) return false;
  }
  return true;
}

function revalidateWorktreeTarget(canonicalRoot, request, bound, options) {
  if (!request.worktreePath) return null;
  let observed;
  try {
    observed = resolveWorktreeIdentity(canonicalRoot, request.worktreePath, options);
  } catch (error) {
    throw lifecycleError(
      "worktree_target_changed",
      `the confirmed worktree target is no longer valid: ${error?.message || "revalidation failed"}`,
      "blocked",
    );
  }
  if (!worktreeTargetUnchanged(observed, bound)) {
    throw lifecycleError(
      "worktree_target_changed",
      "the worktree physical identity, Git administrative association, or lease identity changed during the spawn",
      "blocked",
    );
  }
  return observed;
}

// Re-check canonical Git root, origin owner and worktree lease at each
// asynchronous boundary; an observed remote or identity change fails closed.
function revalidateSpawnAuthority(coordinatorCwd, requestedName, canonicalRoot, request, bound, options, boundary) {
  const currentRoot = resolveTrustedSpawnRepository(coordinatorCwd, requestedName);
  if (currentRoot !== canonicalRoot) {
    throw lifecycleError("repository_mismatch", `the trusted repository changed ${boundary}`);
  }
  if (request.worktreePath) revalidateWorktreeTarget(currentRoot, request, bound, options);
  return currentRoot;
}

// --- Installed Pi model roll (read-only; no allowlist constant) -------------
// The authoritative installed roll is the merged Pi catalog: built-in provider
// models plus the profile's custom models.json entries. It resolves read-only
// via the documented fixed argv `pi --list-models` table; custom models.json
// entries remain an additional accepted source. The roll is parsed once per
// resolveInstalledModel call and is never cached across calls.
const PROVIDER_TOKEN_REGEXP = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MODEL_TOKEN_REGEXP = /^[a-z0-9][a-z0-9._:-]{0,127}(?:\/[a-z0-9][a-z0-9._:-]{0,127})*$/i;

// Parses the fixed-width provider/model table emitted by `pi --list-models`.
// Only the first two whitespace tokens of each data row are read; the header
// row and anything unparseable are skipped. Returns null for unusable output.
function parseListModelsTable(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_PROCESS_OUTPUT_BYTES) return null;
  const pairs = new Set();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("provider")) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 2) continue;
    const [provider, id] = tokens;
    const pair = `${provider}/${id}`;
    if (pair.length > 192 || !PROVIDER_TOKEN_REGEXP.test(provider)
      || !MODEL_TOKEN_REGEXP.test(id) || !MODEL_ID_REGEXP.test(pair)) continue;
    pairs.add(pair);
  }
  return pairs;
}

// Custom profile entries are an additional accepted source; an unreadable or
// malformed custom file contributes nothing and never blocks roll resolution.
function readCustomModelPairs(modelsPath) {
  let roll;
  try {
    roll = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    return new Set();
  }
  const pairs = new Set();
  const providers = isPlainObject(roll) && isPlainObject(roll.providers) ? roll.providers : {};
  for (const [provider, config] of Object.entries(providers)) {
    const models = isPlainObject(config) && Array.isArray(config.models) ? config.models : [];
    for (const model of models) {
      const pair = `${provider}/${model?.id}`;
      if (isPlainObject(model) && typeof model.id === "string"
          && pair.length <= 192 && PROVIDER_TOKEN_REGEXP.test(provider)
          && MODEL_TOKEN_REGEXP.test(model.id) && MODEL_ID_REGEXP.test(pair)) {
        pairs.add(pair);
      }
    }
  }
  return pairs;
}

// Production roll source: fixed argv, read-only, bounded, no shell.
function runListModels() {
  let result;
  try {
    result = spawnSync("pi", ["--list-models"], {
      encoding: "utf8",
      shell: false,
      timeout: COMMAND_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout;
}

export function resolveInstalledModel(requested, options = {}) {
  let rollOutput = null;
  if (typeof options.listModels === "string") {
    rollOutput = options.listModels;
  } else if (typeof options.listModels === "function") {
    rollOutput = options.listModels();
  } else {
    rollOutput = runListModels();
  }
  const pairs = parseListModelsTable(rollOutput);
  if (pairs === null) {
    throw lifecycleError("model_roll_unavailable", "the installed Pi model roll could not be read");
  }
  const modelsPath = typeof options.modelsPath === "string" && options.modelsPath.trim()
    ? options.modelsPath
    : resolvePiModelsPath();
  for (const pair of readCustomModelPairs(modelsPath)) pairs.add(pair);
  if (typeof requested !== "string" || !MODEL_ID_REGEXP.test(requested)) {
    throw lifecycleError("model_denied", "the requested model is invalid", "denied");
  }
  // The local policy owns names, provider classes, forbidden pairs and budgets.
  // A missing or malformed policy never authorizes an inferred gateway route.
  let policy = options.routePolicy;
  if (policy === undefined) {
    const path = options.policyPath ?? resolveProfileConfigPath("config/model-route-policy.v1.local.json").path;
    try {
      const info = lstatSync(path);
      // A symlink at the file or ANY parent of the path fails closed.
      if (info.isSymbolicLink() || realpathSync(path) !== path) {
        throw lifecycleError("model_policy_symlink", `model routing policy path is a symlink: ${path}`, "denied");
      }
      if (!info.isFile() || info.size > 16_384) {
        throw lifecycleError("model_policy_invalid", `model routing policy file is invalid: ${path}`, "denied");
      }
      policy = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error?.name === "HerdrLifecycleError") throw error;
      if (error?.code === "ENOENT") {
        throw lifecycleError("model_policy_missing", `model routing policy is unavailable: ${path}; fill it in locally before spawning`, "denied");
      }
      throw lifecycleError("model_policy_invalid", `model routing policy could not be read: ${path}`, "denied");
    }
  }
  if (policy?.schema !== "agentic-driver.model-route-policy.v1" || !Array.isArray(policy.routes)
      || !Array.isArray(policy.bannedPairs) || !isPlainObject(policy.budgets)
      || policy.routes.length > 128 || policy.bannedPairs.length > 128
      || policy.routes.some((route) => !isPlainObject(route) || typeof route.provider !== "string"
        || typeof route.model !== "string" || !PROVIDER_TOKEN_REGEXP.test(route.provider)
        || !MODEL_TOKEN_REGEXP.test(route.model) || typeof route.family !== "string"
        || !/^[a-z0-9-]{1,64}$/.test(route.family) || typeof route.subscription !== "boolean"
        || typeof route.gateway !== "boolean" || route.subscription === route.gateway
        || !Array.isArray(route.aliases) || route.aliases.length > 16
        || route.aliases.some((alias) => typeof alias !== "string" || !/^[a-zA-Z0-9 ._-]{1,128}$/.test(alias)))
      || policy.bannedPairs.some((pair) => !isPlainObject(pair)
        || typeof pair.family !== "string" || typeof pair.provider !== "string")
      || new Set(policy.routes.map((route) => `${route.provider}/${route.model}`)).size !== policy.routes.length) {
    throw lifecycleError("model_policy_invalid", "the local model routing policy is invalid", "denied");
  }
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const explicit = requested.includes("/");
  const matching = policy.routes.filter((route) => {
    const pair = `${route.provider}/${route.model}`;
    return pairs.has(pair) && (explicit ? pair === requested
      : [route.model, ...route.aliases].some((alias) => normalize(alias) === normalize(requested)));
  });
  if (!matching.length) {
    // The installed Pi roll is authoritative for an explicit model. New models
    // from a provider already classified solely as subscription do not need a
    // separate route entry; unknown providers and gateway models still do.
    const provider = explicit ? requested.split("/", 1)[0] : null;
    const known = provider ? policy.routes.filter((route) => route.provider === provider) : [];
    if (pairs.has(requested) && known.length && known.every((route) => route.subscription)
        && !known.some((route) => policy.bannedPairs.some((pair) => pair.provider === provider && pair.family === route.family))) {
      if (options.isRouteAvailable?.(requested) === false) {
        throw lifecycleError("model_unavailable", `subscription route ${requested} is unavailable`, "denied");
      }
      return Object.freeze(["--model", requested]);
    }
    throw lifecycleError("model_unknown", "requested model is not an installed subscription route", "denied");
  }
  const family = matching[0].family;
  if (matching.some((route) => route.family !== family)) {
    throw lifecycleError("model_ambiguous", "the name matches multiple model families; specify a provider", "denied");
  }
  const routes = policy.routes.filter((route) => route.family === family && pairs.has(`${route.provider}/${route.model}`));
  const subscriptions = routes.filter((route) => route.subscription);
  // Production currently treats Pi roll membership as availability. The probe
  // seam is test-only until a live non-credential availability signal is wired.
  const available = subscriptions.filter((route) => options.isRouteAvailable?.(`${route.provider}/${route.model}`) !== false);
  const suggestion = subscriptions.length
    ? subscriptions.map((route) => `${route.provider}/${route.model}`).join(", ")
    : "no installed subscription route";
  const banned = (route) => policy.bannedPairs.some((pair) => pair.family === route.family && pair.provider === route.provider);
  if (explicit && banned(matching[0])) {
    throw lifecycleError("model_gateway_denied", `route forbidden; use subscription route ${suggestion}`, "denied");
  }
  if (!explicit && available.length > 1) {
    throw lifecycleError("model_ambiguous", `multiple subscription routes match; specify one: ${suggestion}`, "denied");
  }
  if (!explicit && available.length === 1) {
    if (banned(available[0])) {
      throw lifecycleError("model_gateway_denied", `route forbidden; use another subscription route (available: ${suggestion})`, "denied");
    }
    return Object.freeze(["--model", `${available[0].provider}/${available[0].model}`]);
  }
  if (explicit && matching[0].subscription) {
    // An exact request cannot silently switch to a gateway; only a loose name
    // can use a separately budgeted fallback when its subscription is unavailable.
    if (!available.includes(matching[0])) throw lifecycleError("model_unavailable", `subscription route ${requested} is unavailable`, "denied");
    return Object.freeze(["--model", requested]);
  }
  if (explicit && available.length) {
    throw lifecycleError("model_subscription_preferred", `use subscription route ${suggestion}; explicit provider will not be silently switched`, "denied");
  }
  const eligible = (explicit ? matching : routes).filter((route) => route.gateway && !banned(route));
  if (eligible.length !== 1) {
    throw lifecycleError("model_ambiguous", `requested model has ${eligible.length} eligible gateway routes; specify a provider (subscription: ${suggestion})`, "denied");
  }
  const chosen = eligible[0];
  const budget = policy.budgets[chosen.provider]?.[chosen.model];
  if (budget !== "no-limit" && !(typeof budget === "number" && Number.isFinite(budget) && budget > 0)) {
    throw lifecycleError("model_budget_required", `gateway route ${chosen.provider}/${chosen.model} needs an explicit per-provider, per-model budget or no-limit; subscription route: ${suggestion}`, "denied");
  }
  return Object.freeze(["--model", `${chosen.provider}/${chosen.model}`]);
}

// --- Fixed argv builders ----------------------------------------------------
export function currentPaneArgv() {
  return Object.freeze(["pane", "current", "--current"]);
}

export function tabCreateArgv(canonicalRoot, role, workspaceId, workerEnv = {}) {
  return Object.freeze([
    "tab", "create", "--workspace", workspaceId, "--cwd", canonicalRoot, "--no-focus", "--label", role,
    ...Object.entries(workerEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
  ]);
}

async function availableWorkspace(canonicalRoot, options, signal) {
  return selectedWorkspace(undefined, canonicalRoot, options, signal);
}

async function selectedWorkspace(selection, canonicalRoot, options, signal) {
  const listed = parseJsonEnvelope(await invokeHerdr(["workspace", "list"], canonicalRoot, options, signal), "workspace list");
  if (!Array.isArray(listed.workspaces) || listed.workspaces.length > 128) {
    throw lifecycleError("workspace_unavailable", "workspace list is invalid", "denied");
  }
  const projectMatches = (item) => {
    try { return typeof item?.cwd === "string" && realpathSync(item.cwd) === realpathSync(canonicalRoot); }
    catch { return false; }
  };
  const matches = listed.workspaces.filter((item) => selection
    ? item?.workspace_id === selection || item?.label === selection : projectMatches(item));
  if (matches.length !== 1 || !/^w[A-Za-z0-9]+$/.test(matches[0]?.workspace_id ?? "")) {
    throw lifecycleError("workspace_unavailable", `workspace ${selection ?? "(automatic)"} did not uniquely match project ${canonicalRoot} in workspace list`, "denied");
  }
  if (!projectMatches(matches[0])) {
    throw lifecycleError("workspace_project_mismatch", `workspace ${selection} cwd did not match project ${canonicalRoot}`, "denied");
  }
  return matches[0].workspace_id;
}

export function splitArgv(coordinatorPaneId, canonicalRoot, placement) {
  return Object.freeze([
    "pane", "split", coordinatorPaneId,
    "--direction", HERDR_DIRECTIONS[placement],
    "--cwd", canonicalRoot,
    "--no-focus",
  ]);
}

export function startArgv(role, paneId, modelArgv, kind = "pi") {
  if (!["pi", "codex"].includes(kind)) throw lifecycleError("agent_mismatch", "unsupported agent kind", "denied");
  return Object.freeze([
    "agent", "start", role, "--kind", kind, "--pane", paneId,
    "--timeout", String(AGENT_READY_TIMEOUT_MS), "--", ...modelArgv,
  ]);
}

// --- Herdr invocation -------------------------------------------------------
function normalizeProcessResult(value) {
  if (!isPlainObject(value)) throw lifecycleError("unexpected_process_result", "Herdr returned an invalid process result");
  const stdout = typeof value.stdout === "string" ? value.stdout : "";
  const stderr = typeof value.stderr === "string" ? value.stderr : "";
  const code = value.code ?? value.exitCode ?? value.status ?? 0;
  if (!Number.isInteger(code) || code < 0) {
    throw lifecycleError("unexpected_process_result", "Herdr returned an invalid process status");
  }
  if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
    throw lifecycleError("oversized_process_output", "Herdr returned oversized output");
  }
  return { code, stdout, stderr };
}

async function invokeHerdr(argv, canonicalRoot, options, signal) {
  if (signal?.aborted) throw lifecycleError("aborted", "the spawn operation was aborted");
  // Forward the full options object: the internal testExecutablePath seam
  // (offline fake Herdr process boundary) must reach executable resolution,
  // otherwise offline tests would silently spawn the production binary.
  const executable = resolveTrustedHerdrExecutable(options);
  const spec = {
    executable,
    argv: Object.freeze([...argv]),
    spawnOptions: Object.freeze({
      cwd: canonicalRoot,
      env: process.env,
      shell: false,
    }),
    shell: false,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
  };
  let raw;
  if (typeof options.runProcess === "function") {
    raw = await Promise.resolve(options.runProcess(spec));
  } else {
    // Production path: the shared bounded spawner in the communication adapter
    // is process-level; spawn here is reserved to the fixed argv builders via
    // the same trusted executable pin, so the native spawn seam stays closed.
    // Import statically: dispatch must not yield after the caller's final
    // authority observation and before the actual subprocess is created.
    raw = await new Promise((resolveResult) => {
      const child = spawn(executable, spec.argv, {
        ...spec.spawnOptions,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* terminal result wins */ }
        resolveResult({ code: -1, stdout, stderr });
      }, COMMAND_TIMEOUT_MS);
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", () => { clearTimeout(timer); resolveResult({ code: -1, stdout, stderr }); });
      child.on("close", (code) => { clearTimeout(timer); resolveResult({ code: code ?? -1, stdout, stderr }); });
    });
  }
  const normalized = normalizeProcessResult(raw);
  if (normalized.code !== 0) {
    // Herdr emits bounded structured errors. Preserve only its code/message so
    // a failed start is actionable without exposing arbitrary terminal output.
    let detail = "";
    for (const candidate of [normalized.stdout, normalized.stderr]) {
      try {
        const parsed = JSON.parse(candidate);
        const code = typeof parsed?.error?.code === "string" ? parsed.error.code : "";
        const message = typeof parsed?.error?.message === "string" ? parsed.error.message : "";
        if (code || message) {
          detail = [code, message].filter(Boolean).join(": ");
          break;
        }
      } catch { /* generic bounded process failure below */ }
    }
    throw lifecycleError(
      "herdr_process_failed",
      detail ? `Herdr returned a process failure (${detail})` : "Herdr returned a process failure",
    );
  }
  return normalized.stdout;
}

// Only Herdr's explicit busy response permits another start on the same pane.
function paneReadiness(options) {
  const read = (key, env, fallback) => {
    const value = options[key] ?? process.env[env] ?? fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1 || number > 120_000) {
      throw lifecycleError("invalid_readiness", `${env} must be an integer from 1 to 120000`, "denied");
    }
    return number;
  };
  return {
    timeoutMs: read("paneReadyTimeoutMs", "PAD_HERDR_PANE_READY_TIMEOUT_MS", 15_000),
    pollMs: read("paneReadyPollMs", "PAD_HERDR_PANE_READY_POLL_MS", 250),
  };
}

async function startOnReadyPane(startCall, spawnCwd, options, signal, revalidate, readiness) {
  const now = options.paneReadyNow ?? (() => performance.now());
  const sleep = options.paneReadySleep ?? ((ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)));
  const deadline = now() + readiness.timeoutMs;
  let attempt = 0;
  let lastBusyMessage;
  while (true) {
    if (attempt && now() >= deadline) throw lifecycleError("start_failed", lastBusyMessage);
    if (attempt++) revalidate();
    try { return await invokeHerdr(startCall, spawnCwd, options, signal); }
    catch (error) {
      if (!/\(agent_pane_busy(?:\b|:)/.test(error?.message ?? "")) {
        throw lifecycleError("start_failed", error?.message || "Herdr agent start failed");
      }
      lastBusyMessage = error.message;
      const remaining = deadline - now();
      if (remaining <= 0) throw lifecycleError("start_failed", lastBusyMessage);
      await sleep(Math.min(readiness.pollMs, remaining));
      if (signal?.aborted) throw lifecycleError("start_failed", "the spawn operation was aborted");
    }
  }
}

function agentListArgv() {
  return Object.freeze(["agent", "list"]);
}

function duplicateRoleExists(raw, role) {
  const result = parseJsonEnvelope(raw, "agent list");
  const agents = result.agents;
  if (!Array.isArray(agents) || agents.length > 64) {
    throw lifecycleError("unexpected_result", "agent list returned an invalid bounded agent list");
  }
  return agents.some((agent) => {
    if (!isPlainObject(agent)) return false;
    return [agent.name, agent.role].some((value) => value === role);
  });
}

// Reuse the installed ast-sgrep launcher's platform/checksum resolution. No
// dependency is added to PAD: an absent optional installation only warns.
async function installedAsgrepBinary() {
  const anchors = [
    join(resolveProfileConfigPath(".").base, "npm", "node_modules", "pi-ast-sgrep", "package.json"),
    import.meta.url,
  ];
  for (const anchor of anchors) {
    try {
      const launcher = createRequire(anchor).resolve("ast-sgrep");
      const { resolveBinary } = await import(pathToFileURL(launcher).href);
      return resolveBinary({ env: {} });
    } catch { /* try the package-local installation next */ }
  }
  throw new Error("optional asgrep installation unavailable");
}

function boundedAsgrepTimeout(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number <= 300_000 ? number : fallback;
}

async function workerAsgrepSettings(options, warnings) {
  const config = options.asgrep ?? {};
  const off = /^(?:off|false|0)$/i.test(process.env.PAD_WORKER_ASGREP ?? "");
  if (config === false || (config.enabled ?? !off) === false) return { env: {} };
  try {
    const requestedBinary = config.binary ?? process.env.PAD_WORKER_ASGREP_BIN ?? process.env.ASGREP_BIN;
    const binary = realpathSync(requestedBinary || await installedAsgrepBinary());
    if (!statSync(binary).isFile()) throw new Error("not a file");
    accessSync(binary, fsConstants.X_OK);
    const backend = config.backend ?? process.env.PAD_WORKER_ASGREP_BACKEND ?? "cli";
    const timeout = boundedAsgrepTimeout(config.timeoutMs ?? process.env.PAD_WORKER_ASGREP_TIMEOUT_MS ?? process.env.ASGREP_TIMEOUT_MS, 30_000);
    return {
      binary,
      env: {
        ASGREP_CODEMODE_BACKEND: backend === "napi" ? "napi" : "cli",
        ASGREP_BIN: binary,
        ASGREP_TIMEOUT_MS: String(timeout),
      },
      prewarm: config.prewarm ?? !/^(?:off|false|0)$/i.test(process.env.PAD_WORKER_ASGREP_PREWARM ?? ""),
      indexTimeoutMs: boundedAsgrepTimeout(config.indexTimeoutMs ?? process.env.PAD_WORKER_ASGREP_INDEX_TIMEOUT_MS, 120_000),
    };
  } catch {
    warnings.push({ code: "asgrep_binary_unavailable", message: "Worker asgrep CLI could not be resolved; existing backend behavior is unchanged." });
    return { env: {} };
  }
}

function prewarmWorkerAsgrep(settings, root, warnings, signal) {
  if (!settings.prewarm || !settings.binary) return Promise.resolve();
  // Asynchronous child overlaps agent readiness, never synchronous index work
  // on the coordinator event loop. Only the final spawn receipt waits for it.
  return new Promise((done) => {
    execFile(settings.binary, ["index", root], {
      cwd: root,
      env: { ...controlledEnv(), ...settings.env },
      shell: false,
      timeout: settings.indexTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      signal,
    }, (error) => {
      if (error) {
        const timedOut = error.killed && error.signal === "SIGKILL" && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        warnings.push({
          code: timedOut ? "asgrep_index_timeout" : "asgrep_index_failed",
          message: timedOut ? `Worker asgrep index exceeded ${settings.indexTimeoutMs}ms; spawn continues without prewarming.`
            : "Worker asgrep index failed; spawn continues without prewarming.",
        });
      }
      done();
    });
  }).catch(() => {
    warnings.push({ code: "asgrep_index_failed", message: "Worker asgrep index could not start; spawn continues without prewarming." });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function executeHerdrSpawnWorker(params, context, options = {}, signal) {
  let request;
  const warnings = [];
  let indexReady = Promise.resolve();
  try {
    request = validateSpawnParams(params, options);
    const readiness = paneReadiness(options);
    const { placement, role, model, repository } = request;
    const kind = request.kind ?? "pi";
    // Production has no key-only process environment reader. Deny before any
    // tab or agent can be created rather than leave an uncertified live worker.
    if (kind === "codex" && !hasCodexProcessReader(options)) {
      throw lifecycleError("codex_readback_unavailable", "Codex process verification is unavailable", "denied");
    }
    const checkedCodex = () => {
      try { return codexLaunch(request.account, model, options.codexAccountsPath); }
      catch { throw lifecycleError("codex_account_denied", "Codex account home or model is unavailable", "denied"); }
    };
    const codex = kind === "codex" ? checkedCodex() : null;
    const recheckCodex = () => {
      if (!codex) return;
      const current = checkedCodex();
      if (current.home !== codex.home || current.binaryRealPath !== codex.binaryRealPath
          || current.binaryRealRoot !== codex.binaryRealRoot || current.binaryLaunchPath !== codex.binaryLaunchPath
          || current.argv.join("\0") !== codex.argv.join("\0")) {
        throw lifecycleError("codex_account_denied", "Codex account configuration changed", "denied");
      }
    };
    if (placement !== "tab") throw lifecycleError("worker_tab_required", "workers require a new tab, not a coordinator pane split", "denied");

    // Resolve BEFORE any mutation: registry + realpath + Git root.
    let canonicalRoot = resolveTrustedSpawnRepository(context?.cwd, repository);
    const modelArgv = codex ? codex.argv : resolveInstalledModel(model, options);
    // An optional worktree target is validated read-only here (canonical path,
    // real Git repository identity, active Treehouse lease) and its observed
    // lease identity is bound for the rest of the operation.
    let worktreeTarget = request.worktreePath
      ? resolveWorktreeSpawnTarget(canonicalRoot, request.worktreePath, options)
      : null;
    let spawnCwd = worktreeTarget ? worktreeTarget.worktreePath : canonicalRoot;

    const currentPane = process.env.HERDR_PANE_ID;
    if (!currentPane?.trim() && !request.workspace) {
      throw lifecycleError("workspace_required", "select a workspace id or label when there is no caller pane; use agentic_herdr_communication list or get to discover a worker workspace id", "denied");
    }

    // Duplicate live names are denied at spawn (read-only observation).
    await observeDuplicateRole(canonicalRoot, role, options, signal);
    // Explicit selection is independent of caller pane and must match the live list.
    // Without selection, preserve the existing caller-pane workspace behavior.
    const coordinator = request.workspace ? null
      : parseCurrentPane(await invokeHerdr(currentPaneArgv(), spawnCwd, options, signal));
    const workspaceId = request.workspace
      ? await selectedWorkspace(request.workspace, canonicalRoot, options, signal)
      : coordinator.paneId.split(":")[0];
    if (!/^w[A-Za-z0-9]+$/.test(workspaceId)
        || (coordinator && !coordinator.tabId.startsWith(`${workspaceId}:`))) {
      throw lifecycleError("current_pane_unavailable", "the coordinator workspace could not be identified", "denied");
    }
    let reservedUseId;
    if (request.authority !== undefined) {
      try {
        // A ledger grant is bound to the exact target when a worktree is
        // requested: a repository-only grant never covers an unrecorded path.
        const reservation = await reserveApprovalUse(resolveProfileConfigPath(".").base, request.authority.ledgerId, {
          tier: 1, repository, action: "spawn", model, role,
          ...(codex ? { kind: "codex", account: request.account } : {}),
          ...(worktreeTarget ? { path: worktreeTarget.worktreePath } : {}),
        });
        reservedUseId = reservation.useId;
      } catch (error) {
        return errorResult(lifecycleError("approval_missing", error.message, "needs-owner"), needsOwner(1, ["spawn approval covering repository, model and role"], repository));
      }
    }

    const asgrep = await workerAsgrepSettings(options, warnings);
    // Revalidation point after the asynchronous preflight, before the first mutation.
    canonicalRoot = revalidateSpawnAuthority(
      context?.cwd, repository, canonicalRoot, request, worktreeTarget, options, "after preflight",
    );
    if (request.worktreePath) spawnCwd = worktreeTarget.worktreePath;
    recheckCodex();

    // Start index work only after the target's final preflight identity check.
    indexReady = prewarmWorkerAsgrep(asgrep, spawnCwd, warnings, signal);
    // Use the selected or caller workspace. The authority fence covers the observation.

    const layoutPartial = placement === "tab" ? "tab_created" : "pane_created";
    let layoutRaw;
    let rootPaneId;
    let tabId;
    try {
      if (placement === "tab") {
        layoutRaw = await invokeHerdr(tabCreateArgv(spawnCwd, role, workspaceId, { ...asgrep.env, ...(codex ? { CODEX_HOME: codex.home } : {}) }), spawnCwd, options, signal);
        ({ rootPaneId, tabId } = parseTabCreate(layoutRaw));
        if (!rootPaneId.startsWith(`${workspaceId}:`) || !tabId.startsWith(`${workspaceId}:`)) {
          throw lifecycleError("workspace_mismatch", "the new tab was placed outside the repository workspace", "denied");
        }
      } else {
        layoutRaw = await invokeHerdr(
          splitArgv(coordinator.paneId, spawnCwd, placement),
          spawnCwd, options, signal,
        );
        const split = parsePaneSplit(layoutRaw, coordinator.tabId);
        rootPaneId = split.paneId;
        tabId = split.tabId;
      }
    } catch (error) {
      return partialResult(error, {
        partial: layoutPartial, paneId: rootPaneId, tabId, role, modelArgv, warnings,
        ...(typeof layoutRaw === "string" ? { rawResponse: layoutRaw } : {}),
      });
    }

    let agentStartSucceeded = false;
    try {
      // Re-check registry authorization and the bound target between mutations.
      canonicalRoot = revalidateSpawnAuthority(
        context?.cwd, repository, canonicalRoot, request, worktreeTarget, options, "between mutations",
      );

      // Retry only a busy shell, never layout creation or a different pane.
      recheckCodex();
      const startCall = startArgv(role, rootPaneId, modelArgv, kind);
      const startRaw = await startOnReadyPane(startCall, spawnCwd, options, signal, () => {
        canonicalRoot = revalidateSpawnAuthority(
          context?.cwd, repository, canonicalRoot, request, worktreeTarget, options, "before agent start retry",
        );
        recheckCodex();
      }, readiness);
      agentStartSucceeded = true;

      // Agent start is a mutation, so authorization must be resolved again
      // before accepting any start/read-back facts.
      canonicalRoot = revalidateSpawnAuthority(
        context?.cwd, repository, canonicalRoot, request, worktreeTarget, options, "after agent start",
      );

      const startedPaneId = readBackStart(startRaw, role, spawnCwd, [...modelArgv], kind);
      if (startedPaneId !== rootPaneId) {
        throw lifecycleError("pane_mismatch", "agent start returned a different pane identity");
      }
      const agentRaw = await invokeHerdr(["agent", "get", role], spawnCwd, options, signal);
      const agentReadBack = readBackAgent(agentRaw, role, spawnCwd, [...modelArgv], kind);
      if (codex) {
        recheckCodex();
        try { verifyCodexProcess(agentReadBack, codex, options); }
        catch { throw lifecycleError("codex_readback_mismatch", "Codex process could not be verified", "denied"); }
      }
      if (agentReadBack.paneId !== rootPaneId) {
        throw lifecycleError("pane_mismatch", "agent get returned a different pane identity");
      }
      const paneRaw = await invokeHerdr(["pane", "get", rootPaneId], spawnCwd, options, signal);
      readBackPane(paneRaw, rootPaneId, spawnCwd);
      // Finish best-effort prewarming before this receipt can trigger a brief.
      await indexReady;
      // The read-backs are asynchronous too. A registry, lease, or
      // association change during them must not be reported as a successful
      // spawn.
      revalidateSpawnAuthority(
        context?.cwd, repository, canonicalRoot, request, worktreeTarget, options,
        "during the final read-backs",
      );
      if (request.authority) {
        await recordApprovalUse(resolveProfileConfigPath(".").base, request.authority.ledgerId, "spawn", repository, "spawned", reservedUseId);
        // The audit write can await its writer lock. Recheck authority after
        // that wait, before reporting success for the already-started agent.
        revalidateSpawnAuthority(
          context?.cwd, repository, canonicalRoot, request, worktreeTarget, options,
          "during the final approval-use audit write",
        );
      }

      return {
        schema: HERDR_LIFECYCLE_SCHEMA,
        ok: true,
        status: "spawned",
        role,
        warnings,
        reportMarkers: reportMarkersForRole(role),
        placement,
        direction: placement === "tab" ? null : HERDR_DIRECTIONS[placement],
        workspaceId,
        paneId: rootPaneId,
        rootPaneId,
        tabId,
        modelArgv: [...modelArgv],
        repository: canonicalRoot,
        ...(worktreeTarget
          ? { worktreePath: worktreeTarget.worktreePath, leaseId: worktreeTarget.leaseId }
          : {}),
        hashes: Object.freeze({
          request: sha256(JSON.stringify(request)),
          layoutCreateResponse: sha256(layoutRaw),
          startResponse: sha256(startRaw),
        }),
        nonAuthorizing: true,
        authorityCreated: false,
      };
    } catch (error) {
      // Once agent start exits successfully, parsing or read-back failures
      // cannot erase that mutation: report a live-agent partial so the user is
      // never told to treat it as merely an empty orphan tab.
      return partialResult(error, {
        partial: agentStartSucceeded ? "agent_started" : layoutPartial,
        paneId: rootPaneId, tabId, role, kind, modelArgv, warnings,
      });
    }
  } catch (error) {
    return errorResult(error, { warnings });
  } finally {
    await indexReady;
  }
}

function toolResult(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

// --- Attended Electron-specific boundary -----------------------------------
// An explicit, closed contract for a trusted NON-TUI host: the Electron main
// process. It is a separate context class (see native_tui_context.js), never
// a Pi-TUI representation. The host has no Herdr session pane, so this
// boundary NEVER reads or manufactures HERDR_PANE_ID and supports ONLY tab
// placement (a tab create needs no coordinator pane identity). Stages:
//   preflightAttendedElectronSpawn  — read-only validation intended to run
//     BEFORE any board claim: context class, closed parameters, trusted
//     repository (registry + realpath + Git root), installed model roll,
//     trusted Herdr executable availability, and duplicate-role observation.
//     A preflight is NOT an atomic guarantee: external state can change after
//     it, which is why the commit stage re-validates everything and callers
//     must preserve truthful claimed-but-not-started reconciliation.
//   executeHerdrSpawnWorkerAttendedElectron — the single-attempt commit:
//     the same guarded tab create → agent start → agent get → pane get
//     sequence with exact
//     read-back. No retry, no automatic cleanup; failures report partial
//     state with human cleanup guidance.
function attendedElectronContextError(context) {
  if (!isAttendedElectronContext(context)) {
    throw lifecycleError(
      "attended_electron_context_required",
      "the Electron boundary requires an explicit electron-attended context (never a Pi TUI representation)",
      "blocked",
    );
  }
  if (typeof context?.cwd !== "string" || context.cwd.trim() === "") {
    throw lifecycleError(
      "attended_electron_context_required",
      "the attended Electron context requires the trusted host working directory",
      "blocked",
    );
  }
}

function attendedElectronParams(params, options = {}) {
  const request = validateSpawnParams(params, options);
  if ((request.kind ?? "pi") !== "pi") {
    throw lifecycleError("codex_attended_unavailable", "Codex requires the guarded tab environment and process readback", "denied");
  }
  if (request.placement !== "tab") {
    throw lifecycleError(
      "pane_identity_unavailable",
      "the attended Electron host has no Herdr session pane; only tab placement is legitimate and no pane identity is manufactured or inherited",
      "denied",
    );
  }
  return request;
}

function resolveAttendedElectronPrerequisites(request, context, options) {
  const canonicalRoot = resolveTrustedSpawnRepository(context.cwd, request.repository);
  const modelArgv = resolveInstalledModel(request.model, options);
  // The optional worktree target follows exactly the same rules on this
  // boundary: canonical path, real Git repository identity, active lease.
  const worktreeTarget = request.worktreePath
    ? resolveWorktreeSpawnTarget(canonicalRoot, request.worktreePath, options)
    : null;
  return { canonicalRoot, modelArgv, worktreeTarget };
}

function assertHerdrExecutableAvailable(options) {
  try {
    // The injected test seam is a real process boundary: verify the exact
    // injected executable exists and is executable so a missing executable
    // fails locally, without any process spawn.
    const injected = options?.testExecutablePath;
    if (typeof injected === "string" && injected.trim()) {
      const real = realpathSync(injected);
      const stat = statSync(real);
      accessSync(real, fsConstants.X_OK);
      if (!stat.isFile()) throw new Error("not a file");
      return;
    }
    resolveTrustedHerdrExecutable(options);
  } catch (error) {
    if (error?.name === "HerdrLifecycleError") throw error;
    throw lifecycleError(
      "herdr_unavailable",
      "the trusted Herdr executable is unavailable for the attended Electron boundary",
    );
  }
}

async function observeDuplicateRole(canonicalRoot, role, options, signal) {
  const listed = await invokeHerdr(agentListArgv(), canonicalRoot, options, signal);
  if (duplicateRoleExists(listed, role)) {
    throw lifecycleError("duplicate_worker_name", "a live agent already holds this name", "denied");
  }
  const tabs = parseJsonEnvelope(await invokeHerdr(["tab", "list"], canonicalRoot, options, signal), "tab list").tabs;
  if (!Array.isArray(tabs) || tabs.length > 64) throw lifecycleError("unexpected_result", "tab list returned an invalid bounded list");
  if (tabs.some((tab) => isPlainObject(tab) && tab.label === role)) {
    throw lifecycleError("duplicate_worker_name", "a live tab already holds this worker name", "denied");
  }
}

// A worktree path is a distinct approval scope; repository-only grants cover
// the canonical repository root, not an arbitrary linked worktree.
function attendedSpawnApprovalRequest(request, worktreeTarget) {
  return { tier: 1, repository: request.repository, action: "spawn",
    model: request.model, role: request.role,
    ...(worktreeTarget ? { path: worktreeTarget.worktreePath, worktreeTarget, repositoryRoot: worktreeTarget.repositoryPath } : {}),
  };
}

export async function preflightAttendedElectronSpawn(params, context, options = {}) {
  try {
    attendedElectronContextError(context);
    const request = attendedElectronParams(params, options);
    assertHerdrExecutableAvailable(options);
    const { canonicalRoot, modelArgv, worktreeTarget } = resolveAttendedElectronPrerequisites(request, context, options);
    if (request.authority) {
      try {
        authorizeApproval(resolveProfileConfigPath(".").base, request.authority.ledgerId, attendedSpawnApprovalRequest(request, worktreeTarget));
      } catch (error) {
        return errorResult(lifecycleError("approval_missing", error.message, "needs-owner"), needsOwner(1, ["spawn approval covering repository, model and role"], request.repository));
      }
    }
    await observeDuplicateRole(worktreeTarget ? worktreeTarget.worktreePath : canonicalRoot, request.role, options, null);
    await availableWorkspace(canonicalRoot, options, null);
    revalidateSpawnAuthority(
      context.cwd, request.repository, canonicalRoot, request, worktreeTarget, options,
      "during the preflight agent-list observation",
    );
    return {
      schema: HERDR_LIFECYCLE_SCHEMA,
      ok: true,
      status: "preflight-verified",
      boundary: ATTENDED_ELECTRON_BOUNDARY,
      placement: "tab",
      role: request.role,
      repository: canonicalRoot,
      ...(worktreeTarget
        ? { worktreePath: worktreeTarget.worktreePath, leaseId: worktreeTarget.leaseId }
        : {}),
      modelArgv: [...modelArgv],
      nonAuthorizing: true,
      authorityCreated: false,
    };
  } catch (error) {
    return errorResult(error);
  }
}

async function auditedAttendedPartial(error, details, request, useId) {
  if (useId) {
    try {
      await recordApprovalUse(resolveProfileConfigPath(".").base, request.authority.ledgerId,
        "spawn", request.repository, "partial", useId, details.partial);
    } catch (auditError) {
      return partialResult(lifecycleError("approval_audit_failed",
        `${error?.message || "spawn failed"}; approval outcome could not be recorded: ${auditError.message}`, "partial"), details);
    }
  }
  return partialResult(error, details);
}

export async function executeHerdrSpawnWorkerAttendedElectron(params, context, options = {}, signal) {
  let request;
  let reservedUseId;
  const warnings = [];
  let indexReady = Promise.resolve();
  try {
    attendedElectronContextError(context);
    request = attendedElectronParams(params, options);
    const readiness = paneReadiness(options);
    const { role, model, repository } = request;

    // Resolve BEFORE any mutation: registry + realpath + Git root, plus the
    // installed model roll. Duplicate live names are denied at spawn.
    let canonicalRoot = resolveTrustedSpawnRepository(context.cwd, repository);
    const modelArgv = resolveInstalledModel(model, options);
    let worktreeTarget = request.worktreePath
      ? resolveWorktreeSpawnTarget(canonicalRoot, request.worktreePath, options)
      : null;
    let spawnCwd = worktreeTarget ? worktreeTarget.worktreePath : canonicalRoot;
    await observeDuplicateRole(spawnCwd, role, options, signal);
    const workspaceId = request.workspace ? await selectedWorkspace(request.workspace, canonicalRoot, options, signal) : await availableWorkspace(canonicalRoot, options, signal);
    if (request.authority) {
      try {
        const reservation = await reserveApprovalUse(resolveProfileConfigPath(".").base, request.authority.ledgerId, attendedSpawnApprovalRequest(request, worktreeTarget));
        reservedUseId = reservation.useId;
      } catch (error) {
        return errorResult(lifecycleError("approval_missing", error.message, "needs-owner"), needsOwner(1, ["spawn approval covering repository, model and role"], repository));
      }
    }
    const asgrep = await workerAsgrepSettings(options, warnings);

    // Revalidate after asynchronous preflight and before the first mutation.
    // An identity or lease change here is refused without creating a tab.
    canonicalRoot = revalidateSpawnAuthority(
      context.cwd, repository, canonicalRoot, request, worktreeTarget, options, "after preflight",
    );
    if (request.worktreePath) spawnCwd = worktreeTarget.worktreePath;

    indexReady = prewarmWorkerAsgrep(asgrep, spawnCwd, warnings, signal);
    // Tab topology only: no coordinator pane identity is resolved, used, or
    // manufactured anywhere on this path.
    let tabId;
    let rootPaneId;
    let layoutRaw;
    try {
      layoutRaw = await invokeHerdr(tabCreateArgv(spawnCwd, role, workspaceId, asgrep.env), spawnCwd, options, signal);
      ({ rootPaneId, tabId } = parseTabCreate(layoutRaw));
      if (!rootPaneId.startsWith(`${workspaceId}:`) || !tabId.startsWith(`${workspaceId}:`)) {
        throw lifecycleError("workspace_mismatch", "the new tab was placed outside the repository workspace", "denied");
      }
    } catch (error) {
      return auditedAttendedPartial(error, {
        partial: "tab_created", paneId: rootPaneId, tabId, role, modelArgv, warnings,
        ...(typeof layoutRaw === "string" ? { rawResponse: layoutRaw } : {}),
      }, request, reservedUseId);
    }

    let agentStartSucceeded = false;
    try {
      // Re-check registry authorization and the bound target between mutations.
      canonicalRoot = revalidateSpawnAuthority(
        context.cwd, repository, canonicalRoot, request, worktreeTarget, options, "between mutations",
      );

      // Retry only a busy shell in the tab's original root pane.
      const startCall = startArgv(role, rootPaneId, modelArgv);
      const startRaw = await startOnReadyPane(startCall, spawnCwd, options, signal, () => {
        canonicalRoot = revalidateSpawnAuthority(
          context.cwd, repository, canonicalRoot, request, worktreeTarget, options, "before agent start retry",
        );
      }, readiness);
      agentStartSucceeded = true;

      canonicalRoot = revalidateSpawnAuthority(
        context.cwd, repository, canonicalRoot, request, worktreeTarget, options, "after agent start",
      );

      const startedPaneId = readBackStart(startRaw, role, spawnCwd, [...modelArgv]);
      if (startedPaneId !== rootPaneId) {
        throw lifecycleError("pane_mismatch", "agent start returned a different pane identity");
      }
      const agentRaw = await invokeHerdr(["agent", "get", role], spawnCwd, options, signal);
      const agentReadBack = readBackAgent(agentRaw, role, spawnCwd, [...modelArgv]);
      if (agentReadBack.paneId !== rootPaneId) {
        throw lifecycleError("pane_mismatch", "agent get returned a different pane identity");
      }
      const paneRaw = await invokeHerdr(["pane", "get", rootPaneId], spawnCwd, options, signal);
      readBackPane(paneRaw, rootPaneId, spawnCwd);
      await indexReady;
      revalidateSpawnAuthority(
        context.cwd, repository, canonicalRoot, request, worktreeTarget, options,
        "during the final read-backs",
      );
      if (request.authority) {
        await recordApprovalUse(resolveProfileConfigPath(".").base, request.authority.ledgerId, "spawn", repository, "spawned", reservedUseId);
        revalidateSpawnAuthority(
          context.cwd, repository, canonicalRoot, request, worktreeTarget, options,
          "during the final approval-use audit write",
        );
      }

      return {
        schema: HERDR_LIFECYCLE_SCHEMA,
        ok: true,
        status: "spawned",
        boundary: ATTENDED_ELECTRON_BOUNDARY,
        role,
        warnings,
        reportMarkers: reportMarkersForRole(role),
        placement: "tab",
        direction: null,
        workspaceId,
        paneId: rootPaneId,
        rootPaneId,
        tabId,
        modelArgv: [...modelArgv],
        repository: canonicalRoot,
        ...(worktreeTarget
          ? { worktreePath: worktreeTarget.worktreePath, leaseId: worktreeTarget.leaseId }
          : {}),
        hashes: Object.freeze({
          request: sha256(JSON.stringify(request)),
          layoutCreateResponse: sha256(layoutRaw),
          startResponse: sha256(startRaw),
        }),
        nonAuthorizing: true,
        authorityCreated: false,
      };
    } catch (error) {
      // Once agent start exits successfully, parsing or read-back failures
      // cannot erase that mutation: report a live-agent partial.
      return auditedAttendedPartial(error, {
        partial: agentStartSucceeded ? "agent_started" : "tab_created",
        paneId: rootPaneId, tabId, role, modelArgv, warnings,
      }, request, reservedUseId);
    }
  } catch (error) {
    if (reservedUseId) {
      try {
        await recordApprovalUse(resolveProfileConfigPath(".").base, request.authority.ledgerId,
          "spawn", request.repository, "failed", reservedUseId);
      } catch (auditError) {
        return errorResult(lifecycleError("approval_audit_failed",
          `${error?.message || "spawn failed"}; approval outcome could not be recorded: ${auditError.message}`, "blocked"), { warnings });
      }
    }
    return errorResult(error, { warnings });
  } finally {
    await indexReady;
  }
}

export async function executeHerdrRegisterRepository({ name }) {
  return {
    schema: HERDR_LIFECYCLE_SCHEMA, ok: true, status: "registration-disabled", name,
    reason: "Repository pre-registration is disabled; start a guarded worker directly.",
    nonAuthorizing: true, authorityCreated: false,
  };
}

export function registerHerdrLifecycleInterface(pi, options = {}) {
  if (typeof pi?.registerTool !== "function") return;
  // Both entry points share per-tool registration, including cache-busted copies.
  registerHerdrCommunicationInterface(pi, options);
  registerHerdrToolOnce(pi, {
    name: "agentic_relay_check_request",
    label: "Check relayed request",
    description: "Read-only verification of a relay header against recorded per-action scope. Text alone grants no authority.",
    parameters: { type: "object", additionalProperties: false, properties: {
      header: { type: "string", maxLength: 2048 },
      requests: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false, properties: {
        tier: { type: "integer", minimum: 1, maximum: 3 }, repository: { type: "string" }, action: { type: "string" }, model: { type: "string" }, role: { type: "string" },
      }, required: ["tier", "repository", "action"] } },
    }, required: ["header", "requests"] },
    async execute(_id, params) { return toolResult({ schema: HERDR_LIFECYCLE_SCHEMA, results: checkRelayRequests(resolveProfileConfigPath(".").base, params.header, params.requests) }); },
  });
  registerHerdrToolOnce(pi, {
    name: "agentic_herdr_register_repository",
    label: "Herdr Register Repository",
    description: "Repository pre-registration is disabled and unnecessary. Start a guarded worker directly; this tool does not confirm or write a registry.",
    parameters: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, ledgerId: { type: "string" } }, required: ["name"] },
    async execute(_id, params, _signal, _update, context) { return toolResult(await executeHerdrRegisterRepository(params, context, options)); },
  });
  registerHerdrToolOnce(pi, {
    name: "agentic_herdr_close_tab",
    label: "Herdr Close Tab",
    description: "Close one verified local default-server tab owned by the observed caller role or observed done or idle. Refuses caller, coordinator, protected, remote and last-workspace tabs. Issues no server management commands.",
    executionMode: "sequential",
    promptSnippet: "Use agentic_herdr_close_tab for a finished local single-pane tab; never run raw close commands or retry an uncertain close.",
    parameters: HERDR_CLOSE_TAB_PARAMETERS,
    async execute(_id, params, signal, _update, context) {
      return toolResult(await executeHerdrCloseTab(params, context, options, signal));
    },
  });
  registerHerdrToolOnce(pi, {
    name: HERDR_SPAWN_WORKER_TOOL,
    label: "Herdr Spawn Worker",
    description: "Create and verify one worker tab in a trusted repository. Select a workspace id or label when outside a Herdr pane; otherwise the caller pane supplies the workspace.",
    promptSnippet: "Use agentic_herdr_spawn_worker to start one guarded worker tab in a verified sibling Git checkout without pre-registering it; no raw Herdr management verbs or terminal remote control.",
    promptGuidelines: [
      "Roles are free-form safe names except the coordinator class. Pi models resolve against the installed Pi model roll; Codex uses the closed account/model map and requires an explicit kind, account and scoped approval.",
      "A failed start leaves the created tab for human cleanup; no automatic close is performed.",
      "The receipt is observed state only: names, argv, and self-reports are never authority.",
    ],
    parameters: HERDR_SPAWN_WORKER_PARAMETERS,
    async execute(_id, params, signal, _update, context) {
      return toolResult(await executeHerdrSpawnWorker(params, context, options, signal));
    },
  });
}

// --- Host-local tab close ---------------------------------------------------
// Tagged Herdr 0.9.1 source evidence and limits: docs/herdr-workers.md.
// This path deliberately does not inherit invokeHerdr's process environment.
export const HERDR_CLOSE_TAB_PARAMETERS = Object.freeze({
  type: "object", additionalProperties: false,
  properties: {
    tabId: { type: "string", pattern: "^w[A-Za-z0-9]+:t[A-Za-z0-9]+$", maxLength: 128 },
    reason: { type: "string", minLength: 1, maxLength: 512 },
  }, required: ["tabId", "reason"],
});
const CLOSE_TAB_ID = /^w[A-Za-z0-9]+:t[A-Za-z0-9]+$/;
const CLOSE_PANE_ID = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
const CLOSE_TIMEOUT_MS = 15_000;

export function assertTabCloseArgv(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[0] !== "tab" || argv[1] !== "close"
      || typeof argv[2] !== "string" || argv[2].length > 128 || !CLOSE_TAB_ID.test(argv[2])) {
    throw lifecycleError("unsafe_close_argv", "only an exact tab close and scoped tab identifier are allowed");
  }
  return argv;
}

function closeEnvironment(home, socket, callerPaneId) {
  // Construct, do not filter: no HERDR_SESSION, --machine, remote bridge,
  // XDG override, preload variable or inherited executable selection survives.
  return Object.freeze({ HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HERDR_SOCKET_PATH: socket,
    ...(callerPaneId ? { HERDR_PANE_ID: callerPaneId } : {}) });
}

function closeProbe(executable, argv) {
  const result = spawnSync(executable, argv, { encoding: "utf8", shell: false,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    timeout: 5000, maxBuffer: 16 * 1024 });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    throw lifecycleError("local_server_unverified", "the local socket listener could not be verified");
  }
  return result.stdout.trim();
}

export function observeLocalCloseHost(expected, options = {}) {
  const probe = options.testCloseProbe ?? closeProbe;
  const socket = lstatSync(expected.socket);
  const parent = dirname(expected.socket);
  const parentStat = statSync(parent);
  if (realpathSync(parent) !== parent || parentStat.uid !== expected.uid || (parentStat.mode & 0o022) !== 0) {
    throw lifecycleError("local_server_unverified", "the local socket directory is not canonical and owned");
  }
  if (realpathSync(expected.socket) !== expected.socket || !socket.isSocket()
      || socket.uid !== expected.uid || (socket.mode & 0o077) !== 0) {
    throw lifecycleError("local_server_unverified", "an owned canonical private local socket is required");
  }
  // Require the bound Unix socket's sole owning process to be the trusted
  // binary running exactly `server`, not ssh, a proxy, or an attached client.
  const listing = probe("/usr/sbin/lsof", ["-nP", "-a", "-U", "-Fpn", expected.socket]);
  let pid;
  const owners = new Set();
  for (const line of listing.split("\n")) {
    if (/^p[1-9][0-9]*$/.test(line)) pid = Number(line.slice(1));
    if (line === `n${expected.socket}` && pid) owners.add(pid);
  }
  if (owners.size !== 1) throw lifecycleError("local_server_unverified", "a unique local server listener is required");
  pid = [...owners][0];
  const process = probe("/bin/ps", ["-ww", "-p", String(pid), "-o", "uid=", "-o", "lstart=", "-o", "command="]);
  const match = /^\s*([0-9]+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+[0-9]+\s+[0-9:]+\s+[0-9]{4})\s+(.+)$/.exec(process);
  if (!match || Number(match[1]) !== expected.uid || match[3] !== `${expected.binary} server`) {
    throw lifecycleError("local_server_unverified", "the socket is not owned by the trusted local server process");
  }
  const image = probe("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fni"]);
  let inode;
  let imageMatches = false;
  for (const line of image.split("\n")) {
    if (/^i[0-9]+$/.test(line)) inode = line.slice(1);
    if (line === `n${expected.binary}` && inode === String(statSync(expected.binary).ino)) imageMatches = true;
  }
  if (!imageMatches) throw lifecycleError("local_server_unverified", "the listener has no matching trusted executable image");
  return { ...expected, local: true, pid, startedAt: match[2], socketIdentity: `${socket.dev}:${socket.ino}` };
}

function closeHostIsLocal(observed, expected) {
  return observed?.local === true && observed.host === expected.host && observed.socket === expected.socket
    && observed.uid === expected.uid && observed.binary === expected.binary
    && Number.isSafeInteger(observed.pid) && observed.pid > 0
    && typeof observed.startedAt === "string" && observed.startedAt.length > 0 && observed.startedAt.length < 64
    && typeof observed.socketIdentity === "string" && /^[0-9]+:[0-9]+$/.test(observed.socketIdentity);
}

function verifiedCloseHost(expected, options) {
  let observed;
  try { observed = options.testObserveCloseHost ? options.testObserveCloseHost(expected) : observeLocalCloseHost(expected, options); }
  catch { throw lifecycleError("local_server_unverified", "the local socket listener could not be verified"); }
  if (!closeHostIsLocal(observed, expected)) {
    throw lifecycleError("cross_host", "remote, attached, forwarded or foreign-host targets cannot be closed here");
  }
  return Object.freeze({ ...observed });
}

function openCloseAudit(home) {
  const directory = join(home, ".pi/agentic-driver-herdr");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = statSync(directory);
  if (realpathSync(directory) !== directory || directoryStat.uid !== process.getuid()
      || (directoryStat.mode & 0o077) !== 0) throw new Error("untrusted audit directory");
  const path = join(directory, "close-attempts.jsonl");
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT
    | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("untrusted audit file");
    return { fd, path };
  } catch (error) { closeSync(fd); throw error; }
}

async function invokeCloseHerdr(argv, execution, options, signal) {
  if (signal?.aborted) throw lifecycleError("aborted", "tab close was aborted");
  // The only mutating shape has its own final assertion. The observation set
  // is closed too; arbitrary callers cannot turn this into a management API.
  const read = ["status server --json", "workspace list", "tab list", "pane list", "pane current --current"].includes(argv.join(" "))
    || (argv.length === 3 && argv[0] === "pane" && argv[1] === "get" && CLOSE_PANE_ID.test(argv[2]));
  if (!read) assertTabCloseArgv(argv);
  const spec = { executable: execution.executable, argv: Object.freeze([...argv]),
    spawnOptions: Object.freeze({ cwd: execution.cwd, env: execution.env, shell: false }), shell: false,
    timeoutMs: CLOSE_TIMEOUT_MS, maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES };
  const raw = options.runProcess
    ? await awaitBounded(Promise.resolve().then(() => options.runProcess(spec)), CLOSE_TIMEOUT_MS, signal)
    : await runSpawnedProcess(spec.executable, spec.argv, spec.spawnOptions, CLOSE_TIMEOUT_MS, signal);
  if (raw?.internalFailure) throw lifecycleError("close_transport_failed", "Herdr did not return a bounded response; no retry was performed");
  const result = normalizeProcessResult(raw);
  if (result.code !== 0) throw lifecycleError("close_process_failed", "Herdr rejected the operation; no retry was performed");
  return parseJsonEnvelope(result.stdout, "local tab close observation");
}

function closeList(value, key) {
  const items = value?.[key];
  if (!Array.isArray(items) || items.length > 256 || items.some(item => !isPlainObject(item))) {
    throw lifecycleError("target_identity_unverified", "Herdr returned an invalid bounded topology list");
  }
  return items;
}

function uniqueCloseItem(items, key, id, code = "target_identity_unverified") {
  const matches = items.filter(item => item[key] === id);
  if (matches.length !== 1) throw lifecycleError(code, "a unique local topology identity is required");
  return matches[0];
}

async function observeCloseTarget(request, execution, options, signal) {
  const call = argv => invokeCloseHerdr(argv, execution, options, signal);
  const status = await call(["status", "server", "--json"]);
  if (status.running !== true || status.status !== "running" || status.socket !== execution.expected.socket
      || status.session !== null || status.compatible !== true || status.restart_needed !== false
      || status.version !== HERDR_VERSION || !Number.isSafeInteger(status.protocol)) {
    throw lifecycleError("server_identity_unverified", "the local default server identity or compatibility is unverified");
  }
  const workspaces = closeList(await call(["workspace", "list"]), "workspaces");
  const tabs = closeList(await call(["tab", "list"]), "tabs");
  const targetMatches = tabs.filter(tab => tab.tab_id === request.tabId);
  if (!targetMatches.length) throw lifecycleError("target_not_local", "the target is not on this verified local server");
  const tab = uniqueCloseItem(tabs, "tab_id", request.tabId);
  const workspaceId = request.tabId.split(":")[0];
  const workspace = uniqueCloseItem(workspaces, "workspace_id", workspaceId);
  if (tab.workspace_id !== workspaceId) throw lifecycleError("target_identity_unverified", "tab workspace identity conflicts");
  if (workspace.tab_count === 1 || tabs.filter(t => t.workspace_id === workspaceId).length === 1) {
    throw lifecycleError("last_workspace_tab", "closing the last workspace tab can close its workspace");
  }
  if (!Number.isSafeInteger(workspace.tab_count) || workspace.tab_count < 2
      || workspace.tab_count !== tabs.filter(t => t.workspace_id === workspaceId).length) {
    throw lifecycleError("target_identity_unverified", "workspace tab count is inconsistent");
  }
  if (typeof workspace.label !== "string" || /^(?:protected|coordinator)(?:-|$)/i.test(workspace.label)) {
    throw lifecycleError("protected_workspace", "the target workspace is protected or unverified");
  }
  const current = await call(currentPaneArgv());
  const caller = current.pane ?? current;
  if (!execution.callerPaneId || caller.pane_id !== execution.callerPaneId || !CLOSE_PANE_ID.test(caller.pane_id)) {
    throw lifecycleError("caller_identity_unverified", "the caller requires a verified local Herdr pane");
  }
  if (caller.tab_id === request.tabId) throw lifecycleError("caller_tab", "the caller tab cannot be closed");
  const callerTab = uniqueCloseItem(tabs, "tab_id", caller.tab_id);
  if (typeof callerTab.label !== "string" || !ROLE_REGEXP.test(callerTab.label) || callerTab.label.length > 64) {
    throw lifecycleError("caller_identity_unverified", "the caller role label is unverified");
  }
  execution.audit.callerRole = callerTab.label;
  if (typeof tab.label !== "string" || !ROLE_REGEXP.test(tab.label) || tab.label.length > 64) {
    throw lifecycleError("target_identity_unverified", "the target role label is unverified");
  }
  if (isCoordinatorRole(tab.label)) throw lifecycleError("coordinator_tab", "coordinator tabs cannot be closed");
  if (tab.pane_count !== 1) throw lifecycleError("single_pane_required", "only single-pane tabs can be closed");
  const panes = closeList(await call(["pane", "list"]), "panes").filter(p => p.tab_id === request.tabId);
  if (panes.length !== 1 || !CLOSE_PANE_ID.test(panes[0].pane_id)) {
    throw lifecycleError("single_pane_required", "one verified target pane is required");
  }
  const detail = await call(["pane", "get", panes[0].pane_id]);
  const pane = detail.pane ?? detail;
  execution.audit.paneId = panes[0].pane_id;
  if (pane.pane_id !== panes[0].pane_id || pane.tab_id !== tab.tab_id
      || pane.workspace_id !== workspaceId || !pane.pane_id.startsWith(`${workspaceId}:`)
      || (pane.name !== undefined && pane.name !== tab.label) || (pane.role !== undefined && pane.role !== tab.label)
      || pane.agent !== "pi" || pane.launch_pending === true || pane.interactive_ready === false) {
    throw lifecycleError("target_identity_unverified", "the target pane and role observations conflict");
  }
  if (tab.label !== callerTab.label && !["done", "idle"].includes(pane.agent_status)) {
    throw lifecycleError("not_owned_and_busy", "the target is neither owned by the caller role nor observed done or idle");
  }
  // Compare only safety/identity facts, not focus, token counts or UI metadata.
  return JSON.stringify({ serverStatus: status, tabId: tab.tab_id, label: tab.label, workspaceId,
    tabCount: workspace.tab_count, workspaceLabel: workspace.label, caller: caller.pane_id,
    callerTab: caller.tab_id, callerRole: callerTab.label, paneId: pane.pane_id, status: pane.agent_status });
}

export async function executeHerdrCloseTab(params, context, options = {}, signal) {
  // Use the account database, not an inherited HOME, for production routing.
  const home = options.testHomeDir ?? userInfo().homedir;
  const auditRecord = { callerRole: null, tabId: null, paneId: null, host: hostname(), server: null,
    reason: null, time: new Date().toISOString(), result: "refused:invalid_close_parameters" };
  let audit;
  let dispatched = false;
  let result;
  try {
    try { audit = openCloseAudit(home); }
    catch { throw lifecycleError("audit_unavailable", "the append-only close audit is unavailable"); }
    if (!isPlainObject(params) || Object.keys(params).length !== 2
        || Object.keys(params).some(key => !["tabId", "reason"].includes(key))
        || typeof params.tabId !== "string" || params.tabId.length > 128 || !CLOSE_TAB_ID.test(params.tabId)
        || typeof params.reason !== "string" || !params.reason.trim() || Buffer.byteLength(params.reason) > 512
        || /[\x00-\x1f\x7f]/.test(params.reason)) {
      throw lifecycleError("invalid_close_parameters", "tabId and a bounded single-line reason are required");
    }
    auditRecord.tabId = params.tabId;
    auditRecord.reason = params.reason;
    // Do not pass runProcess to the resolver: fixtures must exercise actual
    // pinned-file trust too, rather than implicitly trusting any fake adapter.
    const { runProcess: _ignored, ...resolverOptions } = options;
    const trustOptions = { ...resolverOptions, testHomeDir: home };
    const executable = resolveTrustedHerdrExecutable(trustOptions);
    const binary = trustedHerdrExecutableRealPath(executable, trustOptions);
    const expected = { host: hostname(), socket: join(home, ".config/herdr/herdr.sock"), uid: process.getuid(), binary };
    const host = verifiedCloseHost(expected, options);
    auditRecord.server = { socket: host.socket, pid: host.pid, startedAt: host.startedAt,
      socketIdentity: host.socketIdentity };
    const callerPaneId = options.testCloseCallerPaneId ?? process.env.HERDR_PANE_ID;
    if (typeof callerPaneId !== "string" || !CLOSE_PANE_ID.test(callerPaneId) || callerPaneId.length > 128) {
      throw lifecycleError("caller_identity_unverified", "a local caller pane is required");
    }
    const execution = { executable, expected, callerPaneId, cwd: context?.cwd,
      env: closeEnvironment(home, expected.socket, callerPaneId), audit: auditRecord };
    const before = await observeCloseTarget(params, execution, options, signal);
    const after = await observeCloseTarget(params, execution, options, signal);
    if (before !== after || JSON.stringify(verifiedCloseHost(expected, options)) !== JSON.stringify(host)) {
      throw lifecycleError("close_identity_changed", "host or target identity changed before close");
    }
    const argv = Object.freeze(["tab", "close", params.tabId]);
    assertTabCloseArgv(argv);
    if (signal?.aborted) throw lifecycleError("aborted", "tab close was aborted");
    // No asynchronous boundary between the last local listener check and dispatch.
    dispatched = true;
    const closed = await invokeCloseHerdr(argv, execution, options, signal);
    if (closed.type !== "ok") throw lifecycleError("close_unconfirmed", "close acknowledgment is unverified; do not retry automatically");
    const remaining = closeList(await invokeCloseHerdr(["tab", "list"], execution, options, signal), "tabs");
    const server = await invokeCloseHerdr(["status", "server", "--json"], execution, options, signal);
    if (remaining.some(tab => tab.tab_id === params.tabId) || server.running !== true
        || server.socket !== expected.socket || JSON.stringify(verifiedCloseHost(expected, options)) !== JSON.stringify(host)) {
      throw lifecycleError("close_unconfirmed", "the tab disappearance and unchanged local server were not verified");
    }
    auditRecord.result = "closed";
    result = { schema: HERDR_LIFECYCLE_SCHEMA, ok: true, status: "closed", tabId: params.tabId,
      paneId: auditRecord.paneId, nonAuthorizing: true, authorityCreated: false };
  } catch (error) {
    const code = error?.name === "HerdrLifecycleError" || error?.code === "trusted_executable_unavailable"
      ? error.code : "close_unverified";
    auditRecord.result = `${dispatched ? "failed" : "refused"}:${code}`;
    result = { schema: HERDR_LIFECYCLE_SCHEMA, ok: false, status: dispatched ? "failed" : "refused", code,
      reason: error?.name === "HerdrLifecycleError" ? error.message : "tab close refused; local safety evidence is required",
      nonAuthorizing: true, authorityCreated: false };
  } finally {
    if (audit) {
      try {
        const line = `${JSON.stringify(auditRecord)}\n`;
        if (Buffer.byteLength(line) > 4096 || writeSync(audit.fd, line) !== Buffer.byteLength(line)) throw new Error("audit write failed");
      } catch {
        result = { ...result, ok: false, status: "failed", code: "audit_write_failed", closeDispatched: dispatched };
      } finally { closeSync(audit.fd); }
    }
  }
  return result;
}

export default registerHerdrLifecycleInterface;

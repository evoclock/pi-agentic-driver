// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

// Guarded spawn_worker composite capability (Tranche 07). One tool, one closed
// request, one documented Herdr 0.8.2 layout/start sequence, bounded read-back,
// and a bounded receipt. This is deliberately NOT a general Herdr management
// surface: no raw management verbs, no terminal remote control, no model
// allowlist constant. Pane placement uses pane split directly; tab placement
// uses tab create. Both capture the returned pane identity and start once.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  HERDR_ROLE_PATTERN,
  HERDR_ROLE_POLICY,
  resolveTrustedHerdrExecutable,
} from "./herdr_communication_pi.js";
import { isNativeTuiContext } from "../lifecycle_mode_pi.js";

export const HERDR_SPAWN_WORKER_TOOL = "agentic_herdr_spawn_worker";
export const HERDR_LIFECYCLE_SCHEMA = "agentic-driver.herdr-lifecycle.v1";
export const HERDR_LIFECYCLE_VERSION = "spawn-worker.v1";
export const SPAWN_PLACEMENTS = Object.freeze(["tab", "right", "below"]);
// Herdr accepts only `right` and `down` split directions;
// the user-facing `below` is mapped, never forwarded.
const HERDR_DIRECTIONS = Object.freeze({ right: "right", below: "down" });
// Applied to the pane-move --split value (user placement right|below → Herdr
// split right|down); never forwarded as a placement.
const WORKER_REPOSITORY_REGISTRY = "config/herdr-worker-repositories.v1.json";
const WORKER_REPOSITORY_SCHEMA = "agentic-driver.herdr-worker-repositories.v1";
const ROLE_REGEXP = new RegExp(HERDR_ROLE_PATTERN);
const SAFE_NAME_REGEXP = ROLE_REGEXP;
const MAX_FIELD_BYTES = 4 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
const COMMAND_TIMEOUT_MS = 135_000;
const AGENT_READY_TIMEOUT_MS = 120_000;
// The active Pi profile's model roll is user configuration, read read-only.
// It resolves from PI_CODING_AGENT_DIR (the active profile directory); only
// when that env var is unset does it fall back to the default per-user path
// ~/.pi/agent/models.json (recorded in docs/package-0.1.3-design-record.md).
function resolvePiModelsPath() {
  const profileDir = process.env.PI_CODING_AGENT_DIR;
  if (typeof profileDir === "string" && profileDir.trim()) {
    return join(profileDir.trim(), "models.json");
  }
  return join(homedir(), ".pi", "agent", "models.json");
}
const MODEL_ID_REGEXP = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,127})*$/;
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
const REGISTRATIONS = new WeakSet();

export const HERDR_SPAWN_WORKER_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    placement: { type: "string", enum: SPAWN_PLACEMENTS },
    role: { type: "string", pattern: HERDR_ROLE_PATTERN, maxLength: 64 },
    model: { type: "string", pattern: MODEL_ID_REGEXP.source, maxLength: 192 },
    repository: { type: "string", pattern: SAFE_NAME_REGEXP.source, maxLength: 64 },
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

function layoutCleanupGuidance(partial, paneId, tabId) {
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
  return `The worker agent is live and usable${paneId ? ` in pane ${paneId}` : ""}; use it as-is or close it manually. No automatic retry or cleanup was performed.`;
}

function partialResult(error, { partial = "tab_created", paneId, tabId, role, modelArgv, rawResponse } = {}) {
  const code = typeof error?.code === "string" ? error.code : "unexpected_adapter_failure";
  const message = typeof error?.message === "string" && error.message
    ? error.message
    : "the Herdr lifecycle adapter failed";
  const cleanup = layoutCleanupGuidance(partial, paneId, tabId);
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

export function validateSpawnParams(params) {
  if (!isPlainObject(params)) {
    throw lifecycleError("invalid_parameters", "spawn parameters must be an object", "denied");
  }
  const keys = Object.keys(params);
  if (keys.length !== 4 || ["placement", "role", "model", "repository"].some((k) => !keys.includes(k))) {
    throw lifecycleError("closed_parameters", "spawn_worker accepts exactly placement, role, model, and repository", "denied");
  }
  const { placement, role, model, repository } = params;
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
  return { placement, role, model, repository };
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

function readBackAgent(raw, expectedRole, canonicalRoot, modelArgvTail) {
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
  if (kind !== "pi") throw lifecycleError("agent_mismatch", "the spawned agent is not the expected Pi kind");
  const paneId = collectString([agent.pane_id], "agent pane id");
  const cwd = collectString([agent.cwd, agent.foreground_cwd], "agent cwd");
  if (!sameRealPath(cwd, canonicalRoot)) {
    throw lifecycleError("repository_mismatch", "the spawned agent is not in the canonical trusted repository");
  }
  if (agent.launch_pending === true || agent.interactive_ready === false) {
    throw lifecycleError("role_not_ready", "the spawned agent is not observed ready");
  }
  return { paneId };
}

function readBackStart(raw, expectedRole, canonicalRoot, modelArgvTail) {
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
  if (kind !== "pi") throw lifecycleError("agent_mismatch", "the started agent is not the expected Pi kind");
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

// --- Trusted repository resolution (registry + realpath + Git root) ---------
function validateRegistry(registryPath) {
  let raw;
  try {
    raw = readFileSync(registryPath, "utf8");
  } catch {
    throw lifecycleError("worker_registry_invalid", "the Herdr worker repository registry could not be read");
  }
  let registry;
  try {
    registry = JSON.parse(raw);
  } catch {
    throw lifecycleError("worker_registry_invalid", "the Herdr worker repository registry is invalid");
  }
  const keys = isPlainObject(registry) ? Object.keys(registry) : [];
  if (!isPlainObject(registry)
      || keys.length !== 2
      || !keys.includes("schema") || !keys.includes("repositories")
      || registry.schema !== WORKER_REPOSITORY_SCHEMA
      || !Array.isArray(registry.repositories)
      || registry.repositories.length < 1
      || registry.repositories.length > 32
      || new Set(registry.repositories).size !== registry.repositories.length
      || registry.repositories.some((name) => typeof name !== "string"
        || name.length < 1 || name.length > 64 || !SAFE_NAME_REGEXP.test(name))) {
    throw lifecycleError("worker_registry_invalid", "the Herdr worker repository registry is not trusted");
  }
  return registry.repositories;
}

function gitRoot(path) {
  const value = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (value.status !== 0 || !value.stdout.trim()) {
    throw lifecycleError("repository_not_git_root", "the requested repository is not a Git work tree root");
  }
  return resolve(value.stdout.trim());
}

// Resolves the requested registry name BEFORE any mutation and re-checks it
// between the two mutations. Physical identity (realpath + Git root) decides;
// lexical names never do.
// Registry lookup order (coordinator decision): the session repository's
// own config/herdr-worker-repositories.v1.json first; when missing (ENOENT
// only) the active Pi profile's shared config under
// {PI_CODING_AGENT_DIR}/config/ (fallback ~/.pi/agent/config/). A malformed
// registry at either level is a stop, never a silent fallthrough; only a
// missing one falls back.
function resolveProfileConfigPath(relative) {
  const profileDir = process.env.PI_CODING_AGENT_DIR;
  const base = typeof profileDir === "string" && profileDir.trim()
    ? resolve(profileDir.trim())
    : resolve(homedir(), ".pi", "agent");
  return { base, path: resolve(base, relative) };
}

function resolveRegistryPathChecked(coordinatorReal) {
  const localPath = resolve(coordinatorReal, WORKER_REPOSITORY_REGISTRY);
  try {
    if (realpathSync(localPath) !== localPath) {
      throw lifecycleError("worker_registry_invalid", "the Herdr worker repository registry escapes the configured repository");
    }
    return localPath;
  } catch (error) {
    if (error && error.name === "HerdrLifecycleError") throw error;
    if (error?.code !== "ENOENT") {
      throw lifecycleError("worker_registry_invalid", "the Herdr worker repository registry could not be canonicalized");
    }
  }
  const shared = resolveProfileConfigPath(WORKER_REPOSITORY_REGISTRY);
  try {
    const baseReal = realpathSync(shared.base);
    if (realpathSync(shared.path) !== resolve(baseReal, WORKER_REPOSITORY_REGISTRY)) {
      throw lifecycleError("worker_registry_invalid", "the Herdr worker repository registry escapes the profile configuration");
    }
    return shared.path;
  } catch (error) {
    if (error && error.name === "HerdrLifecycleError") throw error;
    if (error?.code === "ENOENT") {
      throw lifecycleError("worker_registry_invalid", "the Herdr worker repository registry is unavailable");
    }
    throw lifecycleError("worker_registry_invalid", "the Herdr worker repository registry could not be canonicalized");
  }
}

export function resolveTrustedSpawnRepository(coordinatorCwd, requestedName) {
  const coordinator = resolve(coordinatorCwd);
  let coordinatorReal;
  try {
    coordinatorReal = realpathSync(coordinator);
  } catch {
    throw lifecycleError("worker_registry_invalid", "the Herdr worker repository registry is unavailable");
  }
  const registryPath = resolveRegistryPathChecked(coordinatorReal);
  const listed = validateRegistry(registryPath);
  if (!listed.includes(requestedName)) {
    throw lifecycleError("repository_untrusted", "the requested repository is not in the trusted registry", "denied");
  }
  const candidate = resolve(coordinatorReal, "..", requestedName);
  let candidateReal;
  try {
    candidateReal = realpathSync(candidate);
  } catch {
    throw lifecycleError("repository_unavailable", "the requested repository is unavailable");
  }
  if (candidateReal !== resolve(coordinatorReal, "..", requestedName)) {
    throw lifecycleError("repository_untrusted", "the requested repository entry is not a canonical sibling", "denied");
  }
  const root = gitRoot(candidateReal);
  if (root !== candidateReal) {
    throw lifecycleError("repository_not_git_root", "the requested repository resolved outside its Git root", "denied");
  }
  return candidateReal;
}

// --- Installed Pi model roll (read-only; no allowlist constant) -------------
// The authoritative installed roll is the merged Pi catalog: built-in provider
// models plus the profile's custom models.json entries. It resolves read-only
// via the documented fixed argv `pi --list-models` table; custom models.json
// entries remain an additional accepted source. The roll is parsed once per
// resolveInstalledModel call and is never cached across calls.
const PROVIDER_TOKEN_REGEXP = /^[a-z0-9][a-z0-9._-]*$/i;
const MODEL_TOKEN_REGEXP = /^[a-z0-9][a-z0-9._/-]*$/i;

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
    if (!PROVIDER_TOKEN_REGEXP.test(provider) || !MODEL_TOKEN_REGEXP.test(id)) continue;
    pairs.add(`${provider}/${id}`);
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
      if (isPlainObject(model) && typeof model.id === "string"
          && PROVIDER_TOKEN_REGEXP.test(provider)
          && MODEL_TOKEN_REGEXP.test(model.id)) {
        pairs.add(`${provider}/${model.id}`);
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
  const slash = requested.indexOf("/");
  const matches = slash < 0
    ? [...pairs].filter((pair) => pair.slice(pair.indexOf("/") + 1) === requested)
    : (pairs.has(requested) ? [requested] : []);
  if (matches.length === 0) {
    throw lifecycleError("model_unknown", "the requested model is not in the installed Pi model roll", "denied");
  }
  if (matches.length > 1) {
    throw lifecycleError("model_ambiguous", "the requested model id matches more than one installed provider model", "denied");
  }
  // Documented Pi selection flag; no thinking suffix, no extra arguments.
  return Object.freeze(["--model", matches[0]]);
}

// --- Fixed argv builders ----------------------------------------------------
export function currentPaneArgv() {
  return Object.freeze(["pane", "current", "--current"]);
}

export function tabCreateArgv(canonicalRoot, role) {
  return Object.freeze([
    "tab", "create", "--cwd", canonicalRoot, "--no-focus", "--label", role,
  ]);
}

export function splitArgv(coordinatorPaneId, canonicalRoot, placement) {
  return Object.freeze([
    "pane", "split", coordinatorPaneId,
    "--direction", HERDR_DIRECTIONS[placement],
    "--cwd", canonicalRoot,
    "--no-focus",
  ]);
}

export function startArgv(role, paneId, modelArgv) {
  return Object.freeze([
    "agent", "start", role, "--kind", "pi", "--pane", paneId,
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
  const executable = resolveTrustedHerdrExecutable(
    typeof options.runProcess === "function" ? { runProcess: options.runProcess } : {},
  );
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
    const { spawn } = await import("node:child_process");
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function executeHerdrSpawnWorker(params, context, options = {}, signal) {
  let request;
  try {
    request = validateSpawnParams(params);
    const { placement, role, model, repository } = request;

    // Resolve BEFORE any mutation: registry + realpath + Git root.
    let canonicalRoot = resolveTrustedSpawnRepository(context?.cwd, repository);
    const modelArgv = resolveInstalledModel(model, options);

    // The calling pane must be a Herdr session pane; `pane current --current`
    // resolves the coordinator pane identity for the final move step.
    const currentPane = process.env.HERDR_PANE_ID;
    if (typeof currentPane !== "string" || !currentPane.trim()) {
      throw lifecycleError("current_pane_unavailable", "HERDR_PANE_ID is not set; no current pane to resolve", "denied");
    }

    // Native confirmation is required before any mutation; the cheap local
    // gate comes before any Herdr observation call.
    if (!isNativeTuiContext(context)) {
      throw lifecycleError("native_confirmation_required", "spawn_worker requires the interactive Pi TUI", "blocked");
    }

    // Duplicate live names are denied at spawn (read-only observation).
    const listed = await invokeHerdr(agentListArgv(), canonicalRoot, options, signal);
    if (duplicateRoleExists(listed, role)) {
      throw lifecycleError("duplicate_worker_name", "a live agent already holds this name", "denied");
    }
    const confirmed = await context.ui.confirm(
      "Spawn Herdr worker",
      [
        "One guarded composite spawn: create the requested layout, then start and verify one Pi agent.",
        `Role: ${role}`,
        placement === "tab"
          ? "Placement: individual tab"
          : `Placement: ${placement} (Herdr split: ${HERDR_DIRECTIONS[placement]})`,
        `Model: ${modelArgv[1]} (argv: ${modelArgv.join(" ")})`,
        `Repository: ${canonicalRoot}`,
        "No rollback is automatic; a failed step leaves the created state for human cleanup.",
      ].join("\n"),
    );
    if (confirmed !== true) {
      return errorResult(lifecycleError("confirmation_denied", "native confirmation was not granted", "stopped"));
    }

    // Revalidation point after confirmation, before the first mutation.
    const reconfirmedRoot = resolveTrustedSpawnRepository(context?.cwd, repository);
    if (reconfirmedRoot !== canonicalRoot) {
      throw lifecycleError("repository_mismatch", "the trusted repository changed after confirmation");
    }
    canonicalRoot = reconfirmedRoot;

    // Herdr 0.8.2 owns new-shell readiness. Follow its documented topology:
    // split directly for pane placement, or create a tab for tab placement.
    let coordinator = null;
    if (placement !== "tab") {
      const currentRaw = await invokeHerdr(currentPaneArgv(), canonicalRoot, options, signal);
      coordinator = parseCurrentPane(currentRaw);
    }

    const layoutPartial = placement === "tab" ? "tab_created" : "pane_created";
    let layoutRaw;
    let rootPaneId;
    let tabId;
    try {
      if (placement === "tab") {
        layoutRaw = await invokeHerdr(tabCreateArgv(canonicalRoot, role), canonicalRoot, options, signal);
        ({ rootPaneId, tabId } = parseTabCreate(layoutRaw));
      } else {
        layoutRaw = await invokeHerdr(
          splitArgv(coordinator.paneId, canonicalRoot, placement),
          canonicalRoot, options, signal,
        );
        const split = parsePaneSplit(layoutRaw, coordinator.tabId);
        rootPaneId = split.paneId;
        tabId = split.tabId;
      }
    } catch (error) {
      return partialResult(error, {
        partial: layoutPartial, paneId: rootPaneId, tabId, role, modelArgv,
        ...(typeof layoutRaw === "string" ? { rawResponse: layoutRaw } : {}),
      });
    }

    let agentStartSucceeded = false;
    try {
      // Re-check the registry between the mutations.
      const betweenRoot = resolveTrustedSpawnRepository(context?.cwd, repository);
      if (betweenRoot !== canonicalRoot) {
        throw lifecycleError("repository_mismatch", "the trusted repository changed between mutations");
      }

      // Start exactly once in the shell pane returned by the layout command.
      const startCall = startArgv(role, rootPaneId, modelArgv);
      let startRaw;
      try {
        startRaw = await invokeHerdr(startCall, canonicalRoot, options, signal);
        agentStartSucceeded = true;
      } catch (error) {
        throw lifecycleError("start_failed", error?.message || "Herdr agent start failed");
      }

      // Agent start is a mutation, so authorization must be resolved again
      // before accepting any start/read-back facts.
      const postStartRoot = resolveTrustedSpawnRepository(context?.cwd, repository);
      if (postStartRoot !== canonicalRoot) {
        throw lifecycleError("repository_mismatch", "the trusted repository changed after agent start");
      }
      canonicalRoot = postStartRoot;

      const startedPaneId = readBackStart(startRaw, role, canonicalRoot, [...modelArgv]);
      if (startedPaneId !== rootPaneId) {
        throw lifecycleError("pane_mismatch", "agent start returned a different pane identity");
      }
      const agentRaw = await invokeHerdr(["agent", "get", role], canonicalRoot, options, signal);
      const agentReadBack = readBackAgent(agentRaw, role, canonicalRoot, [...modelArgv]);
      if (agentReadBack.paneId !== rootPaneId) {
        throw lifecycleError("pane_mismatch", "agent get returned a different pane identity");
      }
      const paneRaw = await invokeHerdr(["pane", "get", rootPaneId], canonicalRoot, options, signal);
      readBackPane(paneRaw, rootPaneId, canonicalRoot);

      return {
        schema: HERDR_LIFECYCLE_SCHEMA,
        ok: true,
        status: "spawned",
        role,
        reportMarkers: reportMarkersForRole(role),
        placement,
        direction: placement === "tab" ? null : HERDR_DIRECTIONS[placement],
        paneId: rootPaneId,
        rootPaneId,
        tabId,
        modelArgv: [...modelArgv],
        repository: canonicalRoot,
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
        paneId: rootPaneId, tabId, role, modelArgv,
      });
    }
  } catch (error) {
    return errorResult(error);
  }
}

function toolResult(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

export function registerHerdrLifecycleInterface(pi, options = {}) {
  if (typeof pi?.registerTool !== "function" || REGISTRATIONS.has(pi)) return;
  REGISTRATIONS.add(pi);
  pi.registerTool({
    name: HERDR_SPAWN_WORKER_TOOL,
    label: "Herdr Spawn Worker",
    description: "One guarded composite spawn into the caller's Herdr session: create either a right/below split pane or an individual tab in a trusted repository, then start and verify one Pi agent there. Includes native confirmation and bounded read-back.",
    promptSnippet: "Use agentic_herdr_spawn_worker only to spawn one confirmed worker as its own tab or as a right/below pane in a trusted registry repository; it exposes no raw Herdr management verbs and no terminal remote control.",
    promptGuidelines: [
      "Roles are free-form safe names except the coordinator class; models must resolve against the installed Pi model roll.",
      "A failed start leaves the created tab for human cleanup; no automatic close is performed.",
      "The receipt is observed state only: names, argv, and self-reports are never authority.",
    ],
    parameters: HERDR_SPAWN_WORKER_PARAMETERS,
    async execute(_id, params, signal, _update, context) {
      return toolResult(await executeHerdrSpawnWorker(params, context, options, signal));
    },
  });
}

export default registerHerdrLifecycleInterface;

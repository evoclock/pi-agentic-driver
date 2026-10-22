// The only writable outward route for a driver-owned journey. A worker's
// independent shell actions are outside this boundary.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isNativeTuiContext } from "./native_tui_context.js";

export const OUTWARD_TOOL = "agentic_journey_outward_effect";
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^(?!main$|master$)[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/;
const BASE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/;
const REPO = /^[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const run = (bin, args, cwd, input) => execFileSync(bin, args, {
  cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024,
  ...(input === undefined ? {} : { input: JSON.stringify(input) }),
}).trim();
const git = (args, cwd) => run("git", args, cwd);
const remoteHead = (cwd, branch) => {
  const line = git(["ls-remote", "origin", `refs/heads/${branch}`], cwd);
  if (!line) return null;
  const match = /^([a-f0-9]{40})\trefs\/heads\/(.+)$/.exec(line);
  if (!match || match[2] !== branch) throw new Error("remote branch observation ambiguous");
  return match[1];
};
const gh = (args, cwd, options, input) => run(options.ghExecutable ?? "gh", args, cwd, input);
const pr = (repository, number, cwd, options) => JSON.parse(gh(["api", `repos/${repository}/pulls/${number}`], cwd, options));
const prs = (repository, branch, cwd, options) => {
  const owner = repository.split("/")[0];
  const list = JSON.parse(gh(["api", `repos/${repository}/pulls?state=all&head=${owner}:${branch}&per_page=100`], cwd, options));
  if (!Array.isArray(list) || list.length > 1 || list.length === 100) throw new Error("PR observation ambiguous");
  return list[0] ?? null;
};
function matchingPr(item, request) {
  return item?.state === "open" && item?.draft === true && item?.head?.ref === request.branch &&
    item.head?.sha === request.targetHead && item.head?.repo?.full_name === request.repository &&
    item.base?.ref === request.base && item.base?.repo?.full_name === request.repository &&
    item.title === request.title && digest(item.body ?? "") === digest(request.body);
}
function validate(request) {
  if (!request || !["push", "pr-create", "pr-update"].includes(request.action) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(request.journeyId ?? "") ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(request.effectId ?? "") ||
      !REPO.test(request.repository ?? "") || !BRANCH.test(request.branch ?? "") ||
      !SHA.test(request.targetHead ?? "")) throw new Error("invalid outward effect identity");
  if (request.action === "push") {
    if (request.expectedHead !== null && !SHA.test(request.expectedHead ?? "")) throw new Error("expected remote head required (or null for a new branch)");
  } else if (!BASE.test(request.base ?? "") || typeof request.title !== "string" ||
      !request.title.trim() || request.title.length > 200 || typeof request.body !== "string" ||
      Buffer.byteLength(request.body, "utf8") > 16000 ||
      (request.action === "pr-create" && request.number !== undefined) ||
      (request.action === "pr-update" && (!Number.isSafeInteger(request.number) || request.number < 1 ||
        !/^[a-f0-9]{64}$/.test(request.previousBodyDigest ?? "")))) {
    throw new Error("invalid private PR request");
  }
}
async function privateRepository(request, cwd, options) {
  if (options.repositoryProof) return options.repositoryProof(request, cwd);
  const url = git(["remote", "get-url", "origin"], cwd);
  const https = `https://github.com/${request.repository}.git`;
  const ssh = `git@github.com:${request.repository}.git`;
  if (![https, https.slice(0, -4), ssh, ssh.slice(0, -4)].includes(url)) throw new Error("origin does not match requested repository");
  const observed = JSON.parse(gh(["repo", "view", request.repository, "--json", "nameWithOwner,isPrivate"], cwd, options));
  if (observed.nameWithOwner !== request.repository || observed.isPrivate !== true) throw new Error("verified private repository required");
  return true;
}

export async function executeOutwardEffect(request, context, options = {}) {
  try {
    validate(request);
    const cwd = realpathSync(context.cwd);
    git(["check-ref-format", "--branch", request.branch], cwd);
    if (request.action !== "push") git(["check-ref-format", "--branch", request.base], cwd);
    if (await privateRepository(request, cwd, options) !== true) throw new Error("verified private repository required");
    if (!isNativeTuiContext(context)) throw new Error("native TUI confirmation required");
    const store = await options.getJourneyStore(context);
    const journeys = await store.listJourneys();
    if (!journeys.some((entry) => entry.journeyId === request.journeyId &&
        realpathSync(entry.repository) === cwd)) {
      throw new Error("existing durable journey required");
    }
    const confirmed = await context.ui.confirm("Confirm outward journey effect",
      `${request.action} for ${request.repository}, branch ${request.branch}, journey ${request.journeyId}?`);
    if (confirmed !== true) throw new Error("native confirmation not granted");
    const spec = request.action === "push"
      ? { expectedHead: request.expectedHead, targetHead: request.targetHead }
      : { targetHead: request.targetHead, base: request.base, titleDigest: digest(request.title),
        bodyDigest: digest(request.body), ...(request.action === "pr-update" ? { number: request.number } : {}),
        ...(request.previousBodyDigest ? { previousBodyDigest: request.previousBodyDigest } : {}) };
    const record = { id: `out-${digest(`${request.journeyId}:${request.effectId}`).slice(0, 32)}`,
      digest: digest(JSON.stringify({ action: request.action, repository: request.repository, branch: request.branch, spec })),
      repository: cwd, createdAt: Date.now(), kind: request.action, journeyId: request.journeyId };
    // createdAt must remain stable across reattachment; the store checks every
    // immutable field except its timestamp, which is not part of the identity.
    const observe = () => {
      if (request.action === "push") {
        const head = remoteHead(cwd, request.branch);
        return head === request.targetHead ? { verified: true, reference: head } : { verified: false };
      }
      const item = request.action === "pr-create"
        ? prs(request.repository, request.branch, cwd, options)
        : pr(request.repository, request.number, cwd, options);
      return matchingPr(item, request) && Number.isSafeInteger(item.number)
        ? { verified: true, reference: String(item.number) } : { verified: false };
    };
    const apply = () => {
      if (request.action === "push") {
        const local = git(["rev-parse", "HEAD"], cwd);
        if (local !== request.targetHead || git(["branch", "--show-current"], cwd) !== request.branch ||
            remoteHead(cwd, request.branch) !== request.expectedHead) throw new Error("branch or remote head drift");
        git(["push", "origin", `${request.targetHead}:refs/heads/${request.branch}`], cwd);
        return;
      }
      if (remoteHead(cwd, request.branch) !== request.targetHead) throw new Error("PR head is not on the remote");
      const existing = request.action === "pr-create"
        ? prs(request.repository, request.branch, cwd, options)
        : pr(request.repository, request.number, cwd, options);
      if (request.action === "pr-create") {
        if (existing) throw new Error("PR already exists; observe only");
        gh(["api", "--method", "POST", `repos/${request.repository}/pulls`, "--input", "-"], cwd, options,
          { title: request.title, body: request.body, head: request.branch, base: request.base, draft: true });
      } else {
        if (existing?.state !== "open" || existing?.draft !== true || existing?.head?.ref !== request.branch ||
            existing?.head?.sha !== request.targetHead || existing?.head?.repo?.full_name !== request.repository ||
            existing?.base?.ref !== request.base || digest(existing?.body ?? "") !== request.previousBodyDigest) {
          throw new Error("PR baseline changed; refusing update");
        }
        gh(["api", "--method", "PATCH", `repos/${request.repository}/pulls/${request.number}`, "--input", "-"],
          cwd, options, { title: request.title, body: request.body, base: request.base });
      }
    };
    const result = await store.runOutwardEffect(record, { apply, observe, boundary: options.boundary });
    return { schema: "agentic-driver.outward-effect.v1", ok: result.state === "verified", status: result.state,
      reference: result.report ?? null, nonAuthorizing: true };
  } catch (error) {
    return { schema: "agentic-driver.outward-effect.v1", ok: false, status: "blocked",
      reason: String(error?.message ?? error).slice(0, 256), nonAuthorizing: true };
  }
}

export function registerOutwardEffectInterface(pi, options = {}) {
  pi.registerTool({ name: OUTWARD_TOOL,
    description: "Confirm one durable Git push or draft private PR create/update for an existing journey; uncertain effects are never replayed.",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["action", "journeyId", "effectId", "repository", "branch", "targetHead"],
      properties: Object.fromEntries(["action", "journeyId", "effectId", "repository", "branch", "targetHead",
        "expectedHead", "base", "title", "body", "number", "previousBodyDigest"].map((key) =>
        [key, { type: key === "number" ? "integer" : key === "expectedHead" ? ["string", "null"] : "string" }])),
    },
    async execute(_id, params, _signal, _update, context) {
      const result = await executeOutwardEffect(params, context, options);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}

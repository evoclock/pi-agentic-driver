import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { resolveInstalledModel, validateSpawnParams } from "../scripts/enforcement/herdr_lifecycle_pi.js";

const listModels = "provider model\ngateway-a model-x\nvendor-a model-x\ngateway-a model-y\nother-gateway model-y";
const policy = {
  schema: "agentic-driver.model-route-policy.v1",
  routes: [
    { provider: "gateway-a", model: "model-x", family: "family-x", subscription: false, gateway: true, aliases: ["Model X"] },
    { provider: "vendor-a", model: "model-x", family: "family-x", subscription: true, gateway: false, aliases: ["Model X"] },
    { provider: "gateway-a", model: "model-y", family: "family-y", subscription: false, gateway: true, aliases: ["Model Y"] },
    { provider: "other-gateway", model: "model-y", family: "family-y", subscription: false, gateway: true, aliases: ["Model Y"] },
  ],
  bannedPairs: [{ family: "family-x", provider: "gateway-a" }], budgets: {},
};
const options = { listModels, modelsPath: "/nonexistent-model-roll", routePolicy: policy };
const resolve = (request, overrides = {}) => resolveInstalledModel(request, { ...options, ...overrides });
const denies = (request, code, overrides = {}) => assert.throws(() => resolve(request, overrides), (error) => error.code === code);

test("loose names select subscription across the entire installed roll, independent of provider order", () => {
  assert.equal(validateSpawnParams({ placement: "tab", role: "worker", model: "Model X", repository: "repo" }).model, "Model X");
  assert.deepEqual(resolve("Model X"), ["--model", "vendor-a/model-x"]);
  assert.deepEqual(resolve("model-x"), ["--model", "vendor-a/model-x"]);
  assert.deepEqual(resolve("Model X", { listModels: listModels.split("\n").reverse().join("\n") }), ["--model", "vendor-a/model-x"]);
});

test("policy single-word aliases resolve case-insensitively", () => {
  const routePolicy = { ...policy, routes: policy.routes.map((route) => route.subscription
    ? { ...route, aliases: [...route.aliases, "Alpha"] } : route) };
  assert.deepEqual(resolve("Alpha", { routePolicy }), ["--model", "vendor-a/model-x"]);
});

test("a loose name cannot bypass a banned subscription route", () => {
  const routePolicy = { ...policy, bannedPairs: [...policy.bannedPairs, { family: "family-x", provider: "vendor-a" }] };
  denies("Model X", "model_gateway_denied", { routePolicy });
  denies("vendor-a/model-x", "model_gateway_denied", { routePolicy });
});

test("banned gateway remains denied even with unlimited budget or failed subscription", () => {
  const routePolicy = { ...policy, budgets: { "gateway-a": { "model-x": "no-limit" } } };
  denies("gateway-a/model-x", "model_gateway_denied", { routePolicy });
  denies("gateway-a/model-x", "model_gateway_denied", { routePolicy, isRouteAvailable: () => false });
  assert.throws(() => resolve("Model X", { isRouteAvailable: () => false }), /vendor-a\/model-x/);
});

test("missing or malformed local policy fails closed without gateway fallback", () => {
  assert.throws(() => resolveInstalledModel("model-y", { listModels, modelsPath: "/nonexistent-model-roll", policyPath: "/nonexistent-dir/config/model-route-policy.v1.local.json" }),
    (error) => error.code === "model_policy_missing" && error.message.includes("model-route-policy.v1.local.json"));
  denies("model-y", "model_policy_invalid", { routePolicy: { ...policy, routes: [] , bannedPairs: null } });
});

test("a symlinked policy path fails closed with a specific error", () => {
  // The platform's standard input path is a symlink; no policy contents are read.
  assert.equal(lstatSync("/dev/stdin").isSymbolicLink(), true);
  assert.throws(() => resolveInstalledModel("model-x", {
    listModels, modelsPath: "/nonexistent-model-roll", policyPath: "/dev/stdin",
  }), (error) => error.code === "model_policy_symlink" && /symlink/.test(error.message));
});

test("policies beyond the 128-route bound are denied before route choice", () => {
  const routes = Array.from({ length: 129 }, (_, index) => ({ ...policy.routes[0], model: `model-${index}` }));
  denies("gateway-a/model-x", "model_policy_invalid", { routePolicy: { ...policy, routes } });
});

test("unknown or ambiguous routes never take the first hit", () => {
  denies("absent", "model_unknown");
  denies("model-y", "model_ambiguous");
  denies("gateway-a/not-installed", "model_unknown");
});

test("gateway requires exact provider-model budget or explicit no-limit", () => {
  denies("gateway-a/model-y", "model_budget_required");
  denies("gateway-a/model-y", "model_budget_required", { routePolicy: { ...policy, budgets: { "other-gateway": { "model-y": 10 } } } });
  denies("gateway-a/model-y", "model_budget_required", { routePolicy: { ...policy, budgets: { "gateway-a": { "model-y": 0 } } } });
  for (const budget of [1, "no-limit"]) {
    assert.deepEqual(resolve("gateway-a/model-y", { routePolicy: { ...policy, budgets: { "gateway-a": { "model-y": budget } } } }),
      ["--model", "gateway-a/model-y"]);
  }
});

test("explicit gateway request does not silently switch; fallback requires unavailable subscription and budget", () => {
  const routePolicy = { ...policy, bannedPairs: [], budgets: { "gateway-a": { "model-x": 3 } } };
  denies("gateway-a/model-x", "model_subscription_preferred", { routePolicy });
  denies("gateway-a/model-x", "model_budget_required", { routePolicy: { ...routePolicy, budgets: {} }, isRouteAvailable: () => false });
  assert.deepEqual(resolve("gateway-a/model-x", { routePolicy, isRouteAvailable: () => false }), ["--model", "gateway-a/model-x"]);
  denies("vendor-a/model-x", "model_unavailable", { routePolicy, isRouteAvailable: () => false });
});

test("an unavailable explicit subscription refuses; only a loose name can use a budgeted fallback", () => {
  const routePolicy = { ...policy, bannedPairs: [], budgets: { "gateway-a": { "model-x": 3 } } };
  const unavailable = { routePolicy, isRouteAvailable: () => false };
  denies("vendor-a/model-x", "model_unavailable", unavailable);
  assert.deepEqual(resolve("Model X", unavailable), ["--model", "gateway-a/model-x"]);
});

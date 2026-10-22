#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const file = process.env.OUTWARD_FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ nameWithOwner: args[2], isPrivate: true }));
  process.exit(0);
}
if (args[0] !== "api") process.exit(2);
const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
const route = args.find((arg) => arg.startsWith("repos/"));
if (!route) process.exit(2);
const branch = state.branch;
const item = (entry) => ({ ...entry, head: { ref: branch, sha: state.head,
  repo: { full_name: state.repository } }, base: { ref: entry.base, repo: { full_name: state.repository } } });
if (method === "GET") {
  if (state.failGetOnce) {
    state.failGetOnce = false;
    writeFileSync(file, JSON.stringify(state));
    process.exit(3);
  }
  if (route.includes("?")) console.log(JSON.stringify(state.pulls.map(item)));
  else console.log(JSON.stringify(item(state.pulls.find((entry) => route.endsWith(`/${entry.number}`)) ?? {})));
  process.exit(0);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
if (method === "POST") state.pulls.push({ ...payload, number: 1, state: "open" });
else if (method === "PATCH") {
  const existing = state.pulls.find((entry) => route.endsWith(`/${entry.number}`));
  if (!existing) process.exit(2);
  Object.assign(existing, payload);
} else process.exit(2);
state.writes += 1;
writeFileSync(file, JSON.stringify(state));
console.log(JSON.stringify(item(state.pulls.at(-1))));

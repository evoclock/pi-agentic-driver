// SPDX-License-Identifier: AGPL-3.0-only
// Hashes every file under the ported pstack skills (skills/*-pi). The test
// compares them with tests/fixtures/ported-skill-hashes.v1.json so a change
// to a port is always deliberate. Regenerate only for an approved port update:
//   node scripts/ported_skill_hashes.mjs --write
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURE = join(ROOT, "tests", "fixtures", "ported-skill-hashes.v1.json");

function walk(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function portedSkillHashes(root = ROOT) {
  const skills = join(root, "skills");
  const out = {};
  for (const name of readdirSync(skills).sort()) {
    if (!name.endsWith("-pi") || !statSync(join(skills, name)).isDirectory()) continue;
    for (const file of walk(join(skills, name))) {
      out[relative(root, file).split("\\").join("/")] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  writeFileSync(FIXTURE, `${JSON.stringify(portedSkillHashes(), null, 2)}\n`);
}

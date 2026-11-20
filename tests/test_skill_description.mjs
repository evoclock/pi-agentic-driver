import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSkills, questionsFor } from '../scripts/skill_usage_core.mjs';

// Why: Synthetic frontmatter must preserve purpose, folding, indentation and chomping without depending on installed skills.
test('catalogue descriptions decode YAML block scalars and single lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-description-'));
  const cases = [
    ['>', '  Synthetic purpose\n  continues\n\n', 'Synthetic purpose continues\n'],
    ['>-', '  Synthetic purpose\n  continues\n\n', 'Synthetic purpose continues'],
    ['|', '  Synthetic purpose\n  continues\n\n', 'Synthetic purpose\ncontinues\n'],
    ['|-', '  Synthetic purpose\n  continues\n\n', 'Synthetic purpose\ncontinues'],
    ['|+', '  Synthetic purpose\n\n', 'Synthetic purpose\n\n'],
    ['>-', '  Synthetic purpose\n\n  paragraph\n    code\n  end\n', 'Synthetic purpose\nparagraph\n  code\nend'],
    ['"Synthetic purpose"', '', 'Synthetic purpose'],
    ["'Synthetic purpose'", '', 'Synthetic purpose'],
    ['Synthetic purpose', '', 'Synthetic purpose'],
  ];
  try {
    for (const [i, [indicator, body]] of cases.entries()) {
      await mkdir(join(root, `fixture-${i}`));
      await writeFile(join(root, `fixture-${i}`, 'SKILL.md'), `---\nname: fixture-${i}\ndescription: ${indicator}\n${body}other: ignored\n---\n# Body\ndescription: not frontmatter\n`);
    }
    const catalog = await discoverSkills([['synthetic', root]]);
    assert.equal(catalog.length, cases.length);
    for (const [i, [, , expected]] of cases.entries()) {
      const skill = catalog.find(s => s.name === `fixture-${i}`);
      assert.equal(skill.description, expected);
      assert.ok(questionsFor([skill], new Set(), 'synthetic task')[0].instructions.includes(`Skill purpose: ${expected}.`));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

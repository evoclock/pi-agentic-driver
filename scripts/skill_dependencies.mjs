// SPDX-License-Identifier: AGPL-3.0-only
// Static reference audit; absence of a reference is not proof of runtime availability.
const externalNames = ['recall-pi', 'create-verification-skill-pi', 'statechart-pi', 'pi-poteto-mode', 'poteto-mode', 'ship', 'project-knowledge', 'clean-room'];
export function dependenciesMissing(text, shipped) {
  const missing = [];
  for (const name of externalNames) {
    if (shipped.includes(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = [...text.matchAll(new RegExp(`(?:\\/skill:|\\x60)${escaped}(?:\\x60)?`, 'gi'))];
    for (const match of matches) {
      const start = match.index;
      const line = text.slice(text.lastIndexOf('\n', start) + 1, text.indexOf('\n', start) < 0 ? text.length : text.indexOf('\n', start));
      if (!/if installed|if [^.,;\n]{0,60} installed|if present/i.test(line) && !/not bundled|if unavailable/i.test(line)) {
        missing.push(name);
        break;
      }
    }
  }
  return missing;
}

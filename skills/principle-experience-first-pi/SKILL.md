---
name: principle-experience-first-pi
description: For an approved product, UX or feature-scope tradeoff, prefer the core user experience over implementation convenience and explain impact for users and maintainers. Use explicitly before choosing what to ship.
disable-model-invocation: true
license: MIT; see ../how/LICENSE
---

# Experience first

Adapted from Lauren Tan's `principle-experience-first` at `cursor/plugins@99743e9c151c8537cbbf1f98bb38f34ef3368453` (MIT). Read `../how/WORKFLOW_BOUNDARIES.md`. The live `SKILL.md` blob was unchanged from the preserved source pin in the approved census; the installed source body was inspected. A preference for delight is **not** authority to expand a product brief or skip a needed safety check.

When implementation convenience conflicts with the experience that the accepted task serves, name **who consumes the result**: the end user of a UI, the colleague importing a library/internal API, and the engineer who maintains it. Ask what each notices on the real path. Justify every feature, option and control against the central workflow. Prefer fewer polished features to many rough ones, and attend to transitions, alignment, spacing, feedback and error states **when that surface is in scope**. For an unsettled feel-dependent design, use loaded `principle-exhaust-the-design-space-pi` only with authorized prototypes and actual side-by-side observations; otherwise label it a proposed experiment. Foundational thinking chooses the **sequence** of work; experience first chooses the **target**. Neither permits an unapproved redesign. Measure or observe the user-visible tradeoff when safe; report absent app evidence as `unrun`, not delight proved by opinion.

- **Positive BDD:** Given an approved UX or API scope tradeoff with a real user path, when Pi compares a simpler polished core against extra features or developer convenience on that path, then it names which consumers benefit, what was actually observed and the owner-approved choice.
- **Refusal BDD:** Given no approved product direction, usable target or safe verification surface, when a 'delight' recommendation would widen scope or claim success, then keep the accepted brief, mark the comparison `blocked`/`unrun` and ask for the needed owner call without changing behavior.

This principle file is not a user-experience test or product decision by itself.

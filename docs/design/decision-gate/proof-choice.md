# Proof registration decision

The skill is guidance-only. Its code registration currently certifies only package text and the finite sample model, not guidance compliance.

Options:
1. Native behavior registration and a behavior fixture. Prefer this when the existing harness has a selected model.
2. Keep code registration with an explicit acceptance gap and contract test, without claiming a behavior trial passed.
3. Hold the affected proof claim; continue independent corrections.

Observed: `scripts/skill_proof.mjs` requires an explicit `--model` or `SKILL_PROOF_MODEL`; neither a shared environment selection nor local proof evidence was present. The script has no default model. Do not invent a new model selection or infer one from the worker's identity. A fixture alone cannot make the live harness runnable.

Choice: option 2 under the conditional acceptance rule, with the guidance proof claim held. The proof map, README and skill Limits explicitly record this gap. The skill-shape test rejects removing the acceptance or advertising an unqualified behavior proof. Once the shared proof model is configured, choose option 1 and add/run its fixture through the existing harness.

The statechart tool was unavailable in this session. The smallest model was written manually as `ProofChoice.tla`; TLC was available and ran. `ProofChoice-code.cfg` passed (2 distinct states); `ProofChoice-unsafe-behavior.cfg` failed with exit 12 and `HarnessRunnable`; `ProofChoice-behavior.cfg` passed (2 distinct states), showing the preferred route when configured. The model is a check of the stated assumptions, not proof that a model provider will answer correctly. Hold is included as a non-executing alternative.

The original plan resumes through the existing contract suite while keeping behavior acceptance visibly incomplete. No gate, cap, baseline or evidence was edited to settle this choice.

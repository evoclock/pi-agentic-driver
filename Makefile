.PHONY: all gate base-freshness lease-start test-gate skill-proof skill-usage-eval skill-usage-handcheck preflight pre-push

preflight:
	node scripts/review_preflight.mjs

all: gate

base-freshness:
	python3 scripts/check_base_freshness.py

lease-start:
	python3 scripts/check_base_freshness.py --lease-start

gate: base-freshness
	python3 scripts/gate.py

pre-push:
	python3 scripts/gate.py --pre-push

TEST_GATE_PHASE ?= check
TEST_GATE_MUTATIONS ?= all

test-gate:
	TEST_GATE_MUTATIONS=$(TEST_GATE_MUTATIONS) python3 scripts/gate.py --native-phase $(TEST_GATE_PHASE)

skill-proof:
	node scripts/skill_proof.mjs

skill-usage-eval:
	node scripts/skill_usage_eval.mjs --days 7

skill-usage-handcheck:
	node scripts/skill_usage_handcheck.mjs --labels "$(LABELS)" --predictions "$(PREDICTIONS)"

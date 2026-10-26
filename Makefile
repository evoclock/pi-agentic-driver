.PHONY: all gate test-gate

all: gate

gate:
	python3 scripts/gate.py

TEST_GATE_PHASE ?= check

test-gate:
	python3 scripts/test_gate_runner.py --phase $(TEST_GATE_PHASE)

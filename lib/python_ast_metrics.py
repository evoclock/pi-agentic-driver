# SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
# SPDX-License-Identifier: AGPL-3.0-or-later

#!/usr/bin/env python3
"""AST-backed complexity metrics for code-phage.

The process accepts one JSON object on stdin and emits one JSON object on
stdout. It reads no files and writes no files; the JavaScript caller supplies
source text after enforcing repository containment.
"""

from __future__ import annotations

import ast
import io
import json
import tokenize
import sys
from dataclasses import dataclass, field


LOGICAL_NODES = (ast.And, ast.Or)


@dataclass
class Metric:
    name: str
    kind: str
    line: int
    end_line: int = 0
    cyclomatic: int = 1
    cognitive: int = 0
    decisions: list[dict] = field(default_factory=list)
    logical_sequences: list[dict] = field(default_factory=list)
    recursive_calls: int = 0
    max_nesting: int = 0

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "kind": self.kind,
            "line": self.line,
            "endLine": self.end_line,
            "cyclomaticComplexity": self.cyclomatic,
            "cognitiveComplexity": self.cognitive,
            "decisionPoints": self.decisions,
            "logicalSequences": self.logical_sequences,
            "recursiveCalls": self.recursive_calls,
            "maxNesting": self.max_nesting,
        }


class ComplexityVisitor(ast.NodeVisitor):
    def __init__(self, metric: Metric, current_name: str, root: ast.AST):
        self.metric = metric
        self.current_name = current_name
        self.root = root
        self.nesting = 0

    def _decision(self, node: ast.AST, kind: str, cognitive_nesting: int | None = None) -> None:
        nesting = self.nesting if cognitive_nesting is None else cognitive_nesting
        self.metric.cyclomatic += 1
        self.metric.cognitive += 1 + nesting
        self.metric.max_nesting = max(self.metric.max_nesting, self.nesting)
        self.metric.decisions.append({
            "kind": kind,
            "line": getattr(node, "lineno", 0),
            "nesting": self.nesting,
        })

    def _visit_sequence(self, nodes: list[ast.AST], nesting: int | None = None) -> None:
        previous = self.nesting
        if nesting is not None:
            self.nesting = nesting
            self.metric.max_nesting = max(self.metric.max_nesting, self.nesting)
        for node in nodes:
            self.visit(node)
        self.nesting = previous

    def visit_If(self, node: ast.If) -> None:
        self._decision(node, "if", 0 if getattr(node, "_code_phage_elif", False) else None)
        self.visit(node.test)
        self._visit_sequence(node.body, self.nesting + 1)
        if not node.orelse:
            return
        if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
            child = node.orelse[0]
            child._code_phage_elif = True
            self.visit(child)
            return
        self.metric.cognitive += 1
        self.metric.decisions.append({"kind": "else", "line": getattr(node.orelse[0], "lineno", 0), "nesting": self.nesting})
        self._visit_sequence(node.orelse, self.nesting + 1)

    def _visit_loop(self, node: ast.AST, kind: str, fields: tuple[str, ...]) -> None:
        self._decision(node, kind)
        for field_name in fields:
            value = getattr(node, field_name, None)
            if isinstance(value, ast.AST):
                self.visit(value)
            elif isinstance(value, list):
                for child in value:
                    if isinstance(child, ast.AST):
                        self.visit(child)
        body = getattr(node, "body", [])
        self._visit_sequence(body, self.nesting + 1)
        orelse = getattr(node, "orelse", [])
        if orelse:
            self._visit_sequence(orelse, self.nesting + 1)

    def visit_For(self, node: ast.For) -> None:
        self._visit_loop(node, "for", ("target", "iter"))

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self._visit_loop(node, "async-for", ("target", "iter"))

    def visit_While(self, node: ast.While) -> None:
        self._decision(node, "while")
        self.visit(node.test)
        self._visit_sequence(node.body, self.nesting + 1)
        if node.orelse:
            self._visit_sequence(node.orelse, self.nesting + 1)

    def visit_Try(self, node: ast.Try) -> None:
        self._visit_sequence(node.body, self.nesting)
        for handler in node.handlers:
            self._decision(handler, "except")
            self._visit_sequence(handler.body, self.nesting + 1)
        self._visit_sequence(node.orelse, self.nesting)
        self._visit_sequence(node.finalbody, self.nesting)

    def visit_TryStar(self, node: ast.TryStar) -> None:
        self.visit_Try(node)

    def visit_Match(self, node: ast.Match) -> None:
        self.metric.cognitive += 1 + self.nesting
        self.metric.max_nesting = max(self.metric.max_nesting, self.nesting)
        self.metric.decisions.append({"kind": "match", "line": getattr(node, "lineno", 0), "nesting": self.nesting})
        self.visit(node.subject)
        for case in node.cases:
            if not _is_wildcard_case(case):
                self.metric.cyclomatic += 1
                self.metric.decisions.append({"kind": "case", "line": getattr(case, "lineno", 0), "nesting": self.nesting + 1})
            self._visit_sequence([case.pattern], self.nesting + 1)
            if case.guard:
                self.visit(case.guard)
            self._visit_sequence(case.body, self.nesting + 1)

    def visit_IfExp(self, node: ast.IfExp) -> None:
        self._decision(node, "conditional-expression")
        self.visit(node.test)
        self._visit_sequence([node.body, node.orelse], self.nesting + 1)

    def visit_BoolOp(self, node: ast.BoolOp) -> None:
        operators = [type(node.op).__name__.lower()] * max(0, len(node.values) - 1)
        self.metric.cyclomatic += len(operators)
        if operators:
            self.metric.cognitive += 1
            self.metric.logical_sequences.append({
                "line": getattr(node, "lineno", 0),
                "operators": operators,
                "cognitiveIncrement": 1,
            })
        for value in node.values:
            self.visit(value)

    def visit_comprehension(self, node: ast.comprehension) -> None:
        self.metric.cyclomatic += 1
        self.metric.cognitive += 1 + self.nesting
        self.metric.max_nesting = max(self.metric.max_nesting, self.nesting)
        self.metric.decisions.append({"kind": "comprehension-for", "line": getattr(node, "lineno", 0), "nesting": self.nesting})
        self.visit(node.target)
        self.visit(node.iter)
        for condition in node.ifs:
            self.metric.cyclomatic += 1
            self.metric.cognitive += 1 + self.nesting
            self.metric.decisions.append({"kind": "comprehension-if", "line": getattr(condition, "lineno", 0), "nesting": self.nesting})
            self.visit(condition)

    def visit_Call(self, node: ast.Call) -> None:
        if self.current_name != "<module>" and isinstance(node.func, ast.Name) and node.func.id == self.current_name:
            self.metric.cognitive += 1
            self.metric.recursive_calls += 1
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if node is not self.root:
            return
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        if node is not self.root:
            return
        self.generic_visit(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        if node is not self.root:
            return
        self.generic_visit(node)

    def visit_Break(self, node: ast.Break) -> None:
        self.generic_visit(node)

    def visit_Continue(self, node: ast.Continue) -> None:
        self.generic_visit(node)


def _is_wildcard_case(case: ast.match_case) -> bool:
    return isinstance(case.pattern, ast.MatchAs) and case.pattern.pattern is None and case.guard is None


def _callables(tree: ast.AST):
    found: list[tuple[ast.AST, str, str, int, int]] = []

    class Collector(ast.NodeVisitor):
        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            found.append((node, node.name, "function", node.lineno, node.end_lineno or node.lineno))
            self.generic_visit(node)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            found.append((node, node.name, "async-function", node.lineno, node.end_lineno or node.lineno))
            self.generic_visit(node)

        def visit_Lambda(self, node: ast.Lambda) -> None:
            found.append((node, "<lambda>", "lambda", node.lineno, node.end_lineno or node.lineno))
            self.generic_visit(node)

    Collector().visit(tree)
    return found


def _metric_for(root: ast.AST, name: str, kind: str, line: int, end_line: int = 0) -> Metric:
    metric = Metric(name=name, kind=kind, line=line, end_line=end_line)
    ComplexityVisitor(metric, name, root).visit(root)
    return metric


def _parameter_count(node: ast.FunctionDef | ast.AsyncFunctionDef) -> int:
    args = node.args
    return (
        len(getattr(args, "posonlyargs", []))
        + len(args.args)
        + len(args.kwonlyargs)
        + int(args.vararg is not None)
        + int(args.kwarg is not None)
    )


def _static_export_names(node: ast.AST) -> list[str] | None:
    """Return a literal ``__all__`` value, or None when it is dynamic."""
    if not isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return None
    names = []
    for item in node.elts:
        if not isinstance(item, ast.Constant) or not isinstance(item.value, str):
            return None
        names.append(item.value)
    return names


def _code_facts(tree: ast.Module, purpose: str | None) -> dict:
    """Extract conservative, execution-free facts for structural prior-art checks."""
    functions: dict[str, ast.FunctionDef | ast.AsyncFunctionDef] = {}
    public_names: list[str] = []
    explicit_exports: list[str] | None = None
    dependencies: list[str] = []

    for node in tree.body:
        if isinstance(node, ast.Import):
            dependencies.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            prefix = "." * node.level
            dependencies.append(prefix + (node.module or ""))
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions[node.name] = node
            if not node.name.startswith("_"):
                public_names.append(node.name)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if not isinstance(target, ast.Name):
                    continue
                if target.id == "__all__":
                    value = node.value if isinstance(node, ast.Assign) else node.value
                    explicit_exports = _static_export_names(value) if value is not None else None
                elif not target.id.startswith("_"):
                    public_names.append(target.id)

    exported = explicit_exports if explicit_exports is not None else public_names
    exported = list(dict.fromkeys(exported))
    exported_functions = [
        {"name": name, "parameterCount": _parameter_count(functions[name])}
        for name in exported
        if name in functions
    ]
    return {
        "exportedSymbols": exported[:100],
        "exportedFunctions": exported_functions[:50],
        "dependencies": list(dict.fromkeys(dependencies))[:50],
        "purpose": purpose,
    }


def _line_counts(source: str) -> dict:
    lines = source.splitlines() or [""]
    comment_lines = set()
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.COMMENT:
                comment_lines.update(range(token.start[0], token.end[0] + 1))
    except (IndentationError, tokenize.TokenError):
        pass
    blank_lines = {index for index, line in enumerate(lines, start=1) if not line.strip()}
    code_lines = len(lines) - len(comment_lines | blank_lines)
    return {
        "lines": len(lines),
        "codeLines": code_lines,
        "commentLines": len(comment_lines - blank_lines),
        "blankLines": len(blank_lines),
    }


def analyze(payload: dict) -> dict:
    source = payload["source"]
    path = payload["path"]
    try:
        tree = ast.parse(source, filename=path, mode="exec")
    except (SyntaxError, ValueError) as error:
        return {
            "status": "parse-error",
            "path": path,
            "language": "python",
            "method": "ast-v1",
            "parser": "python.ast",
            "parseErrors": 1,
            "error": f"Source contains syntax errors; complexity metrics are unavailable: {error.msg if isinstance(error, SyntaxError) else error}",
            **_line_counts(source),
        }
    module = _metric_for(tree, "<module>", "module", 1)
    callables = [_metric_for(node, name, kind, line, end_line).as_dict() for node, name, kind, line, end_line in _callables(tree)]
    all_metrics = [module.as_dict(), *callables]
    dependencies = sum(isinstance(node, (ast.Import, ast.ImportFrom)) for node in ast.walk(tree))
    total_cyclomatic = sum(item["cyclomaticComplexity"] for item in all_metrics)
    total_cognitive = sum(item["cognitiveComplexity"] for item in all_metrics)
    counts = _line_counts(source)
    return {
        "status": "parsed",
        "path": path,
        "language": "python",
        "method": "ast-v1",
        "parser": "python.ast",
        **counts,
        "module": module.as_dict(),
        "callables": callables,
        "codeFacts": _code_facts(tree, ast.get_docstring(tree)),
        "cyclomaticComplexity": max(item["cyclomaticComplexity"] for item in all_metrics),
        "cognitiveComplexity": max(item["cognitiveComplexity"] for item in all_metrics),
        "totalCyclomaticComplexity": total_cyclomatic,
        "totalCognitiveComplexity": total_cognitive,
        "dependencyCount": dependencies,
        "uncertainty": "AST-derived for Python syntax; metric semantics follow the documented code-phage rules and are not a universal quality gate.",
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        result = analyze(payload)
    except Exception as error:  # pragma: no cover - defensive process boundary
        result = {"status": "unavailable", "error": str(error)}
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Deterministic, static inventory of staged repository code (without executing it)."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
from pathlib import Path

EXTENSIONS = {".py": "python", ".sh": "shell", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".mts": "typescript", ".tsx": "typescript", ".jsx": "javascript"}
JS_FUNCTION = re.compile(r"\b(?:async\s+)?function\s+([\w$]+)\s*\(|\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>|\b(?:async\s+)?([\w$]+)\s*\([^\n()]*\)\s*\{", re.M)
JS_CLASS = re.compile(r"\bclass\s+([\w$]+)")
JS_DEP = re.compile(r"\b(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?['\"]([^'\"]+)['\"]|\b(?:require|import)\s*\(\s*['\"]([^'\"]+)['\"]")
JS_EXPORT = re.compile(r"\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([\w$]+)|\bexports\.([\w$]+)")
SHELL_FUNCTION = re.compile(r"^\s*(?:function\s+)?([A-Za-z_][\w]*)\s*\(\)\s*\{", re.M)
SHELL_SOURCE = re.compile(r"^\s*(?:source|\.)\s+['\"]?([^'\"\s]+)", re.M)


def git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), *args])


def names(pattern: re.Pattern, text: str) -> list[str]:
    return sorted({part for hit in pattern.findall(text) for part in (hit if isinstance(hit, tuple) else (hit,)) if part})


def record(repo: Path, relative: str) -> dict | None:
    path = repo / relative
    if path.is_symlink() or not path.is_file():
        return None
    language = EXTENSIONS.get(path.suffix)
    data = path.read_bytes()
    if language is None and not path.suffix:
        first = data.split(b"\n", 1)[0].lower()
        if first.startswith(b"#!"):
            language = "python" if b"python" in first else "shell" if b"sh" in first else None
    if language is None:
        return None
    text = data.decode("utf-8", errors="replace")
    functions: list[str] = []
    classes: list[str] = []
    dependencies: list[str] = []
    exports: list[str] = []
    if language == "python":
        try:
            tree = ast.parse(text, filename=relative)
        except SyntaxError:
            tree = None  # A broken source file remains visible, never silently omitted.
        if tree:
            functions = sorted({node.name for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))})
            classes = sorted({node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)})
            dependencies = sorted({node.module or "." * node.level for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)} | {alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names})
            exports = sorted(name for name in functions + classes if not name.startswith("_"))
    elif language == "shell":
        functions = names(SHELL_FUNCTION, text)
        dependencies = names(SHELL_SOURCE, text)
        exports = functions
    else:
        functions = [name for name in names(JS_FUNCTION, text) if name not in {"if", "for", "while", "switch", "catch", "function"}]
        classes = names(JS_CLASS, text)
        dependencies = names(JS_DEP, text)
        exports = names(JS_EXPORT, text)
    return {
        "path": relative,
        "subdir": str(Path(relative).parent),
        "filename": path.name,
        "blob_sha": hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest(),
        "loc": len(text.splitlines()),
        "size_bytes": len(data),
        "language": language,
        "functions": [{"name": name} for name in functions],
        "classes": [{"name": name} for name in classes],
        "dependencies": dependencies,
        "exported_symbols": exports,
    }


def generate(repo: Path) -> bytes:
    tracked = git(repo, "ls-files", "--cached", "--full-name", "-z").decode("utf-8", errors="surrogateescape").split("\0")
    rows = [row for rel in sorted(set(tracked)) if rel and (row := record(repo, rel)) is not None]
    return ("".join(json.dumps(row, sort_keys=True, ensure_ascii=True, separators=(",", ":")) + "\n" for row in rows)).encode()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path.cwd())
    parser.add_argument("--check", action="store_true", help="compare without writing")
    args = parser.parse_args()
    repo = Path(git(args.source_root.resolve(), "rev-parse", "--show-toplevel").decode().strip())
    output = repo / "pipeline_output/codebase_inventory.jsonl"
    content = generate(repo)
    if args.check:
        return 0 if output.is_file() and output.read_bytes() == content else 1
    output.parent.mkdir(parents=True, exist_ok=True)
    if not output.is_file() or output.read_bytes() != content:
        output.write_bytes(content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

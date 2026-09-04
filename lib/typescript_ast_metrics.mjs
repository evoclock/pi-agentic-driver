// SPDX-FileCopyrightText: 2026 Julen Gamboa <j.a.r.gamboa@gmail.com>
// SPDX-License-Identifier: AGPL-3.0-or-later

import ts from "typescript";

const LOGICAL_KINDS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node);
}

function hasBody(node) {
  return Boolean(node.body);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function endLineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

function callableName(node, parent, sourceFile) {
  if (node.name) return node.name.getText(sourceFile);
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node) return parent.name.getText(sourceFile);
  if (parent && ts.isPropertyAssignment(parent) && parent.initializer === node) return parent.name.getText(sourceFile);
  if (parent && ts.isPropertyDeclaration(parent) && parent.initializer === node) return parent.name.getText(sourceFile);
  return "<anonymous>";
}

function syntaxKindName(node) {
  return ts.SyntaxKind[node.kind] || "unknown";
}

function logicalOperator(node) {
  return ts.tokenToString(node.operatorToken.kind) || syntaxKindName(node.operatorToken);
}

function isLogicalExpression(node) {
  return Boolean(node) && ts.isBinaryExpression(node) && LOGICAL_KINDS.has(node.operatorToken.kind);
}

function logicalChain(node) {
  const operators = [];
  const collect = (current) => {
    if (isLogicalExpression(current)) {
      collect(current.left);
      operators.push(logicalOperator(current));
      collect(current.right);
    }
  };
  collect(node);
  return operators;
}

function callableRecords(sourceFile) {
  const records = [];
  const collect = (node, parent) => {
    if (isFunctionLike(node) && hasBody(node)) {
      records.push({
        node,
        name: callableName(node, parent, sourceFile),
        kind: syntaxKindName(node),
        line: lineOf(sourceFile, node),
      });
    }
    ts.forEachChild(node, (child) => collect(child, node));
  };
  collect(sourceFile, undefined);
  return records;
}

function newMetric(name, kind, line) {
  return {
    name,
    kind,
    line,
    cyclomaticComplexity: 1,
    cognitiveComplexity: 0,
    decisionPoints: [],
    logicalSequences: [],
    recursiveCalls: 0,
    maxNesting: 0,
  };
}

function analyzeRegion(root, sourceFile, name, kind, callableRoot = false) {
  const metric = newMetric(name, kind, lineOf(sourceFile, root));
  const scoreDecision = (node, nesting, decisionKind, cognitiveNesting = nesting) => {
    metric.cyclomaticComplexity += 1;
    metric.cognitiveComplexity += 1 + cognitiveNesting;
    metric.maxNesting = Math.max(metric.maxNesting, nesting);
    metric.decisionPoints.push({ kind: decisionKind, line: lineOf(sourceFile, node), nesting });
  };
  const scoreIf = (node, nesting, chained = false) => {
    scoreDecision(node, nesting, chained ? "else-if" : "if", chained ? 0 : nesting);
    visit(node.expression, nesting, node);
    visit(node.thenStatement, nesting + 1, node);
    if (!node.elseStatement) return;
    if (ts.isIfStatement(node.elseStatement)) {
      scoreIf(node.elseStatement, nesting, true);
      return;
    }
    metric.cognitiveComplexity += 1;
    metric.decisionPoints.push({ kind: "else", line: lineOf(sourceFile, node.elseStatement), nesting });
    visit(node.elseStatement, nesting + 1, node);
  };
  const visit = (node, nesting, parent) => {
    if (!node) return;
    if (node !== root && isFunctionLike(node)) return;
    metric.maxNesting = Math.max(metric.maxNesting, nesting);
    if (ts.isIfStatement(node)) {
      scoreIf(node, nesting);
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      scoreDecision(node, nesting, syntaxKindName(node));
      if (ts.isForStatement(node)) {
        visit(node.initializer, nesting, node);
        visit(node.condition, nesting, node);
        visit(node.incrementor, nesting, node);
      } else {
        visit(node.initializer, nesting, node);
        visit(node.expression, nesting, node);
      }
      visit(node.statement, nesting + 1, node);
      return;
    }
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      scoreDecision(node, nesting, syntaxKindName(node));
      visit(node.expression, nesting, node);
      visit(node.statement, nesting + 1, node);
      return;
    }
    if (ts.isSwitchStatement(node)) {
      metric.cognitiveComplexity += 1 + nesting;
      metric.maxNesting = Math.max(metric.maxNesting, nesting);
      metric.decisionPoints.push({ kind: "switch", line: lineOf(sourceFile, node), nesting });
      visit(node.expression, nesting, node);
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          metric.cyclomaticComplexity += 1;
          metric.decisionPoints.push({ kind: "case", line: lineOf(sourceFile, clause), nesting: nesting + 1 });
          visit(clause.expression, nesting + 1, clause);
        }
        for (const statement of clause.statements) visit(statement, nesting + 1, clause);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      scoreDecision(node, nesting, "conditional-expression");
      visit(node.condition, nesting, node);
      visit(node.whenTrue, nesting + 1, node);
      visit(node.whenFalse, nesting + 1, node);
      return;
    }
    if (ts.isCatchClause(node)) {
      scoreDecision(node, nesting, "catch");
      visit(node.variableDeclaration, nesting, node);
      visit(node.block, nesting + 1, node);
      return;
    }
    if (isLogicalExpression(node)) {
      if (!isLogicalExpression(parent)) {
        const operators = logicalChain(node);
        const changes = operators.slice(1).filter((operator, index) => operator !== operators[index]).length;
        metric.cyclomaticComplexity += operators.length;
        metric.cognitiveComplexity += operators.length ? 1 + changes : 0;
        metric.logicalSequences.push({
          line: lineOf(sourceFile, node),
          operators,
          cognitiveIncrement: operators.length ? 1 + changes : 0,
        });
      }
    }
    if (ts.isCallExpression(node) && name !== "<module>" && node.expression && ts.isIdentifier(node.expression)
      && node.expression.text === name) {
      metric.cognitiveComplexity += 1;
      metric.recursiveCalls += 1;
    }
    ts.forEachChild(node, (child) => visit(child, nesting, node));
  };
  visit(root, 0, undefined);
  if (!callableRoot) metric.cyclomaticComplexity = Math.max(1, metric.cyclomaticComplexity);
  return metric;
}

function lineCounts(source) {
  const lines = source.split(/\r?\n/);
  let codeLines = 0;
  let commentLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) commentLines += 1;
    else codeLines += 1;
  }
  return { lines: lines.length, codeLines, commentLines, blankLines: lines.length - codeLines - commentLines };
}

function parseKind(path) {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function hasModifier(node, kind) {
  return Boolean(node?.modifiers?.some((modifier) => modifier.kind === kind));
}

function nodeName(node) {
  return node?.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
}

function stringLiteralValue(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function extractTypeScriptCodeFacts(sourceFile) {
  const exportedSymbols = [];
  const exportedFunctions = [];
  const dependencies = new Set();
  const declarations = new Map();
  const functionDeclarations = new Map();
  const functionKeys = new Set();
  const addSymbol = (name) => {
    if (typeof name === "string" && name && !exportedSymbols.includes(name)) exportedSymbols.push(name);
  };
  const addFunction = (name, node) => {
    if (typeof name !== "string" || !name || !Array.isArray(node?.parameters)) return;
    const parameterCount = node.parameters.length;
    const key = `${name}/${parameterCount}`;
    if (functionKeys.has(key)) return;
    functionKeys.add(key);
    exportedFunctions.push({ name, parameterCount });
  };
  const addDependency = (value) => {
    const moduleName = stringLiteralValue(value) ?? (typeof value === "string" ? value : undefined);
    if (moduleName) dependencies.add(moduleName);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) addDependency(statement.moduleSpecifier);
    if (ts.isExportDeclaration(statement)) addDependency(statement.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(statement)) addDependency(statement.moduleReference);

    if (ts.isFunctionDeclaration(statement)) {
      const name = nodeName(statement);
      if (name) {
        declarations.set(name, statement);
        functionDeclarations.set(name, statement);
      }
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        const exportedName = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? (name || "default") : name;
        addSymbol(exportedName);
        addFunction(exportedName, statement);
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      for (const declaration of statement.declarationList.declarations) {
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
        if (!name) continue;
        declarations.set(name, declaration);
        if (exported) {
          addSymbol(name);
          if (declaration.initializer && isFunctionLike(declaration.initializer)) {
            addFunction(name, declaration.initializer);
          }
        }
      }
      continue;
    }
    if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)
      || ts.isModuleDeclaration(statement)) {
      const name = nodeName(statement);
      if (name) declarations.set(name, statement);
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        addSymbol(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? (name || "default") : name);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) {
        if (ts.isIdentifier(statement.expression)) addSymbol(statement.expression.text);
      } else {
        addSymbol("default");
        if (isFunctionLike(statement.expression)) addFunction("default", statement.expression);
        if (ts.isIdentifier(statement.expression)) {
          const declaration = functionDeclarations.get(statement.expression.text);
          if (declaration) addFunction("default", declaration);
        }
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const exportedName = element.name.text;
      const localName = element.propertyName?.text || exportedName;
      addSymbol(exportedName);
      const declaration = functionDeclarations.get(localName);
      if (declaration) addFunction(exportedName, declaration);
      else {
        const variable = declarations.get(localName);
        if (variable?.initializer && isFunctionLike(variable.initializer)) addFunction(exportedName, variable.initializer);
      }
    }
  }

  const collectCommonJsExports = (node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "exports") {
      addSymbol(node.name.text);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)
      && node.left.expression.text === "exports") {
      addSymbol(node.left.name.text);
      if (ts.isIdentifier(node.right)) {
        const declaration = functionDeclarations.get(node.right.text);
        if (declaration) addFunction(node.left.name.text, declaration);
      }
      if (isFunctionLike(node.right)) addFunction(node.left.name.text, node.right);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)
      && node.left.expression.text === "module" && node.left.name.text === "exports") {
      if (ts.isIdentifier(node.right)) {
        addSymbol(node.right.text);
        const declaration = functionDeclarations.get(node.right.text);
        if (declaration) addFunction(node.right.text, declaration);
      }
      if (ts.isObjectLiteralExpression(node.right)) {
        for (const property of node.right.properties) {
          if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            const exportedName = property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;
            if (!exportedName) continue;
            addSymbol(exportedName);
            const localName = ts.isShorthandPropertyAssignment(property)
              ? property.name.text
              : ts.isIdentifier(property.initializer) ? property.initializer.text : undefined;
            const declaration = localName && functionDeclarations.get(localName);
            if (declaration) addFunction(exportedName, declaration);
            else if (ts.isFunctionLike(property.initializer)) addFunction(exportedName, property.initializer);
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") addDependency(node.arguments[0]);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) addDependency(node.arguments[0]);
    }
    ts.forEachChild(node, collectCommonJsExports);
  };
  collectCommonJsExports(sourceFile);

  return {
    exportedSymbols,
    exportedFunctions,
    dependencies: [...dependencies].sort(),
    purpose: null,
  };
}

export function analyzeTypeScriptSource(source, path) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, parseKind(path));
  const parseDiagnostics = sourceFile.parseDiagnostics || [];
  if (parseDiagnostics.length) {
    return {
      status: "parse-error",
      path,
      language: "javascript-typescript",
      method: "ast-v1",
      parser: `typescript-compiler-api@${ts.version}`,
      parseErrors: parseDiagnostics.length,
      error: "Source contains syntax errors; complexity metrics are unavailable.",
      codeFacts: {
        exportedSymbols: [],
        exportedFunctions: [],
        dependencies: [],
        purpose: null,
      },
      ...lineCounts(source),
    };
  }
  const moduleMetric = analyzeRegion(sourceFile, sourceFile, "<module>", "module");
  const functions = callableRecords(sourceFile).map(({ node, name, kind, line }) => ({
    ...analyzeRegion(node.body, sourceFile, name, kind, true),
    name,
    kind,
    line,
    endLine: endLineOf(sourceFile, node),
  }));
  const all = [moduleMetric, ...functions];
  const totalCyclomaticComplexity = all.reduce((sum, item) => sum + item.cyclomaticComplexity, 0);
  const totalCognitiveComplexity = all.reduce((sum, item) => sum + item.cognitiveComplexity, 0);
  const counts = lineCounts(source);
  const dependencyCount = (() => {
    let count = 0;
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)) count += 1;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") count += 1;
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return count;
  })();
  return {
    status: "parsed",
    path,
    language: "javascript-typescript",
    method: "ast-v1",
    parser: `typescript-compiler-api@${ts.version}`,
    ...counts,
    module: moduleMetric,
    callables: functions,
    codeFacts: extractTypeScriptCodeFacts(sourceFile),
    cyclomaticComplexity: Math.max(...all.map((item) => item.cyclomaticComplexity)),
    cognitiveComplexity: Math.max(...all.map((item) => item.cognitiveComplexity)),
    totalCyclomaticComplexity,
    totalCognitiveComplexity,
    dependencyCount,
    uncertainty: "AST-derived for JavaScript/TypeScript syntax; metric semantics follow the documented code-phage rules and are not a universal quality gate.",
  };
}

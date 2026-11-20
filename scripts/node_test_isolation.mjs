import ts from 'typescript';
import {realpathSync,lstatSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute,extname} from 'node:path';

const globals=new Set(['undefined','NaN','Infinity','Math','JSON','String','Number','Boolean','BigInt']);
const assertMethods=new Set(['equal','notEqual','strictEqual','notStrictEqual','deepEqual','notDeepEqual','deepStrictEqual','notDeepStrictEqual','ok','fail','throws','doesNotThrow','rejects','doesNotReject','ifError','match','doesNotMatch','partialDeepStrictEqual']);
const members={
  Math:new Set(['E','LN10','LN2','LOG10E','LOG2E','PI','SQRT1_2','SQRT2','abs','acos','acosh','asin','asinh','atan','atanh','atan2','ceil','cbrt','expm1','clz32','cos','cosh','exp','floor','fround','hypot','imul','log','log1p','log2','log10','max','min','pow','round','sign','sin','sinh','sqrt','tan','tanh','trunc']),
  JSON:new Set(['parse','stringify','rawJSON','isRawJSON']),
  Number:new Set(['EPSILON','MAX_SAFE_INTEGER','MIN_SAFE_INTEGER','MAX_VALUE','MIN_VALUE','NaN','NEGATIVE_INFINITY','POSITIVE_INFINITY','isFinite','isInteger','isNaN','isSafeInteger','parseFloat','parseInt']),
  String:new Set(['raw','fromCharCode','fromCodePoint']), BigInt:new Set(['asIntN','asUintN']),
};
const forbidden=new Set(['process','global','globalThis','eval','Function','require','console','Date','fetch','WebSocket','Worker','Bun','Deno','setTimeout','setInterval','setImmediate','clearTimeout','clearInterval','clearImmediate','queueMicrotask','constructor','prototype','__proto__']);
const testImports=new Set(['test','it','describe','suite']);
const options={allowJs:true,noLib:true,noResolve:true,noEmit:true,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext};
const no=reason=>({safe:false,reason});

// This deliberately recognizes a small pure subset, not arbitrary JavaScript.
export function classifyTestFile(file,root,cache=new Map(),visiting=new Set(),dependency=false) {
  let path;
  try {
    if(lstatSync(file).isSymbolicLink()) return no('linked file');
    path=realpathSync(file); root=realpathSync(root);
    const rel=relative(root,path);
    if(rel.startsWith('..')||isAbsolute(rel)||!['.js','.mjs'].includes(extname(path))) return no('outside pure JS scope');
  } catch { return no('unreadable input'); }
  const key=path+':'+dependency;
  if(cache.has(key)) return cache.get(key);
  if(visiting.has(path)) return no('cyclic module graph');
  visiting.add(path);
  let result;
  try {
    const host=ts.createCompilerHost(options);
    const program=ts.createProgram([path],options,host), sf=program.getSourceFile(path), checker=program.getTypeChecker();
    if(!sf||sf.parseDiagnostics.length) return no('unparsed syntax');
    const aliases=new Set(), assertions=new Set(); let reason=null;
    for(const statement of sf.statements) {
      if(ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement)&&statement.moduleSpecifier) {
        const name=statement.moduleSpecifier?.text;
        if(typeof name!=='string') {reason='nonliteral import';break;}
        if(name==='node:test') {
          if(dependency||!ts.isImportDeclaration(statement)) {reason='test registration in dependency';break;}
          const clause=statement.importClause;
          if(clause?.name) aliases.add(clause.name.text);
          if(clause?.namedBindings) {
            if(!ts.isNamedImports(clause.namedBindings)) {reason='test namespace';break;}
            for(const item of clause.namedBindings.elements) {
              if(!testImports.has((item.propertyName??item.name).text)) reason='test hook or state API';
              aliases.add(item.name.text);
            }
          }
        } else if(name==='node:assert'||name==='node:assert/strict') {
          if(!ts.isImportDeclaration(statement)) {reason='native re-export';break;}
          const clause=statement.importClause;
          if(clause?.name) assertions.add(checker.getSymbolAtLocation(clause.name));
          if(clause?.namedBindings) {
            if(!ts.isNamedImports(clause.namedBindings)) {reason='assert namespace';break;}
            for(const item of clause.namedBindings.elements) {
              const imported=(item.propertyName??item.name).text;
              if(imported==='strict') assertions.add(checker.getSymbolAtLocation(item.name));
              else if(!assertMethods.has(imported)) reason='unknown assertion API';
            }
          }
        } else if(name.startsWith('.')) {
          const imported=classifyTestFile(resolve(dirname(path),name),root,cache,visiting,true);
          if(!imported.safe) {reason='dependency: '+imported.reason;break;}
        } else {reason='unknown or effectful import';break;}
      } else if(ts.isVariableStatement(statement)) {
        if(!(statement.declarationList.flags&ts.NodeFlags.Const)) {reason='module mutable binding';break;}
        for(const declaration of statement.declarationList.declarations) {
          const init=declaration.initializer;
          const scalar=init&&(ts.isStringLiteral(init)||ts.isNumericLiteral(init)||ts.isBigIntLiteral(init)||[ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword,ts.SyntaxKind.NullKeyword].includes(init.kind)||ts.isArrowFunction(init)||ts.isFunctionExpression(init));
          if(dependency&&!scalar) reason='shared module object or initialization';
        }
      } else if(ts.isExpressionStatement(statement)) {
        if(dependency||!ts.isCallExpression(statement.expression)||!ts.isIdentifier(statement.expression.expression)||!aliases.has(statement.expression.expression.text)) reason='module effect or registration hook';
      } else if(!ts.isFunctionDeclaration(statement)&&!ts.isExportDeclaration(statement)&&!ts.isEmptyStatement(statement)) reason='unrecognized module statement';
      if(reason) break;
    }
    const visit=node=>{
      if(reason) return;
      if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) return;
      if(ts.isClassDeclaration(node)||ts.isClassExpression(node)||ts.isElementAccessExpression(node)||ts.isTaggedTemplateExpression(node)||node.kind===ts.SyntaxKind.ThisKeyword||node.kind===ts.SyntaxKind.ImportKeyword) {reason='dynamic or implicit state';return;}
      if((ts.isIdentifier(node)||ts.isStringLiteral(node))&&forbidden.has(node.text)) {reason='process/global/evaluation reference';return;}
      if(ts.isPropertyAccessExpression(node)) {
        const base=node.expression, symbol=ts.isIdentifier(base)?checker.getSymbolAtLocation(base):null;
        const allowed=ts.isIdentifier(base)&&((symbol&&assertions.has(symbol)&&assertMethods.has(node.name.text))||(!symbol&&members[base.text]?.has(node.name.text)));
        if(!allowed) {reason='unknown property or native API';return;}
      }
      if(ts.isCallExpression(node)) {
        const callee=node.expression;
        if(!ts.isIdentifier(callee)&&!ts.isPropertyAccessExpression(callee)) {reason='indirect call';return;}
      }
      if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&(!ts.isIdentifier(node.left)||!checker.getSymbolAtLocation(node.left))) {reason='nonlocal write';return;}
      if(ts.isDeleteExpression(node)||(ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node))&&[ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(node.operator)&&(!ts.isIdentifier(node.operand)||!checker.getSymbolAtLocation(node.operand))) {reason='nonlocal mutation';return;}
      if(ts.isIdentifier(node)) {
        const p=node.parent;
        const property=(ts.isPropertyAccessExpression(p)&&p.name===node)||(ts.isPropertyAssignment(p)&&p.name===node&&!ts.isShorthandPropertyAssignment(p))||(ts.isMethodDeclaration(p)&&p.name===node);
        if(!property&&!globals.has(node.text)&&!checker.getSymbolAtLocation(node)) {reason='unknown global '+node.text;return;}
      }
      ts.forEachChild(node,visit);
    };
    if(!reason) visit(sf);
    result=reason?no(reason):{safe:true,reason:'closed pure module graph'};
  } catch {result=no('analysis unavailable');}
  finally {visiting.delete(path);}
  cache.set(key,result);
  return result;
}

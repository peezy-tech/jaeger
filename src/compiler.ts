import { createContext, Script, type Context } from "node:vm";
import ts from "@typescript/typescript6";
import { WorkflowCompileError } from "./errors.js";
import type { WorkflowContext } from "./types.js";

type AsyncFunction = (context: WorkflowContext) => Promise<unknown>;

type BridgeResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errorId: string; readonly message: string };

interface WorkflowBridge {
  readonly agent: (prompt: unknown, options: unknown) => Promise<BridgeResult>;
  readonly parallel: (tasks: ReadonlyArray<() => unknown>) => Promise<BridgeResult>;
  readonly phase: (name: unknown) => BridgeResult;
  readonly log: (message: unknown) => BridgeResult;
  readonly setMeta: (meta: unknown) => BridgeResult;
}

type RealmWorkflow = (
  bridge: WorkflowBridge,
  serializedInputs: string | undefined,
  serializedTrigger: string | undefined,
) => Promise<unknown>;

const INTERNAL_PREFIX = "__jaegerInternal";
const HOST_ERROR_ID = `${INTERNAL_PREFIX}HostErrorId`;

const JAEGER_GLOBALS = new Map<string, string>([
  ["agent", `${INTERNAL_PREFIX}Agent`],
  ["parallel", `${INTERNAL_PREFIX}Parallel`],
  ["phase", `${INTERNAL_PREFIX}Phase`],
  ["log", `${INTERNAL_PREFIX}Log`],
  ["inputs", `${INTERNAL_PREFIX}Inputs`],
  ["trigger", `${INTERNAL_PREFIX}Trigger`],
]);

// These are the deterministic ECMAScript intrinsics intentionally available to
// coordinator code. Host APIs and environment-sensitive convenience globals are
// omitted. Member-level checks below further constrain Math and Promise.
const SAFE_GLOBALS = new Set([
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Error",
  "EvalError",
  "Float32Array",
  "Float64Array",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "RangeError",
  "ReferenceError",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "undefined",
]);

const FORBIDDEN_AMBIENT_GLOBALS = new Map<string, string>([
  ["globalThis", "ambient/global access"],
  ["global", "ambient/global access"],
  ["window", "ambient/global access"],
  ["self", "ambient/global access"],
  ["process", "environment access"],
  ["Deno", "environment access"],
  ["Bun", "environment access"],
  ["require", "module and filesystem access"],
  ["module", "module access"],
  ["exports", "module access"],
  ["__filename", "environment access"],
  ["__dirname", "environment access"],
  ["Date", "clock access"],
  ["Temporal", "clock access"],
  ["performance", "clock access"],
  ["Intl", "locale and environment access"],
  ["crypto", "randomness and host capability access"],
  ["fetch", "network access"],
  ["XMLHttpRequest", "network access"],
  ["WebSocket", "network access"],
  ["EventSource", "network access"],
  ["Request", "network access"],
  ["Response", "network access"],
  ["Headers", "network access"],
  ["setTimeout", "timer access"],
  ["clearTimeout", "timer access"],
  ["setInterval", "timer access"],
  ["clearInterval", "timer access"],
  ["setImmediate", "timer access"],
  ["clearImmediate", "timer access"],
  ["queueMicrotask", "ambient scheduling access"],
  ["scheduler", "ambient scheduling access"],
  ["console", "ambient console access; use Jaeger's log() primitive"],
  ["WeakRef", "garbage-collection-dependent access"],
  ["FinalizationRegistry", "garbage-collection-dependent access"],
  ["Atomics", "shared-memory scheduling access"],
  ["SharedArrayBuffer", "shared-memory access"],
  ["WebAssembly", "dynamic code execution"],
  ["Proxy", "dynamic property interception"],
  ["Reflect", "dynamic reflective property access"],
  ["eval", "dynamic code execution"],
  ["Function", "dynamic code execution"],
]);

const FORBIDDEN_PROMISE_CONTINUATION_METHODS = new Set(["then", "catch", "finally"]);
const FORBIDDEN_LOCALE_METHODS = new Set([
  "localeCompare",
  "toLocaleLowerCase",
  "toLocaleString",
  "toLocaleUpperCase",
]);
const FORBIDDEN_REFLECTION_MEMBERS = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "defineProperties",
  "defineProperty",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "getPrototypeOf",
  "setPrototypeOf",
]);
const MUTATING_METHODS = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
]);
const MUTATING_STATIC_METHODS = new Map<string, ReadonlySet<string>>([
  ["Object", new Set(["assign", "defineProperties", "defineProperty", "setPrototypeOf"])],
  ["Reflect", new Set(["defineProperty", "deleteProperty", "set", "setPrototypeOf"])],
]);
const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

type FunctionWithBody =
  | ts.ArrowFunction
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.MethodDeclaration
  | ts.SetAccessorDeclaration;

export interface CompiledWorkflow {
  readonly run: AsyncFunction;
}

/**
 * Compile a trusted workflow with replay-determinism guardrails.
 *
 * The AST validator and capability-limited vm realm deliberately reduce the
 * coordinator's ambient surface. Node's vm module is not a security boundary;
 * whole-workflow isolation remains the responsibility of the outer runtime.
 */
export function compileWorkflowSource(source: string, filename: string): CompiledWorkflow {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.ESNext,
    true,
    filename.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (parseDiagnostics && parseDiagnostics.length > 0) {
    throw new WorkflowCompileError(
      parseDiagnostics.map((diagnostic) => formatDiagnostic(diagnostic, filename)).join("\n"),
    );
  }

  const checker = createChecker(sourceFile, filename);
  validateCoordinator(sourceFile, checker, filename);
  const statements = prepareStatements(sourceFile, filename);
  const preparedSourceFile = ts.factory.updateSourceFile(sourceFile, statements);
  const transformation = transformJaegerGlobals(preparedSourceFile, checker);
  const transformed = transformation.sourceFile;

  let body: string;
  try {
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    body = transformed.statements
      .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, transformed))
      .join("\n");
  } finally {
    transformation.dispose();
  }

  const wrapped = `
(async (
  ${INTERNAL_PREFIX}Bridge,
  ${INTERNAL_PREFIX}SerializedInputs,
  ${INTERNAL_PREFIX}SerializedTrigger
) => {
  "use strict";
  const ${INTERNAL_PREFIX}CloneIntoRealm = (${INTERNAL_PREFIX}Value) => {
    if (${INTERNAL_PREFIX}Value === undefined) return undefined;
    const ${INTERNAL_PREFIX}Encoded = JSON.stringify(${INTERNAL_PREFIX}Value);
    if (${INTERNAL_PREFIX}Encoded === undefined) {
      throw new TypeError("values crossing the Jaeger boundary must be JSON-serializable");
    }
    return JSON.parse(${INTERNAL_PREFIX}Encoded);
  };
  const ${INTERNAL_PREFIX}Unwrap = (${INTERNAL_PREFIX}Result, ${INTERNAL_PREFIX}Clone) => {
    if (!${INTERNAL_PREFIX}Result.ok) {
      const ${INTERNAL_PREFIX}Error = new Error(${INTERNAL_PREFIX}Result.message);
      Object.defineProperty(${INTERNAL_PREFIX}Error, ${JSON.stringify(HOST_ERROR_ID)}, {
        value: ${INTERNAL_PREFIX}Result.errorId,
      });
      throw ${INTERNAL_PREFIX}Error;
    }
    return ${INTERNAL_PREFIX}Clone
      ? ${INTERNAL_PREFIX}CloneIntoRealm(${INTERNAL_PREFIX}Result.value)
      : ${INTERNAL_PREFIX}Result.value;
  };
  const ${INTERNAL_PREFIX}Observe = (${INTERNAL_PREFIX}Promise) => {
    ${INTERNAL_PREFIX}Promise.catch(() => undefined);
    return ${INTERNAL_PREFIX}Promise;
  };
  let ${INTERNAL_PREFIX}IssuedAgent = 0;
  let ${INTERNAL_PREFIX}DeliveredAgent = 0;
  const ${INTERNAL_PREFIX}CompletedAgents = new Map();
  const ${INTERNAL_PREFIX}DeliverAgents = () => {
    while (${INTERNAL_PREFIX}CompletedAgents.has(${INTERNAL_PREFIX}DeliveredAgent)) {
      const ${INTERNAL_PREFIX}Completion = ${INTERNAL_PREFIX}CompletedAgents.get(
        ${INTERNAL_PREFIX}DeliveredAgent,
      );
      ${INTERNAL_PREFIX}CompletedAgents.delete(${INTERNAL_PREFIX}DeliveredAgent);
      ${INTERNAL_PREFIX}DeliveredAgent += 1;
      if (${INTERNAL_PREFIX}Completion.ok) {
        ${INTERNAL_PREFIX}Completion.resolve(${INTERNAL_PREFIX}Completion.value);
      } else {
        ${INTERNAL_PREFIX}Completion.reject(${INTERNAL_PREFIX}Completion.error);
      }
    }
  };
  const ${INTERNAL_PREFIX}OrderedAgent = (...${INTERNAL_PREFIX}Args) => {
    const ${INTERNAL_PREFIX}Ticket = ${INTERNAL_PREFIX}IssuedAgent++;
    return new Promise((${INTERNAL_PREFIX}Resolve, ${INTERNAL_PREFIX}Reject) => {
      ${INTERNAL_PREFIX}Bridge.agent(...${INTERNAL_PREFIX}Args).then(
        (${INTERNAL_PREFIX}Value) => {
          ${INTERNAL_PREFIX}CompletedAgents.set(${INTERNAL_PREFIX}Ticket, {
            ok: true,
            value: ${INTERNAL_PREFIX}Value,
            resolve: ${INTERNAL_PREFIX}Resolve,
            reject: ${INTERNAL_PREFIX}Reject,
          });
          ${INTERNAL_PREFIX}DeliverAgents();
        },
        (${INTERNAL_PREFIX}Error) => {
          ${INTERNAL_PREFIX}CompletedAgents.set(${INTERNAL_PREFIX}Ticket, {
            ok: false,
            error: ${INTERNAL_PREFIX}Error,
            resolve: ${INTERNAL_PREFIX}Resolve,
            reject: ${INTERNAL_PREFIX}Reject,
          });
          ${INTERNAL_PREFIX}DeliverAgents();
        },
      );
    });
  };
  const ${INTERNAL_PREFIX}Agent = (...${INTERNAL_PREFIX}Args) =>
    ${INTERNAL_PREFIX}Observe((async () =>
      ${INTERNAL_PREFIX}Unwrap(
        await ${INTERNAL_PREFIX}OrderedAgent(...${INTERNAL_PREFIX}Args),
        true,
      ))());
  const ${INTERNAL_PREFIX}Parallel = (${INTERNAL_PREFIX}Tasks) =>
    ${INTERNAL_PREFIX}Observe((async () =>
      ${INTERNAL_PREFIX}Unwrap(
        await ${INTERNAL_PREFIX}Bridge.parallel(${INTERNAL_PREFIX}Tasks),
        true,
      ))());
  const ${INTERNAL_PREFIX}Phase = (...${INTERNAL_PREFIX}Args) =>
    ${INTERNAL_PREFIX}Unwrap(${INTERNAL_PREFIX}Bridge.phase(...${INTERNAL_PREFIX}Args), false);
  const ${INTERNAL_PREFIX}Log = (...${INTERNAL_PREFIX}Args) =>
    ${INTERNAL_PREFIX}Unwrap(${INTERNAL_PREFIX}Bridge.log(...${INTERNAL_PREFIX}Args), false);
  const ${INTERNAL_PREFIX}SetMeta = (${INTERNAL_PREFIX}Meta) =>
    ${INTERNAL_PREFIX}Unwrap(${INTERNAL_PREFIX}Bridge.setMeta(${INTERNAL_PREFIX}Meta), false);
  const ${INTERNAL_PREFIX}Inputs = ${INTERNAL_PREFIX}SerializedInputs === undefined
    ? undefined
    : JSON.parse(${INTERNAL_PREFIX}SerializedInputs);
  const ${INTERNAL_PREFIX}Trigger = ${INTERNAL_PREFIX}SerializedTrigger === undefined
    ? undefined
    : JSON.parse(${INTERNAL_PREFIX}SerializedTrigger);
${body}
})
`;
  const transpiled = ts.transpileModule(wrapped, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      strict: true,
    },
  });
  const diagnostics = transpiled.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostics && diagnostics.length > 0) {
    throw new WorkflowCompileError(
      diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, filename)).join("\n"),
    );
  }

  let realmWorkflow: RealmWorkflow;
  try {
    const realm = createWorkflowRealm(filename);
    const candidate = new Script(transpiled.outputText, { filename }).runInContext(realm) as unknown;
    if (typeof candidate !== "function") throw new TypeError("compiled workflow was not callable");
    realmWorkflow = candidate as RealmWorkflow;
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new WorkflowCompileError(
      `${filename}: failed to initialize the capability-limited coordinator realm${detail}`,
      { cause: error },
    );
  }

  return {
    run: async (context) => {
      const serializedInputs = serializeInputs(context.inputs);
      const serializedTrigger = serializeInputs(context.trigger);
      const hostErrors = new Map<string, unknown>();
      const bridge = createBridge(context, hostErrors);
      try {
        return cloneFromRealm(
          await realmWorkflow(bridge, serializedInputs, serializedTrigger),
          "workflow result",
        );
      } catch (error) {
        const errorId = readHostErrorId(error);
        if (errorId !== undefined && hostErrors.has(errorId)) throw hostErrors.get(errorId);
        throw error;
      }
    },
  };
}

function prepareStatements(sourceFile: ts.SourceFile, filename: string): ts.Statement[] {
  const statements: ts.Statement[] = [];
  let foundMeta = false;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)) {
      compileFailure(
        sourceFile,
        statement,
        filename,
        "workflow imports are not supported; move external effects into agent() and keep deterministic helpers in this file",
      );
    }
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      compileFailure(sourceFile, statement, filename, "only `export const meta = ...` is supported");
    }
    if (ts.isVariableStatement(statement) && declaresName(statement, "meta")) {
      if (!hasExportModifier(statement)) {
        compileFailure(sourceFile, statement, filename, "meta must be declared as `export const meta`");
      }
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
        compileFailure(sourceFile, statement, filename, "meta must be declared with `const`");
      }
      const declaration = statement.declarationList.declarations[0];
      if (
        statement.declarationList.declarations.length !== 1 ||
        declaration === undefined ||
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== "meta"
      ) {
        compileFailure(
          sourceFile,
          statement,
          filename,
          "the metadata export may declare only `meta`",
        );
      }
      if (foundMeta) {
        compileFailure(sourceFile, statement, filename, "meta may only be declared once");
      }
      foundMeta = true;
      statements.push(
        ts.factory.updateVariableStatement(
          statement,
          statement.modifiers?.filter((modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword),
          statement.declarationList,
        ),
      );
      statements.push(
        ts.factory.createExpressionStatement(
          ts.factory.createCallExpression(
            ts.factory.createIdentifier(`${INTERNAL_PREFIX}SetMeta`),
            undefined,
            [ts.factory.createIdentifier("meta")],
          ),
        ),
      );
      continue;
    }
    if (hasExportModifier(statement)) {
      compileFailure(sourceFile, statement, filename, "only `export const meta = ...` may be exported");
    }
    statements.push(statement);
  }

  if (!foundMeta) {
    compileFailure(sourceFile, sourceFile, filename, "missing `export const meta = ...`");
  }
  return statements;
}

function validateCoordinator(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filename: string,
): void {
  const replayScheduledFunctions = collectReplayScheduledFunctions(sourceFile, checker);
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isTypeParameterDeclaration(node)
    ) {
      return;
    }

    if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      compileFailure(
        sourceFile,
        node,
        filename,
        "ambient declarations are not available in coordinator workflows",
      );
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      compileFailure(
        sourceFile,
        node.expression,
        filename,
        "dynamic import is not allowed in coordinator code",
      );
    }

    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      compileFailure(
        sourceFile,
        node,
        filename,
        "import.meta is environment-dependent module access and is not available in coordinator code",
      );
    }

    if (ts.isWithStatement(node)) {
      compileFailure(
        sourceFile,
        node,
        filename,
        "with statements are not allowed because coordinator name resolution must be statically verifiable",
      );
    }

    if (node.kind === ts.SyntaxKind.ThisKeyword && !hasLexicalThis(node)) {
      compileFailure(
        sourceFile,
        node,
        filename,
        "top-level `this` is ambient global access; use local values or Jaeger globals",
      );
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      validateMemberAccess(node, sourceFile, checker, filename);
    }

    validateReplayScheduledMutation(
      node,
      replayScheduledFunctions,
      sourceFile,
      checker,
      filename,
    );

    if (ts.isBindingElement(node)) {
      const propertyNode = node.propertyName ?? node.name;
      const computedProperty =
        node.propertyName !== undefined && ts.isComputedPropertyName(node.propertyName);
      const propertyName = computedProperty
        ? staticComputedPropertyName(node.propertyName.expression)
        : staticPropertyName(propertyNode);
      validateExtractedPropertyName(
        propertyName,
        propertyNode,
        computedProperty,
        sourceFile,
        filename,
      );
    }

    if (
      ts.isIdentifier(node) &&
      node.text.startsWith(INTERNAL_PREFIX) &&
      (isValueReferenceIdentifier(node) || isBindingIdentifier(node))
    ) {
      compileFailure(
        sourceFile,
        node,
        filename,
        `identifiers beginning with ${JSON.stringify(INTERNAL_PREFIX)} are reserved by Jaeger`,
      );
    }

    if (ts.isIdentifier(node) && isValueReferenceIdentifier(node)) {
      if (node.text === "arguments" && hasArgumentsBinding(node)) return;
      if (isAmbientIdentifier(node, checker, sourceFile)) {
        if (node.text === "eval" || node.text === "Function") {
          compileFailure(
            sourceFile,
            node,
            filename,
            `${node.text} is not allowed; coordinator code cannot compile or evaluate strings`,
          );
        }
        if (JAEGER_GLOBALS.has(node.text)) return;
        if (SAFE_GLOBALS.has(node.text)) {
          validateProtectedGlobalUse(node, sourceFile, filename);
          return;
        }
        const forbiddenReason = FORBIDDEN_AMBIENT_GLOBALS.get(node.text);
        if (forbiddenReason) {
          compileFailure(
            sourceFile,
            node,
            filename,
            `${node.text} is not available in coordinator code (${forbiddenReason}); move external effects into agent()`,
          );
        }
        compileFailure(
          sourceFile,
          node,
          filename,
          `${JSON.stringify(node.text)} is an ambient or unknown global; coordinator code may use only local bindings, deterministic JavaScript built-ins, and Jaeger globals (agent, parallel, phase, log, inputs)`,
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function validateMemberAccess(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filename: string,
): void {
  const propertyNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
  const propertyName = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : staticComputedPropertyName(propertyNode);

  if (
    ts.isElementAccessExpression(node) &&
    propertyName === undefined &&
    !isProvablyNumericIndex(node.argumentExpression, checker)
  ) {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      "dynamic string property access is not allowed because it can synthesize replay-unsafe constructor, Promise, locale, or reflection members",
    );
  }

  if (propertyName === "constructor") {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      "access to `constructor` is not allowed; dynamic constructors can escape replay guardrails",
    );
  }
  if (propertyName !== undefined && FORBIDDEN_PROMISE_CONTINUATION_METHODS.has(propertyName)) {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      `.${propertyName}() continuation scheduling is not allowed; use await and parallel() so agent result delivery remains replay-deterministic`,
    );
  }
  if (propertyName !== undefined && FORBIDDEN_LOCALE_METHODS.has(propertyName)) {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      `.${propertyName}() is locale-dependent and is not available in replay-deterministic coordinator code`,
    );
  }
  if (propertyName !== undefined && FORBIDDEN_REFLECTION_MEMBERS.has(propertyName)) {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      `.${propertyName}() exposes reflective properties that can bypass coordinator replay guardrails`,
    );
  }

  if (isUnboundNamedIdentifier(node.expression, "Math", checker, sourceFile)) {
    if (propertyName === undefined) {
      compileFailure(
        sourceFile,
        propertyNode,
        filename,
        "computed Math access is not allowed because it could select Math.random",
      );
    }
    if (propertyName === "random") {
      compileFailure(
        sourceFile,
        propertyNode,
        filename,
        "Math.random is not allowed in replay-deterministic coordinator code",
      );
    }
  }

  if (isUnboundNamedIdentifier(node.expression, "Promise", checker, sourceFile)) {
    if (propertyName === undefined) {
      compileFailure(
        sourceFile,
        propertyNode,
        filename,
        "computed Promise access is not allowed because it could select Promise.race or Promise.any",
      );
    }
    if (propertyName === "race" || propertyName === "any") {
      compileFailure(
        sourceFile,
        propertyNode,
        filename,
        `Promise.${propertyName} is not allowed because winner timing is not replay-deterministic`,
      );
    }
  }

  const root = unwrapExpression(node.expression);
  if (
    ts.isIdentifier(root) &&
    JAEGER_GLOBALS.has(root.text) &&
    isAmbientIdentifier(root, checker, sourceFile) &&
    ts.isElementAccessExpression(node) &&
    propertyName === undefined
  ) {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      `computed access on the Jaeger ${root.text} capability is not allowed`,
    );
  }
}

function validateExtractedPropertyName(
  propertyName: string | undefined,
  propertyNode: ts.Node,
  computedProperty: boolean,
  sourceFile: ts.SourceFile,
  filename: string,
): void {
  if (computedProperty && propertyName === undefined) {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      "dynamic computed destructuring is not allowed because it can extract replay-unsafe constructor, Promise, locale, or reflection members",
    );
  }
  if (propertyName === "constructor") {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      "extracting `constructor` is not allowed; dynamic constructor access can escape replay guardrails",
    );
  }
  if (propertyName !== undefined && FORBIDDEN_PROMISE_CONTINUATION_METHODS.has(propertyName)) {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      `extracting ${JSON.stringify(propertyName)} is not allowed because Promise continuation scheduling is not replay-deterministic`,
    );
  }
  if (propertyName !== undefined && FORBIDDEN_LOCALE_METHODS.has(propertyName)) {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      `extracting ${JSON.stringify(propertyName)} is not allowed because locale-sensitive operations are not replay-deterministic`,
    );
  }
  if (propertyName !== undefined && FORBIDDEN_REFLECTION_MEMBERS.has(propertyName)) {
    compileFailure(
      sourceFile,
      propertyNode,
      filename,
      `extracting ${JSON.stringify(propertyName)} is not allowed because reflective property access can bypass replay guardrails`,
    );
  }
}

function collectReplayScheduledFunctions(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ReadonlySet<FunctionWithBody> {
  const scheduled = new Set<FunctionWithBody>();
  const worklist: FunctionWithBody[] = [];
  const enqueue = (candidate: FunctionWithBody): void => {
    if (scheduled.has(candidate)) return;
    scheduled.add(candidate);
    worklist.push(candidate);
  };
  const resolve = (expression: ts.Expression): void => {
    for (const candidate of resolveFunctionValues(expression, checker)) enqueue(candidate);
  };

  const seed = (node: ts.Node): void => {
    if (
      isFunctionWithBody(node) &&
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      enqueue(node);
    }
    if (
      ts.isCallExpression(node) &&
      isUnboundNamedIdentifier(node.expression, "parallel", checker, sourceFile)
    ) {
      const tasks = node.arguments[0];
      if (tasks) resolve(tasks);
    }
    ts.forEachChild(node, seed);
  };
  seed(sourceFile);

  for (let index = 0; index < worklist.length; index++) {
    const current = worklist[index]!;
    const visit = (node: ts.Node): void => {
      if (node !== current && isFunctionWithBody(node)) return;
      if (ts.isCallExpression(node)) {
        resolve(node.expression);
        for (const argument of node.arguments) resolve(argument);
      }
      ts.forEachChild(node, visit);
    };
    visit(current.body!);
  }

  return scheduled;
}

function resolveFunctionValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ReadonlySet<FunctionWithBody> {
  const found = new Set<FunctionWithBody>();
  const visitedNodes = new Set<ts.Node>();
  const visitedSymbols = new Set<ts.Symbol>();

  const resolveNode = (candidate: ts.Node | undefined): void => {
    if (!candidate || visitedNodes.has(candidate)) return;
    visitedNodes.add(candidate);

    if (isFunctionWithBody(candidate)) {
      found.add(candidate);
      return;
    }
    if (ts.isSpreadElement(candidate)) {
      resolveNode(candidate.expression);
      return;
    }
    if (ts.isArrayLiteralExpression(candidate)) {
      for (const element of candidate.elements) resolveNode(element);
      return;
    }
    if (ts.isConditionalExpression(candidate)) {
      resolveNode(candidate.whenTrue);
      resolveNode(candidate.whenFalse);
      return;
    }
    if (
      ts.isParenthesizedExpression(candidate) ||
      ts.isAsExpression(candidate) ||
      ts.isTypeAssertionExpression(candidate) ||
      ts.isNonNullExpression(candidate) ||
      ts.isSatisfiesExpression(candidate)
    ) {
      resolveNode(candidate.expression);
      return;
    }
    if (ts.isVariableDeclaration(candidate) || ts.isBindingElement(candidate)) {
      resolveNode(candidate.initializer);
      return;
    }
    if (ts.isPropertyAssignment(candidate)) {
      resolveNode(candidate.initializer);
      return;
    }

    if (
      ts.isIdentifier(candidate) ||
      ts.isPropertyAccessExpression(candidate) ||
      ts.isElementAccessExpression(candidate)
    ) {
      const symbol = checker.getSymbolAtLocation(candidate);
      if (!symbol || visitedSymbols.has(symbol)) return;
      visitedSymbols.add(symbol);
      for (const declaration of symbol.declarations ?? []) resolveNode(declaration);
    }
  };

  resolveNode(expression);
  return found;
}

function validateReplayScheduledMutation(
  node: ts.Node,
  scheduled: ReadonlySet<FunctionWithBody>,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filename: string,
): void {
  const owner = nearestFunctionWithBody(node);
  if (!owner || !scheduled.has(owner)) return;

  let mutationTarget: ts.Expression | undefined;
  if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
    mutationTarget = node.left;
  } else if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    mutationTarget = node.operand;
  } else if (ts.isDeleteExpression(node)) {
    mutationTarget = node.expression;
  } else if (
    (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    !ts.isVariableDeclarationList(node.initializer)
  ) {
    mutationTarget = node.initializer;
  } else if (ts.isCallExpression(node)) {
    mutationTarget = mutationTargetForCall(node, sourceFile, checker);
  }

  if (!mutationTarget || !isSharedMutationTarget(mutationTarget, owner, sourceFile, checker)) return;
  compileFailure(
    sourceFile,
    mutationTarget,
    filename,
    "async and parallel callbacks may not mutate captured or externally owned state; return values from parallel() and combine them deterministically after await",
  );
}

function mutationTargetForCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
    return undefined;
  }
  const property = ts.isPropertyAccessExpression(callee) ? callee.name : callee.argumentExpression;
  const propertyName = staticPropertyName(property);
  if (propertyName === undefined) return undefined;

  for (const [globalName, methods] of MUTATING_STATIC_METHODS) {
    if (
      methods.has(propertyName) &&
      isUnboundNamedIdentifier(callee.expression, globalName, checker, sourceFile)
    ) {
      return call.arguments[0];
    }
  }
  return MUTATING_METHODS.has(propertyName) ? callee.expression : undefined;
}

function isSharedMutationTarget(
  target: ts.Expression,
  owner: FunctionWithBody,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  const roots = mutationRoots(target);
  if (roots.length === 0) return true;
  return roots.some((root) => {
    if (root.kind === ts.SyntaxKind.ThisKeyword || root.kind === ts.SyntaxKind.SuperKeyword) {
      return true;
    }
    if (!ts.isIdentifier(root)) return true;
    const symbol = checker.getSymbolAtLocation(root);
    if (!symbol || !symbol.declarations || symbol.declarations.length === 0) return true;
    return symbol.declarations.some(
      (declaration) =>
        declaration.getSourceFile() !== sourceFile ||
        !isNodeWithin(declaration, owner) ||
        isFunctionParameterDeclaration(declaration, owner),
    );
  });
}

function mutationRoots(target: ts.Expression): ts.Node[] {
  const expression = unwrapExpression(target);
  if (
    ts.isIdentifier(expression) ||
    expression.kind === ts.SyntaxKind.ThisKeyword ||
    expression.kind === ts.SyntaxKind.SuperKeyword
  ) {
    return [expression];
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return mutationRoots(expression.expression);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap((element) =>
      ts.isOmittedExpression(element)
        ? []
        : mutationRoots(ts.isSpreadElement(element) ? element.expression : element),
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name];
      if (ts.isPropertyAssignment(property)) return mutationRoots(property.initializer);
      if (ts.isSpreadAssignment(property)) return mutationRoots(property.expression);
      return [];
    });
  }
  return [];
}

function nearestFunctionWithBody(node: ts.Node): FunctionWithBody | undefined {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (isFunctionWithBody(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function isFunctionWithBody(node: ts.Node): node is FunctionWithBody {
  return (
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) && node.body !== undefined;
}

function isNodeWithin(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function isFunctionParameterDeclaration(node: ts.Node, owner: FunctionWithBody): boolean {
  let current: ts.Node | undefined = node;
  while (current && current !== owner) {
    if (ts.isParameter(current)) return true;
    current = current.parent;
  }
  return false;
}

function validateProtectedGlobalUse(
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
  filename: string,
): void {
  if (
    identifier.text !== "Math" &&
    identifier.text !== "Promise" &&
    identifier.text !== "Object"
  ) {
    return;
  }
  const expression = outerExpression(identifier);
  const parent = expression.parent;

  if (
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === expression
  ) {
    return;
  }
  if (
    identifier.text === "Promise" &&
    ((ts.isNewExpression(parent) && parent.expression === expression) ||
      (ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        parent.right === expression))
  ) {
    return;
  }

  compileFailure(
    sourceFile,
    identifier,
    filename,
    `${identifier.text} must be used directly; aliasing it would bypass ${
      identifier.text === "Math"
        ? "the Math.random check"
        : identifier.text === "Promise"
          ? "the Promise.race/Promise.any checks"
          : "the reflective Object member checks"
    }`,
  );
}

function transformJaegerGlobals(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): { readonly sourceFile: ts.SourceFile; readonly dispose: () => void } {
  const transformation = ts.transform(sourceFile, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        if (
          ts.isShorthandPropertyAssignment(node) &&
          isAmbientIdentifier(node.name, checker, sourceFile)
        ) {
          const replacement = JAEGER_GLOBALS.get(node.name.text);
          if (replacement) {
            return ts.factory.createPropertyAssignment(node.name, ts.factory.createIdentifier(replacement));
          }
        }
        if (
          ts.isIdentifier(node) &&
          isValueReferenceIdentifier(node) &&
          isAmbientIdentifier(node, checker, sourceFile)
        ) {
          const replacement = JAEGER_GLOBALS.get(node.text);
          if (replacement) return ts.factory.createIdentifier(replacement);
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitNode(node, visit) as ts.SourceFile;
    },
  ]);
  const transformed = transformation.transformed[0] as ts.SourceFile;
  return { sourceFile: transformed, dispose: () => transformation.dispose() };
}

function createChecker(sourceFile: ts.SourceFile, filename: string): ts.TypeChecker {
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === filename,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (candidate) => (candidate === filename ? sourceFile : undefined),
    readFile: (candidate) => (candidate === filename ? sourceFile.text : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  return ts.createProgram({ rootNames: [filename], options, host }).getTypeChecker();
}

function createWorkflowRealm(filename: string): Context {
  const realm = createContext(Object.create(null) as object, {
    name: `Jaeger coordinator: ${filename}`,
    codeGeneration: { strings: false, wasm: false },
  });
  const allowed = JSON.stringify([...SAFE_GLOBALS]);
  new Script(`
    (() => {
      const root = globalThis;
      const deleteProperty = Reflect.deleteProperty;
      deleteProperty(Math, "random");
      deleteProperty(Promise, "race");
      deleteProperty(Promise, "any");
      Object.freeze(Math);
      Object.freeze(Promise);
      const allowed = new Set(${allowed});
      for (const name of Object.getOwnPropertyNames(root)) {
        if (!allowed.has(name)) deleteProperty(root, name);
      }
    })();
  `).runInContext(realm);
  return realm;
}

function createBridge(
  context: WorkflowContext,
  hostErrors: Map<string, unknown>,
): WorkflowBridge {
  let nextErrorId = 0;
  const failure = (error: unknown): BridgeResult => {
    const errorId = `host-${++nextErrorId}`;
    hostErrors.set(errorId, error);
    return { ok: false, errorId, message: renderThrownValue(error) };
  };
  const success = (value: unknown): BridgeResult => ({ ok: true, value });

  return Object.freeze({
    async agent(prompt: unknown, options: unknown): Promise<BridgeResult> {
      try {
        return success(
          await context.agent(
            cloneFromRealm(prompt, "agent prompt") as string,
            cloneFromRealm(options, "agent options") as Parameters<WorkflowContext["agent"]>[1],
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
    async parallel(tasks: ReadonlyArray<() => unknown>): Promise<BridgeResult> {
      try {
        return success(
          await context.parallel(
            tasks as ReadonlyArray<() => Promise<unknown> | unknown>,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
    phase(name: unknown): BridgeResult {
      try {
        context.phase(cloneFromRealm(name, "phase name") as string);
        return success(undefined);
      } catch (error) {
        return failure(error);
      }
    },
    log(message: unknown): BridgeResult {
      try {
        context.log(cloneFromRealm(message, "log message"));
        return success(undefined);
      } catch (error) {
        return failure(error);
      }
    },
    setMeta(meta: unknown): BridgeResult {
      try {
        context.setMeta(cloneFromRealm(meta, "workflow metadata"));
        return success(undefined);
      } catch (error) {
        return failure(error);
      }
    },
  });
}

function serializeInputs(inputs: unknown): string | undefined {
  if (inputs === undefined) return undefined;
  try {
    const serialized = JSON.stringify(inputs);
    if (serialized === undefined) {
      throw new TypeError("JSON.stringify returned undefined");
    }
    return serialized;
  } catch (error) {
    throw new TypeError("workflow inputs must be JSON-serializable", { cause: error });
  }
}

function cloneFromRealm(value: unknown, label: string): unknown {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`${label} must be structured-cloneable`, { cause: error });
  }
}

function readHostErrorId(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[HOST_ERROR_ID];
  return typeof value === "string" ? value : undefined;
}

function renderThrownValue(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function declaresName(statement: ts.VariableStatement, name: string): boolean {
  return statement.declarationList.declarations.some(
    (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
  );
}

function hasExportModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true
  );
}

function isValueReferenceIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return false;

  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === identifier
  ) {
    return false;
  }
  if (ts.isBindingElement(parent) && (parent.name === identifier || parent.propertyName === identifier)) {
    return false;
  }
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    ((ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent)) &&
      parent.name === identifier) ||
    (ts.isEnumMember(parent) && parent.name === identifier) ||
    (ts.isLabeledStatement(parent) && parent.label === identifier) ||
    ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === identifier) ||
    (ts.isMetaProperty(parent) && parent.name === identifier)
  ) {
    return false;
  }
  return true;
}

function isBindingIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === identifier
  ) {
    return true;
  }
  return ts.isBindingElement(parent) && parent.name === identifier;
}

function isUnboundNamedIdentifier(
  expression: ts.Expression,
  name: string,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): boolean {
  const unwrapped = unwrapExpression(expression);
  return (
    ts.isIdentifier(unwrapped) &&
    unwrapped.text === name &&
    isAmbientIdentifier(unwrapped, checker, sourceFile)
  );
}

function isAmbientIdentifier(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  return (
    symbol === undefined ||
    symbol.declarations === undefined ||
    !symbol.declarations.some((declaration) => declaration.getSourceFile() === sourceFile)
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function outerExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function staticPropertyName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticPropertyName(node.expression);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticPropertyName(node.left);
    const right = staticPropertyName(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function staticComputedPropertyName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticComputedPropertyName(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticComputedPropertyName(node.left);
    const right = staticComputedPropertyName(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function isProvablyNumericIndex(
  node: ts.Expression,
  checker: ts.TypeChecker,
  seenSymbols = new Set<ts.Symbol>(),
): boolean {
  if (
    (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
    node.type.kind === ts.SyntaxKind.NumberKeyword
  ) {
    return isProvablyNumericIndex(node.expression, checker, seenSymbols);
  }
  const expression = unwrapExpression(node);
  if (ts.isNumericLiteral(expression)) return true;
  if (
    ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.PlusToken ||
      expression.operator === ts.SyntaxKind.MinusToken)
  ) {
    return isProvablyNumericIndex(expression.operand, checker, seenSymbols);
  }
  if (
    ts.isCallExpression(expression) &&
    isUnboundNamedIdentifier(
      expression.expression,
      "Number",
      checker,
      expression.getSourceFile(),
    )
  ) {
    return true;
  }
  if (ts.isBinaryExpression(expression)) {
    const numericOperators = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.AsteriskAsteriskToken,
      ts.SyntaxKind.SlashToken,
      ts.SyntaxKind.PercentToken,
      ts.SyntaxKind.LessThanLessThanToken,
      ts.SyntaxKind.GreaterThanGreaterThanToken,
      ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ts.SyntaxKind.AmpersandToken,
      ts.SyntaxKind.BarToken,
      ts.SyntaxKind.CaretToken,
    ]);
    return (
      numericOperators.has(expression.operatorToken.kind) &&
      isProvablyNumericIndex(expression.left, checker, seenSymbols) &&
      isProvablyNumericIndex(expression.right, checker, seenSymbols)
    );
  }
  if (!ts.isIdentifier(expression)) return false;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seenSymbols.has(symbol)) return false;
  const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!declaration?.initializer || !ts.isIdentifier(declaration.name)) return false;
  if (
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }
  const nextSeen = new Set(seenSymbols).add(symbol);
  return isProvablyNumericIndex(declaration.initializer, checker, nextSeen);
}

function hasLexicalThis(node: ts.Node): boolean {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return true;
    if (ts.isClassLike(current)) return true;
    current = current.parent;
  }
  return false;
}

function hasArgumentsBinding(node: ts.Node): boolean {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return true;
    current = current.parent;
  }
  return false;
}

function compileFailure(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  filename: string,
  message: string,
): never {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
  throw new WorkflowCompileError(
    `${filename}:${position.line + 1}:${position.character + 1}: ${message}`,
  );
}

function formatDiagnostic(diagnostic: ts.Diagnostic, filename: string): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.start === undefined || !diagnostic.file) return `${filename}: ${message}`;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${filename}:${position.line + 1}:${position.character + 1}: ${message}`;
}

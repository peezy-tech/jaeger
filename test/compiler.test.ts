import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkflowSource } from "../src/compiler.js";
import { WorkflowCompileError } from "../src/errors.js";
import type { WorkflowContext, WorkflowMeta } from "../src/types.js";

test("compiles Jaeger primitives, top-level await, parallel, and return", async () => {
  const phases: string[] = [];
  let meta: WorkflowMeta | undefined;
  const workflow = compileWorkflowSource(
    `
export const meta = { name: "compiler-demo" }
phase("Inspect")
const values = await parallel([
  () => agent("one", { harness: "codex" }),
  () => agent("two", { harness: "claude" }),
])
return { input: inputs.value, values }
`,
    "compiler-demo.js",
  );
  const context = makeContext({
    inputs: { value: 42 },
    setMeta(value) {
      meta = value as WorkflowMeta;
    },
    phase(name) {
      phases.push(name);
    },
    async agent(prompt) {
      return prompt.toUpperCase();
    },
  });

  const result = await workflow.run(context);
  assert.deepEqual(meta, { name: "compiler-demo" });
  assert.deepEqual(phases, ["Inspect"]);
  assert.deepEqual(result, { input: 42, values: ["ONE", "TWO"] });
});

test("preserves deterministic ordinary TypeScript and safe built-ins", async () => {
  const logs: unknown[] = [];
  const workflow = compileWorkflowSource(
    `
interface WorkflowInputs {
  values: number[]
  factor: number
}
type Summary = { total: number; maximum: number; unique: number[] }
export const meta = { name: "deterministic-typescript" }
const source = inputs as WorkflowInputs
const scaled: number[] = []
for (const value of source.values) {
  scaled.push(value * source.factor)
}
function sum(values: number[]): number {
  let total = 0
  for (let index = 0; index < values.length; index += 1) total += values[Number(index)] ?? 0
  return total
}
function argumentCount(): number { return arguments.length }
const calculator = {
  offset: 3,
  apply(value: number) { return value + this.offset },
}
const awaited = await Promise.all(scaled.map((value) => Promise.resolve(calculator.apply(value))))
const unique = [...new Set(awaited)].sort((left, right) => left - right)
const summary: Summary = {
  total: sum(awaited),
  maximum: Math.max(...awaited),
  unique,
}
log({ count: argumentCount(...awaited) })
return JSON.parse(JSON.stringify(summary))
`,
    "ordinary.ts",
  );

  const result = await workflow.run(
    makeContext({
      inputs: { values: [3, 1, 3], factor: 2 },
      log(message) {
        logs.push(message);
      },
    }),
  );

  assert.deepEqual(result, { total: 23, maximum: 9, unique: [5, 9] });
  assert.deepEqual(logs, [{ count: 3 }]);
});

test("rejects non-deterministic and ambient coordinator capabilities with locations", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly statement: string;
    readonly message: RegExp;
  }> = [
    {
      name: "static-import",
      statement: 'import fs from "node:fs"',
      message: /workflow imports are not supported/,
    },
    {
      name: "dynamic-import",
      statement: 'await import("node:fs")',
      message: /dynamic import is not allowed/,
    },
    { name: "import-meta", statement: "return import.meta.url", message: /import\.meta is environment-dependent/ },
    {
      name: "with-statement",
      statement: 'with ({ value: 1 }) { log("no") }',
      message: /name resolution must be statically verifiable/,
    },
    { name: "global-this", statement: "return globalThis", message: /ambient\/global access/ },
    { name: "unknown-global", statement: "return mysteryApi()", message: /ambient or unknown global/ },
    { name: "environment", statement: "return process.env.HOME", message: /environment access/ },
    { name: "require", statement: 'return require("node:fs")', message: /filesystem access/ },
    { name: "clock-date", statement: "return Date.now()", message: /clock access/ },
    { name: "clock-performance", statement: "return performance.now()", message: /clock access/ },
    { name: "locale", statement: "return Intl.DateTimeFormat()", message: /locale and environment/ },
    { name: "math-random", statement: "return Math.random()", message: /Math\.random is not allowed/ },
    {
      name: "computed-math-random",
      statement: 'return Math["ran" + "dom"]()',
      message: /Math\.random is not allowed/,
    },
    { name: "network-fetch", statement: 'return fetch("https://example.com")', message: /network access/ },
    { name: "network-socket", statement: 'return new WebSocket("wss://example.com")', message: /network access/ },
    { name: "timer", statement: "setTimeout(() => {}, 1)", message: /timer access/ },
    { name: "microtask", statement: "queueMicrotask(() => {})", message: /scheduling access/ },
    { name: "console", statement: 'console.log("no")', message: /use Jaeger's log\(\)/ },
    { name: "weak-ref", statement: "return new WeakRef({})", message: /garbage-collection-dependent/ },
    {
      name: "finalization",
      statement: "return new FinalizationRegistry(() => {})",
      message: /garbage-collection-dependent/,
    },
    { name: "atomics", statement: "return Atomics.isLockFree(4)", message: /shared-memory scheduling/ },
    { name: "promise-race", statement: "return Promise.race([])", message: /winner timing/ },
    { name: "promise-any", statement: "return Promise.any([])", message: /winner timing/ },
    {
      name: "promise-then",
      statement: 'return agent("one", { harness: "codex" }).then((value) => value)',
      message: /continuation scheduling is not allowed/,
    },
    {
      name: "promise-catch",
      statement: 'return agent("one", { harness: "codex" }).catch(() => "fallback")',
      message: /continuation scheduling is not allowed/,
    },
    {
      name: "computed-promise-finally",
      statement: 'return agent("one", { harness: "codex" })["fin" + "ally"](() => {})',
      message: /continuation scheduling is not allowed/,
    },
    {
      name: "extracted-promise-then",
      statement: 'const { then } = agent("one", { harness: "codex" })',
      message: /Promise continuation scheduling is not replay-deterministic/,
    },
    {
      name: "computed-promise",
      statement: "return Promise[inputs.method]([])",
      message: /dynamic string property access is not allowed/,
    },
    {
      name: "locale-string",
      statement: "return (1234).toLocaleString()",
      message: /locale-dependent/,
    },
    {
      name: "locale-compare",
      statement: 'return "a".localeCompare("b")',
      message: /locale-dependent/,
    },
    {
      name: "locale-lower",
      statement: 'return "I".toLocaleLowerCase()',
      message: /locale-dependent/,
    },
    {
      name: "computed-locale-upper",
      statement: 'return "i"["toLocale" + "UpperCase"]()',
      message: /locale-dependent/,
    },
    {
      name: "dynamic-locale-member",
      statement: 'const method = ["toLocale", "String"].join(""); return (1234.5)[method]()',
      message: /dynamic string property access is not allowed/,
    },
    {
      name: "mutated-numeric-index",
      statement: 'let index = 0; [index] = ["toLocaleString"]; return (1234.5)[index]()',
      message: /dynamic string property access is not allowed/,
    },
    {
      name: "dynamic-locale-binding",
      statement: 'const key = ["toLocale", "String"].join(""); const { [key]: formatter } = Number.prototype; return formatter.call(1234.5)',
      message: /dynamic computed destructuring is not allowed/,
    },
    {
      name: "reflective-locale-descriptor",
      statement: 'const key = ["toLocale", "String"].join(""); return Object.getOwnPropertyDescriptor(Number.prototype, key).value.call(1234.5)',
      message: /reflective properties/,
    },
    { name: "eval", statement: 'return eval("1 + 1")', message: /cannot compile or evaluate strings/ },
    {
      name: "function-constructor",
      statement: 'return Function("return 1")()',
      message: /cannot compile or evaluate strings/,
    },
    {
      name: "constructor-escape",
      statement: 'return (() => {}).constructor("return 1")()',
      message: /access to `constructor` is not allowed/,
    },
    {
      name: "computed-constructor-escape",
      statement: 'return (() => {})["con" + "structor"]("return 1")()',
      message: /access to `constructor` is not allowed/,
    },
    {
      name: "reserved-binding",
      statement: "const __jaegerInternalAgent = 1",
      message: /reserved by Jaeger/,
    },
    { name: "top-level-this", statement: "return this", message: /top-level `this`/ },
  ];

  for (const entry of cases) {
    const filename = `${entry.name}.ts`;
    assert.throws(
      () =>
        compileWorkflowSource(
          `export const meta = { name: "negative" }\n${entry.statement}\nreturn null`,
          filename,
        ),
      (error: unknown) => {
        assert.ok(error instanceof WorkflowCompileError, `${entry.name} should be a compile error`);
        assert.match(error.message, new RegExp(`^${filename.replaceAll("-", "\\-")}:2:\\d+:`));
        assert.match(error.message, entry.message);
        return true;
      },
      entry.name,
    );
  }
});

test("rejects shared mutation from replay-scheduled async and parallel callbacks", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly body: string }> = [
    {
      name: "parallel-captured-array",
      body: `
const shared = []
await parallel([
  async () => { shared.push(await agent("one", { harness: "codex" })) },
  async () => { shared[0] = await agent("two", { harness: "codex" }) },
])
return shared`,
    },
    {
      name: "parallel-direct-callback",
      body: `
const shared = []
await parallel([() => {
  shared["pu" + "sh"]("started")
  return agent("one", { harness: "codex" })
}])
return shared`,
    },
    {
      name: "async-captured-scalar",
      body: `
let shared = 0
async function task() { shared += await agent("one", { harness: "codex" }) }
await task()
return shared`,
    },
    {
      name: "transitive-mutation-helper",
      body: `
const shared = []
function mutate() { shared.push("done") }
async function task() { await agent("one", { harness: "codex" }); mutate() }
await task()
return shared`,
    },
    {
      name: "parameter-alias-helper",
      body: `
const shared = []
function mutate(target) { target.push("done") }
async function task() { await agent("one", { harness: "codex" }); mutate(shared) }
await task()
return shared`,
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () =>
        compileWorkflowSource(
          `export const meta = { name: ${JSON.stringify(entry.name)} }\n${entry.body}`,
          `${entry.name}.js`,
        ),
      /may not mutate captured or externally owned state/,
      entry.name,
    );
  }
});

test("allows replay-scheduled callbacks to mutate state they allocate locally", async () => {
  const workflow = compileWorkflowSource(
    `
export const meta = { name: "local-async-state" }
async function task() {
  const local = []
  local.push(await agent("one", { harness: "codex" }))
  local.sort()
  return local
}
return await task()
`,
    "local-async-state.js",
  );

  assert.deepEqual(await workflow.run(makeContext()), ["one"]);
});

test("delivers concurrent agent results to coordinator continuations in invocation order", async () => {
  const logs: unknown[] = [];
  const workflow = compileWorkflowSource(
    `
export const meta = { name: "ordered-agent-delivery" }
await parallel([
  async () => { const value = await agent("slow", { harness: "codex" }); log(value) },
  async () => { const value = await agent("fast", { harness: "codex" }); log(value) },
])
return "done"
`,
    "ordered-agent-delivery.js",
  );

  const result = await workflow.run(
    makeContext({
      async agent(prompt) {
        if (prompt === "slow") {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        return prompt;
      },
      log(message) {
        logs.push(message);
      },
    }),
  );

  assert.equal(result, "done");
  assert.deepEqual(logs, ["slow", "fast"]);
});

test("rejects imports, invalid metadata, and syntax errors actionably", () => {
  assert.throws(
    () => compileWorkflowSource("return 1", "missing.js"),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowCompileError);
      assert.match(error.message, /^missing\.js:1:1: missing `export const meta/);
      return true;
    },
  );
  assert.throws(
    () => compileWorkflowSource("export let meta = { name: 'bad' }", "mutable-meta.js"),
    /mutable-meta\.js:1:1: meta must be declared with `const`/,
  );
  assert.throws(
    () => compileWorkflowSource("export const meta = { name: 'bad' }, extra = 1", "extra-meta.js"),
    /extra-meta\.js:1:1: the metadata export may declare only `meta`/,
  );
  assert.throws(
    () => compileWorkflowSource("export const meta = {\nreturn 1", "syntax.js"),
    /syntax\.js:\d+:\d+:/,
  );
});

test("the compiler blocks dynamically obscured Function-constructor access", () => {
  assert.throws(
    () => compileWorkflowSource(
      `
export const meta = { name: "realm-code-generation" }
const key = ["con", "structor"].join("")
const constructorFunction = (() => {})[key]
return constructorFunction("return 1")()
`,
      "realm-code-generation.js",
    ),
    /dynamic string property access is not allowed/,
  );
});

test("the compiler blocks Promise timing primitives reached through reflection", () => {
  assert.throws(
    () => compileWorkflowSource(
      `
export const meta = { name: "realm-promise-timing" }
const constructorName = ["con", "structor"].join("")
const raceName = ["ra", "ce"].join("")
const promise = Promise.resolve(1)
const prototype = Object.getPrototypeOf(promise)
const promiseConstructor = Object.getOwnPropertyDescriptor(prototype, constructorName)?.value
const race = Object.getOwnPropertyDescriptor(promiseConstructor, raceName)?.value
return race([promise])
`,
      "realm-promise-timing.js",
    ),
    /reflective properties|dynamic string property access/,
  );
});

test("preserves host error identity without exposing host errors inside the realm", async () => {
  const expected = new Error("host agent failed");
  const workflow = compileWorkflowSource(
    `
export const meta = { name: "host-error" }
await agent("fail", { harness: "codex" })
return "unreachable"
`,
    "host-error.js",
  );

  await assert.rejects(
    workflow.run(
      makeContext({
        async agent() {
          throw expected;
        },
      }),
    ),
    (error: unknown) => error === expected,
  );
});

test("unawaited failing realm primitives are handled without changing awaited rejection", async () => {
  const observed: unknown[] = [];
  const onUnhandled = (error: unknown): void => {
    observed.push(error);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    const unawaited = compileWorkflowSource(
      `
export const meta = { name: "unawaited-errors" }
void agent("fail", { harness: "codex" })
void parallel([() => { throw new Error("parallel failed") }])
return "done"
`,
      "unawaited-errors.js",
    );
    const result = await unawaited.run(
      makeContext({
        async agent() {
          throw new Error("agent failed");
        },
      }),
    );
    assert.equal(result, "done");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(observed, []);

    const expected = new Error("awaited agent failed");
    const awaited = compileWorkflowSource(
      `
export const meta = { name: "awaited-error" }
await agent("fail", { harness: "codex" })
return "unreachable"
`,
      "awaited-error.js",
    );
    await assert.rejects(
      awaited.run(
        makeContext({
          async agent() {
            throw expected;
          },
        }),
      ),
      (error: unknown) => error === expected,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  const context: WorkflowContext = {
    inputs: {},
    trigger: undefined,
    setMeta() {},
    phase() {},
    log() {},
    async agent(prompt) {
      return prompt;
    },
    async parallel<T>(tasks: ReadonlyArray<() => Promise<T> | T>): Promise<T[]> {
      return await Promise.all(tasks.map(async (task) => await task()));
    },
    ...overrides,
  };
  return context;
}

# Claude Code Dynamic Workflows: Observational Evidence

Research date: 2026-07-17

## Research question

What does Claude Code expose in workflow mode, and why does creating, running,
inspecting, and iterating on workflows feel pleasant for an agent?

This note records public documentation and behavior observed in one local
Claude Code installation. It is evidence about Claude Code, not a specification
for Jaeger. Claude-specific tools, caching, lifecycle, permissions, worktrees,
and limits do not become Jaeger requirements merely because they contribute to
Claude Code's experience.

The design conclusions accepted for Jaeger live separately in
[Jaeger Workflow Model](../design/jaeger-workflows.md).

## Executive summary

Claude Code's workflow experience is effective because it is a complete vertical
interaction loop, not merely a small JavaScript DSL:

1. The user asks for a workflow in ordinary language.
2. Claude writes one readable, prompt-heavy JavaScript script.
3. The user can inspect the phase summary or raw script before approving it.
4. The runtime launches the workflow in the background and keeps the session
   responsive.
5. Runtime concerns such as scheduling, progress, token accounting, caching,
   transcripts, permissions, and resumption stay outside the authored script.
6. The resulting script is persisted as an ordinary file that Claude can edit
   with its normal file tools.
7. The workflow can be resumed, rerun, or saved as a named command.

The workflow itself is mostly prompts and dataflow. Plain JavaScript connects
structured outputs from one subagent to later prompts. The runtime owns the
operational complexity.

Anthropic describes the distinction directly: in a workflow, the script holds
the plan, intermediate results live in script variables, and the orchestration
itself is repeatable. See [Orchestrate subagents at scale with dynamic
workflows](https://code.claude.com/docs/en/workflows#when-to-use-a-workflow).

## Sources and evidence levels

### Public, documented behavior

The primary source is Anthropic's [Dynamic Workflows
guide](https://code.claude.com/docs/en/workflows). Supporting sources are:

- [Run agents in parallel](https://code.claude.com/docs/en/agents), which
  compares workflows with subagents, agent view, teams, and worktrees.
- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference),
  which identifies `Workflow` as the tool that runs a background script and
  returns one consolidated result.
- [Agent SDK TypeScript
  reference](https://code.claude.com/docs/en/agent-sdk/typescript), which exposes
  Workflow tool input and output types in the SDK reference.

The current public guide says Dynamic Workflows require Claude Code 2.1.154 or
later and are available on paid plans and supported API/cloud-provider routes.
Availability and exact behavior are versioned product facts and may change.

### Local observational evidence

The following categories of machine-local artifacts were inspected. Their
original paths and identifiers are intentionally omitted because they are not
part of Jaeger's public design evidence:

- The installed CLI version and changelog.
- Generated workflow scripts under the provider's per-project state.
- Persisted workflow run records under the same state.
- One representative review workflow and its corresponding run record.
- Installed changelog: `~/.claude/cache/changelog.md`
- The installed Workflow tool description and validation messages embedded in
  the local Claude Code distribution.

Local artifacts are useful for details not fully explained by the public guide,
but they are observations of one build rather than a stable public contract.

## 1. The agent-facing entry point is small

In the locally installed build, the parent agent's Workflow tool accepts these
principal forms:

```js
Workflow({ script })
Workflow({ name, args })
Workflow({ scriptPath, resumeFromRunId })
```

The observed input surface also includes a `remote` option. `scriptPath` lets
the agent invoke an edited, persisted script without sending its contents
again. `name` invokes a saved workflow. `args` passes structured invocation
data into the script as a global. `resumeFromRunId` resumes a prior run in the
same session.

This is progressive disclosure. A generated one-off workflow needs only
`script`. Persistence, naming, input, remote execution, and resume are introduced
only when needed.

The public guide independently documents saved workflow input through the
global `args` value: [Pass input to a saved
workflow](https://code.claude.com/docs/en/workflows#pass-input-to-a-saved-workflow).

## 2. The authored language is ordinary JavaScript plus a tiny DSL

The public example is a script with a literal `meta` export, top-level `await`,
an `agent()` call that discovers work, a `pipeline()` that fans out across the
discovered items, and a normal JavaScript return value. See [What the saved
script looks like](https://code.claude.com/docs/en/workflows#what-the-saved-script-looks-like).

The locally observed vocabulary is:

- `agent(prompt, options)` to run one worker and return its result.
- `parallel([() => ..., () => ...])` to run independent thunks concurrently and
  preserve result positions.
- `pipeline(items, stage, ...)` to fan work across a list and optionally carry
  it through further stages.
- `phase(name)` to expose human-readable progress without changing dataflow.
- `log(value)` to add a workflow log entry.
- `workflow(name)` to compose a saved, named workflow.
- `args` for structured invocation input.
- Ordinary arrays, objects, loops, conditionals, template strings, promises,
  and returns for everything else.

A representative local script has this shape:

```js
export const meta = {
  name: "high-code-review",
  description: "Find, verify, and synthesize review findings",
  phases: [
    { title: "Find", detail: "Independent review angles" },
    { title: "Verify", detail: "Adversarial verification" },
  ],
}

phase("Find")
const candidates = await parallel(angles.map(([label, prompt]) => () =>
  agent(prompt, { label, phase: "Find", schema: FINDINGS })
))

phase("Verify")
const verified = await parallel(deduplicate(candidates).map(finding => () =>
  agent(`Verify this candidate: ${JSON.stringify(finding)}`, {
    label: `verify:${finding.file}:${finding.line}`,
    phase: "Verify",
    schema: VERDICT,
  })
))

return agent(`Synthesize: ${JSON.stringify(verified)}`, {
  schema: SYNTHESIS,
})
```

The prompts carry most of the policy. The script supplies dependency,
concurrency, bounded loops, deduplication, and routing.

## 3. Structured outputs are normal dataflow values

An `agent()` call can receive a JSON Schema. Its output becomes an ordinary
JavaScript value that can be filtered, mapped, deduplicated, serialized into a
later prompt, or returned.

This removes the need for a separate action abstraction merely to connect one
agent's result to another. A review-fix-review loop can be expressed as:

1. Reviewer returns structured findings.
2. The script places those findings in the fixer's prompt.
3. The fixer returns a structured report of edits and validation.
4. The script places that report and the current repository state in the next
   review prompt.

Local changelog entries show that the runtime actively handles structured-output
edge cases, including missing structured output, schema validation failures,
and bounded retries. Those mechanics are kept out of the workflow source.

## 4. The script is a coordinator, not a privileged action runtime

The public guide states that workflow code has no direct filesystem or shell
access. Agents perform reads, edits, commands, web requests, and tool calls; the
script coordinates them. See [Behavior and
limits](https://code.claude.com/docs/en/workflows#behavior-and-limits).

This boundary is central to readability:

- The workflow does not implement a second command/action framework.
- Worker capabilities come from the native harness's tools and permissions.
- Tool calls remain attributable to the worker that made them.
- The orchestration layer deals in prompts, results, and control flow.

This coordinator boundary is one potentially transferable property. Whether and
how Jaeger adopts it is a design question outside this evidence note.

## 5. Launch approval is also a workflow preview

Before execution, Claude Code can show the workflow name and planned phases.
The user can:

- run it once;
- allow that workflow for the project;
- inspect the raw script;
- open the script in an editor with `Ctrl+G`;
- adjust the prompt before launch; or
- deny the run.

The exact prompting depends on the active permission mode. See [Approve the
plan before it runs](https://code.claude.com/docs/en/workflows#approve-the-plan-before-it-runs).

This makes dynamic code generation legible before it becomes expensive or
side-effecting. The workflow's `meta` and phase declarations double as a compact
execution preview.

## 6. Execution is backgrounded and inspectable

The workflow starts in the background, allowing the main conversation to remain
responsive. `/workflows` presents running and completed runs. Its documented
controls include:

- navigate from a run to phases and individual agents;
- inspect an agent's prompt, recent tool calls, and result;
- filter agents by status;
- pause or resume the run;
- stop one agent or the whole run;
- restart a selected agent; and
- save the run's script as a reusable command.

The phase view reports agent counts, token totals, and elapsed time. See [Watch
the run](https://code.claude.com/docs/en/workflows#watch-the-run).

The representative local `wf_4868dc2b-933.json` additionally demonstrates the
runtime data that supports this UI. It records:

- workflow name, summary, status, run ID, and script path;
- declared phases;
- total duration, agents, tokens, and tool calls;
- phase and agent progress entries;
- agent label, model, state, timestamps, and cache status;
- prompt and result previews; and
- logs and the final result.

The example review run recorded 50 total agents, 36,514 tokens, and 59.4 seconds
of elapsed time. None of the code for collecting or presenting that telemetry
appeared in the workflow script.

## 7. Persistence and resume require little protocol knowledge

Every run writes its generated script under the session directory. The agent is
given that path and can inspect, diff, or edit it with normal file tools. The
runtime tracks completed results so a stopped run can return cached results for
completed agents while running unfinished work live. Resume is scoped to the
same Claude Code session. See [How a workflow
runs](https://code.claude.com/docs/en/workflows#how-a-workflow-runs) and [Resume
after a pause](https://code.claude.com/docs/en/workflows#resume-after-a-pause).

The locally observed tool result makes the continuation protocol explicit. It
reports the task ID, run ID, script path, transcript directory, and an exact
example invocation using `scriptPath` and `resumeFromRunId`. This matters for
agent ergonomics: the tool response itself teaches the agent what to inspect and
what to do next.

The public docs confirm completed-agent caching. The exact cache-key algorithm
and invalidation behavior after editing a script are not documented and should
not be copied based on assumption.

## 8. Saving and discovery turn successful runs into products

A successful generated workflow can be saved as:

- `.claude/workflows/` for the project; or
- `~/.claude/workflows/` for the user.

Saved workflows become slash commands. In monorepos, the closest applicable
project workflow wins when names collide. See [Save the workflow for
reuse](https://code.claude.com/docs/en/workflows#save-the-workflow-for-reuse).

This creates a pleasant progression:

```text
natural-language request
  -> generated one-off workflow
  -> inspected and edited script
  -> successful run
  -> named reusable command
```

There is no up-front packaging ceremony before the user knows the workflow is
useful.

## 9. Guardrails are outside the happy-path syntax

The runtime enforces resource limits and reports cost without requiring authors
to implement those systems. The current public limits include up to 16
concurrent agents and 1,000 total agents per run. `/workflows` exposes token
usage and supports stopping a run. A configurable size guideline influences how
large a workflow Claude writes, while runtime caps remain enforced. See [Cost](https://code.claude.com/docs/en/workflows#cost)
and [Set a size guideline](https://code.claude.com/docs/en/workflows#set-a-size-guideline).

The installed build also validates workflow syntax and metadata before launch.
Locally observed errors are designed to be corrective, such as explaining that
`parallel()` expects thunks rather than already-created promises. Determinism
checks reject time and randomness APIs that would make replay ambiguous. These
are implementation details observed in 2.1.211, not promises in the public
guide.

## Why this is pleasant specifically for the parent agent

The parent agent does not have to memorize an orchestration protocol. The tools
and their responses provide a sequence of affordances:

1. **Generate:** send a self-contained script through one tool call.
2. **Understand:** see the workflow name and phase summary.
3. **Inspect:** open the persisted raw script.
4. **Monitor:** use one progress surface rather than polling every worker.
5. **Diagnose:** drill into a particular phase or agent.
6. **Iterate:** edit the script with ordinary file tools.
7. **Continue:** use the returned run ID and explicit resume recipe.
8. **Reuse:** save the working script as a named command.

The result of an orchestration entry point acting as both control surface and
tutorial is a potentially transferable observation. The dedicated tool that
delivers it is a Claude Code implementation detail.

## Evidence boundary

The following observations explain Claude Code but are not requirements or open
design blockers for Jaeger:

- the dedicated `Workflow` tool and its exact input or output schema;
- completed-agent cache identity and invalidation after script edits;
- whether labels, phases, models, or schemas affect Claude's cache;
- nested `workflow()` pause, resume, and failure behavior;
- the exact structured-output correction protocol and retry count;
- same-session versus cross-process lifecycle boundaries;
- local worktree and remote isolation behavior; and
- Claude Code's concurrency caps, size guidance, and cost presentation.

These details should be validated only when the goal is to understand or
compare Claude Code itself. They should not delay Jaeger implementation. Jaeger
defines its own authorization, durability, isolation, and CLI contracts in
[Jaeger Workflow Model](../design/jaeger-workflows.md).

## Unverified Claude behavior

If future comparative research needs exact answers, the remaining questions
include:

1. The exact Workflow input and output schema across Claude CLI, Desktop, and
   Agent SDK surfaces.
2. The exact cache identity and invalidation rules for an edited script resumed
   from an earlier run.
3. Whether changing only labels, phase names, model options, or schemas causes a
   cached `agent()` call to rerun.
4. The structured-output correction protocol and terminal retry count in the
   current version.
5. The behavior of nested `workflow()` calls during pause, resume, and failure.
6. The security and lifecycle semantics of local worktree and remote isolation.
7. How much workflow state survives a Claude process restart versus a new
   Claude session.

Validate these with small disposable repositories and bounded provider runs,
not by treating the representative review session as a stable contract.

## Source index

- Anthropic, [Orchestrate subagents at scale with dynamic
  workflows](https://code.claude.com/docs/en/workflows)
- Anthropic, [Run agents in
  parallel](https://code.claude.com/docs/en/agents)
- Anthropic, [Claude Code tools
  reference](https://code.claude.com/docs/en/tools-reference)
- Anthropic, [Agent SDK reference -
  TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)
- Anthropic, [Claude Code
  FAQ](https://support.claude.com/en/articles/12386420-claude-code-faq)
- Anthropic, [Claude Code power user
  tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips)

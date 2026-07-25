# Contributing

Thank you for helping improve Jaeger Workflows.

## Before opening a change

- Search the issue tracker for existing work.
- Discuss changes to the workflow language, durability contract, authority
  model, or persisted formats before implementing them.
- Never include credentials, provider transcripts, private prompts, machine
  inventory, or real runtime state in an issue, fixture, or commit.

## Development setup

Use Node.js 22.13 or newer and the exact pnpm version in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm verify:portable
```

`pnpm verify:portable` is the public CI gate. On a Linux host with cgroup v2
and a working systemd user manager, run the full release gate:

```bash
pnpm verify
```

Windows development supports the SSH-controller surface:

```powershell
pnpm verify:controller
```

## Pull requests

Keep changes focused and include:

- the behavior and trust-boundary impact;
- tests for new behavior or a reason tests do not apply;
- exact validation commands and results; and
- migration notes for persisted state or configuration changes.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.

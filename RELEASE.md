# Release process

Jaeger Workflows is currently pre-1.0. A release candidate must pass every
gate below.

1. Confirm the release commit is clean and reviewed.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm audit --prod` with no known production vulnerabilities.
4. Run `pnpm verify:portable`.
5. On a supported Linux runtime host, run `pnpm verify`.
6. On native Windows, require the `Windows controller` GitHub Actions job.
7. Inspect `npm pack --dry-run` and verify that source, tests, credentials,
   local state, and research-only machine details are absent.
8. Run a history-aware secret scan.
9. Install the exact packed artifact and prove `jaeger doctor`, backend
   continuity, and one detached workflow on Linux.
10. Tag and publish release notes that describe behavior, security impact, and
    migrations.

Publishing to npm is a separate maintainer action. The package name is
`jaeger-workflows`; the command remains `jaeger`. Never publish the unrelated
`jaeger` package name.

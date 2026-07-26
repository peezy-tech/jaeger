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
8. Install the exact packed artifact into a fresh npm consumer and run
   `npm audit --omit=dev --audit-level=low` against the consumer-resolved
   dependency graph.
9. Run a history-aware secret scan.
10. Install the exact packed artifact and prove `jaeger doctor`, backend
   continuity, and one detached workflow on Linux.
11. Tag and publish release notes that describe behavior, security impact, and
    migrations.

Publishing to npm is performed by `.github/workflows/publish.yml` from a
published GitHub release whose tag exactly matches `v<package.version>`. The
public package is `@peezy.tech/jaeger`; the command remains `jaeger`. Never
publish the unrelated unscoped `jaeger` package.

The workflow uses npm trusted publishing when the package has a GitHub Actions
publisher configured for the `peezy-tech/jaeger` repository and
`publish.yml`. The first publish may be bootstrapped with a repository
`NPM_TOKEN`; remove that secret after configuring trusted publishing.

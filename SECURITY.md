# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository:

https://github.com/matamune-peezy/jaeger-workflows/security/advisories/new

Include the affected revision, platform, reproduction steps, impact, and any
suggested mitigation. Do not include live credentials, private prompts,
provider transcripts, or unrelated machine data.

You should receive an initial acknowledgement within seven days. A fix and
disclosure timeline will depend on severity and whether provider or platform
coordination is required.

## Supported versions

Before a stable release, only the latest commit on `main` is supported. Once
versioned releases begin, this section will identify supported release lines.

## Security boundary

Jaeger coordinates full-authority coding-agent harnesses. It is not a sandbox.
The operator authorizes the workflow and is responsible for the outer host,
container, VM, workspace, credentials, SSH configuration, and provider policy.
See [docs/deployment-model.md](docs/deployment-model.md) for the supported
deployment and trust assumptions.

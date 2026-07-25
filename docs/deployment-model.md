# Supported deployment and trust model

This document makes Jaeger's infrastructure assumptions explicit. They are
product constraints, not properties of a private deployment.

## Supported topology

The execution runtime is a per-user service on Linux. It requires:

- Node.js 22.13 or newer;
- cgroup v2;
- a working systemd user manager and transient user scopes; and
- at least one installed and authenticated native harness.

Windows 10 and Windows 11 are supported as controller-only clients. A Windows
controller uses its built-in OpenSSH client and existing user SSH configuration
to reach a supported Linux runtime. It does not run the backend locally.

macOS is not currently a supported host or controller.

## Network boundary

Jaeger does not expose an HTTP server. The Linux backend listens on an
owner-only local Unix socket. Remote commands open a noninteractive, one-shot
SSH channel and bridge one framed request over standard input and output.

Jaeger stores no SSH private keys, passwords, proxy commands, or arbitrary SSH
arguments. Host aliases, authentication, jump hosts, ports, and host-key policy
remain owned by OpenSSH configuration.

## Authority boundary

Starting a workflow authorizes every worker in that workflow to use the full
technical authority of its native harness. Prompt instructions such as
"review only" are behavioral policy, not access control. Transient systemd
scopes provide lifecycle containment and cleanup, not adversarial isolation.

Use an operator-selected container, VM, restricted account, or isolated machine
when a workflow must not have the authority of the host user.

Runtime modules execute inside the backend process and share its authority.
Only install trusted module code and dependencies.

## State and credentials

Run state and configuration are per-user and local to the runtime host. Provider
credentials, login state, model availability, account policy, and native
harness configuration remain provider-owned and are never copied into Jaeger
configuration.

Remote workflow paths are resolved on the Linux target. Windows paths are only
used for local workflow source, input, and controller configuration before a
request crosses SSH.

## Portability promises

Jaeger does not assume private domains, VPN addresses, organization gateways,
specific SSH aliases, provider profiles, or particular model names. Examples
inherit provider defaults unless an input explicitly supplies an override.

Custom harness launchers are supported as operator configuration, but their
availability and security are outside the shipped runtime.

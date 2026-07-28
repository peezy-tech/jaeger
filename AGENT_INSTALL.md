# Install Jaeger on this machine

This is an execution runbook for a coding agent. If you were given this file
through a raw GitHub URL, carry out the procedure instead of merely summarizing
it. Continue until the completion gate passes or report one concrete blocker
with the command and output that proves it.

The goal is a per-user Jaeger installation built from the same repository
revision as this file. Linux machines can be Jaeger runtime hosts. Windows
machines are supported as controller-only clients that coordinate agents on a
Linux runtime through the user's existing OpenSSH configuration. Do not try to
emulate the Linux backend with WSL, Docker, or a new HTTP service.

## Authority and safety

- Work as the current user. Do not use `sudo` or install a system service.
- Do not change SSH keys, provider credentials, provider login state, or host-key
  policy.
- Preserve existing Jaeger state, runtime registrations, harness configuration,
  hooks configuration, runtime-module configuration, and environment
  configuration. `jaeger backend install` is the supported in-place upgrade
  path.
- Do not overwrite an unrelated executable at the chosen install prefix. Inspect
  any existing `jaeger` command and stop if it is not recognizably this project.
- Do not install a floating package named `jaeger` or `@peezy.tech/jaeger` from
  a registry. This repository is the source authority; build its tarball and
  install that exact artifact.
- Do not claim success from a development checkout or test suite alone. Prove
  the installed binary and its persistent backend.

## 1. Resolve the source revision

Treat the URL used to retrieve this file as part of the trust boundary. A URL
such as:

```text
https://raw.githubusercontent.com/OWNER/REPOSITORY/main/AGENT_INSTALL.md
```

maps to:

```text
https://github.com/OWNER/REPOSITORY.git
```

Use that repository and the ref represented by the supplied URL. Do not
substitute a fork or similarly named package. If the file was pasted without
source provenance, use an already-present checkout only when its origin can be
verified; otherwise ask for the canonical repository URL.

Prefer a new temporary clone so an unrelated or dirty checkout is untouched.
For a `main` URL, the Linux acquisition shape is:

```bash
source_root="$(mktemp -d)"
git clone --filter=blob:none --single-branch --branch main \
  https://github.com/OWNER/REPOSITORY.git "$source_root/jaeger"
cd "$source_root/jaeger"
git status --short --branch
git rev-parse HEAD
```

In PowerShell on Windows:

```powershell
$SourceRoot = Join-Path ([IO.Path]::GetTempPath()) ("jaeger-source-" + [guid]::NewGuid())
git clone --filter=blob:none --single-branch --branch main `
  https://github.com/OWNER/REPOSITORY.git (Join-Path $SourceRoot "jaeger")
Set-Location (Join-Path $SourceRoot "jaeger")
git status --short --branch
git rev-parse HEAD
```

Replace `OWNER/REPOSITORY` from the actual raw URL. If the URL names an immutable
commit, check out that exact commit. Record the resolved 40-character commit for
the final report. The source worktree must be clean.

## 2. Prove prerequisites

Every installation requires Git, Node.js 22.13 or newer with `npm`, and the
`pnpm` version selected by `packageManager` in `package.json`.

A Linux runtime host additionally requires cgroup v2, a working user systemd
manager, and at least one supported native harness such as Codex, Claude Code,
or Pi:

```bash
uname -s
node --version
npm --version
pnpm --version
test -f /sys/fs/cgroup/cgroup.controllers
systemctl --user show-environment >/dev/null
systemd-run --user --scope --quiet true
```

On a Windows 10 or Windows 11 controller, inspect PowerShell, Node, npm, pnpm,
and the built-in OpenSSH client:

```powershell
$PSVersionTable.PSVersion
node --version
npm --version
pnpm --version
Get-Command ssh.exe
ssh -V
Test-Path (Join-Path $env:USERPROFILE ".ssh\config")
```

Windows does not need systemd, cgroup v2, or a local provider harness. The Linux
target owns those execution requirements. The Windows OpenSSH client reads the
user's existing `%USERPROFILE%\.ssh\config`; do not copy keys or SSH options
into Jaeger. Microsoft documents the client and configuration locations in its
[OpenSSH overview](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-overview)
and [Windows OpenSSH configuration guide](https://learn.microsoft.com/en-us/windows-server/administration/OpenSSH/openssh-server-configuration).

If `pnpm` is absent, activate the exact version named in `package.json` through
the machine's existing Node/Corepack toolchain. Do not choose a floating
version. If a required prerequisite cannot be made available without elevated
authority, stop and report it instead of weakening Jaeger's model.

Do not install or authenticate Codex, Claude Code, or Pi without user authorization.
An agent already running through one of them will normally satisfy the harness
requirement.

## 3. Verify and build the exact checkout

Install dependencies with `pnpm install --frozen-lockfile`. Then run:

- `pnpm verify` on a Linux runtime host; or
- `pnpm verify:controller` on a Windows controller.

The selected verifier must complete its type check, applicable test suite,
production build, package-content validation, and temporary artifact
installation. Fix a repository defect if necessary; do not bypass a failed
check.

## 4. Install the packed artifact for this user

Use a temporary pack directory and a user-owned prefix. The default prefix is
`$HOME/.local`:

Jaeger 0.1.0 used the unscoped package name `jaeger-workflows`. Uninstall that
legacy package from the same prefix before installing the scoped artifact so
npm can replace its `jaeger` executable shim. This package-identity migration
does not remove Jaeger state or configuration.

```bash
artifact_root="$(mktemp -d)"
pack_result="$(npm pack --json --pack-destination "$artifact_root")"
artifact_name="$(
  printf '%s' "$pack_result" |
    node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(0,"utf8")); if(p.length!==1) process.exit(1); process.stdout.write(p[0].filename)'
)"
artifact_path="$artifact_root/$artifact_name"
sha256sum "$artifact_path"
npm uninstall --global --prefix "$HOME/.local" --no-audit --no-fund \
  jaeger-workflows
npm install --global --prefix "$HOME/.local" --no-audit --no-fund \
  "$artifact_path"
export PATH="$HOME/.local/bin:$PATH"
hash -r
command -v jaeger
readlink -f "$(command -v jaeger)"
jaeger --help
```

On Linux, the resolved executable must be the newly installed
`$HOME/.local/lib/node_modules/@peezy.tech/jaeger/dist/cli.js`. If
`$HOME/.local/bin` is not already in the user's persistent `PATH`, add it
through the user's existing shell configuration conventions without replacing
unrelated configuration.

On Windows, use a user-owned prefix under `%LOCALAPPDATA%`:

```powershell
$ArtifactRoot = Join-Path ([IO.Path]::GetTempPath()) ("jaeger-pack-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $ArtifactRoot | Out-Null
$PackResult = npm pack --json --pack-destination $ArtifactRoot | ConvertFrom-Json
if ($PackResult.Count -ne 1) { throw "Expected exactly one Jaeger artifact" }
$ArtifactPath = Join-Path $ArtifactRoot $PackResult[0].filename
Get-FileHash -Algorithm SHA256 $ArtifactPath
$InstallRoot = Join-Path $env:LOCALAPPDATA "Jaeger"
npm uninstall --global --prefix $InstallRoot --no-audit --no-fund jaeger-workflows
npm install --global --prefix $InstallRoot --no-audit --no-fund $ArtifactPath
$env:Path = "$InstallRoot;$env:Path"
Get-Command jaeger.cmd
jaeger --help
```

The installed package root is
`%LOCALAPPDATA%\Jaeger\node_modules\@peezy.tech\jaeger`. Add
`%LOCALAPPDATA%\Jaeger` to the user `PATH` only if absent, preserving every
existing entry.

## 5. Connect the execution runtime

### Linux runtime host

Inventory first, then use the supported installer:

```bash
jaeger backend status || true
jaeger backend install
jaeger backend status
jaeger doctor
jaeger status --json
jaeger runtime list --json
```

The resulting backend must be active and connected. Its descriptor must report
`admissionReady: true`, and doctor must report
`containment.kind: "systemd-user-scope"` with containment available. At least
one configured harness must be available for real workflows.

An existing state root and stable backend `instanceId` must survive an upgrade.
The install generation is expected to rotate. Do not delete state or replace
configuration to make doctor appear clean.

### Windows controller

Do not run `jaeger backend install`, `--runtime embedded`, or local environment
management on Windows. First install and verify Jaeger on the Linux target using
the Linux branch of this runbook. Then prove the existing SSH profile reaches
that host and its Jaeger backend:

```powershell
$RuntimeName = "build"
$SshProfile = "build-host"
ssh $SshProfile jaeger doctor
jaeger runtime add $RuntimeName --ssh $SshProfile --default
jaeger runtime doctor $RuntimeName
jaeger runtime list --json
jaeger status --json
```

Replace the example name and SSH profile. `runtime add` performs a protocol and
doctor handshake, pins the Linux backend's stable instance identity, and writes
the controller registry under `%APPDATA%\Jaeger\runtimes.toml`. `--default`
makes bare `jaeger`, `run`, `list`, `doctor`, schedules, sessions, and hooks use
that target without a repeated flag. `jaeger runtime default NAME` changes the
default later.

The controller must not start a local Jaeger server or expose an HTTP endpoint.
Each operation uses one noninteractive `ssh.exe` stdio channel to the remote
Jaeger CLI, which forwards it to the remote owner-only Unix socket.

## 6. Make the workflow skill available

On Linux, locate the packaged skill relative to the installed executable:

```bash
jaeger_entrypoint="$(readlink -f "$(command -v jaeger)")"
jaeger_package_root="$(dirname "$(dirname "$jaeger_entrypoint")")"
skill_source="$jaeger_package_root/skills/jaeger-workflows"
test -f "$skill_source/SKILL.md"
```

On Windows:

```powershell
$JaegerPackageRoot = Join-Path $env:LOCALAPPDATA "Jaeger\node_modules\@peezy.tech\jaeger"
$SkillSource = Join-Path $JaegerPackageRoot "skills\jaeger-workflows"
if (-not (Test-Path (Join-Path $SkillSource "SKILL.md"))) {
  throw "Packaged Jaeger skill is missing"
}
```

If the invoking agent supports personal skills, install `skill_source` using
that harness's native skill mechanism. Conventional destinations are
`$CODEX_HOME/skills/jaeger-workflows` (falling back to
`$HOME/.codex/skills/jaeger-workflows`) for Codex and
`$HOME/.claude/skills/jaeger-workflows` for Claude Code, or
`$PI_CODING_AGENT_DIR/skills/jaeger-workflows` (falling back to
`$HOME/.pi/agent/skills/jaeger-workflows`) for Pi.

Do not overwrite an existing skill blindly. If the destination exists, compare
it with the packaged source. Leave an identical installation alone; for a
different user-managed copy, report the conflict and preserve it unless the
user authorizes replacement. If the harness has no skill mechanism, report the
absolute `skill_source` path; the CLI installation remains valid.

## 7. Prove the installed execution path

On Linux, run the provider-free packaged workflow through the persistent
backend, not through `pnpm jaeger` or embedded mode:

```bash
launch_result="$(
  jaeger run "$jaeger_package_root/examples/backend-smoke.js" \
    --cwd "$jaeger_package_root" --detach
)"
printf '%s\n' "$launch_result"
run_id="$(
  printf '%s' "$launch_result" |
    node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(0,"utf8")); if(!p.runId) process.exit(1); process.stdout.write(p.runId)'
)"
jaeger wait "$run_id"
```

The terminal run status must be `completed`, with a result containing
`"backend": "ok"`. Re-run `jaeger status --json` and confirm there are no active
workflows left behind.

On Windows, use the local packaged workflow source with an existing absolute
directory on the Linux target. The remote login directory is sufficient for the
provider-free smoke:

```powershell
$RemoteCwd = (ssh $SshProfile pwd).Trim()
if (-not $RemoteCwd.StartsWith("/")) { throw "Remote cwd is not an absolute POSIX path" }
$Launch = jaeger run (Join-Path $JaegerPackageRoot "examples\backend-smoke.js") `
  --cwd $RemoteCwd --detach | ConvertFrom-Json
$Launch | ConvertTo-Json -Depth 10
jaeger wait $Launch.runRef
jaeger status --json
```

The returned `runRef` must be qualified with the default runtime name. The
terminal result must contain `"backend": "ok"`, and the final status must show
the SSH target with no active workflow left behind.

Remove only the temporary clone and artifact directories created during this
procedure after all evidence has been collected. Never remove an existing user
checkout.

## Completion gate

Report success only when all of the following are true:

1. The exact source commit and tarball SHA-256 are recorded.
2. `command -v jaeger` and its resolved entrypoint identify the per-user
   installation.
3. The platform-appropriate verifier passed.
4. On Linux, the local backend is active, connected, admission-ready, and uses
   `systemd-user-scope`. On Windows, the selected remote backend proves those
   properties through `runtime doctor`.
5. On Linux, at least one native harness is available. On Windows, the selected
   remote runtime reports at least one available harness.
6. The installed-binary smoke workflow completed.
7. The packaged workflow skill was installed for the current harness, was
   already identical, or its preserved conflict/path was reported.
8. Existing Jaeger state and configuration were preserved.

For another controller platform, register a prepared Linux runtime without
copying credentials into Jaeger:

```bash
jaeger runtime add NAME --ssh SSH_HOST_PROFILE --default
jaeger runtime doctor NAME
```

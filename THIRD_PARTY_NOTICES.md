# Third-party notices

The MIT License in this repository applies to Jaeger Workflows source code. It
does not relicense dependencies, native harnesses, provider services, models,
plugins, or other third-party software.

The npm distribution includes the `@anthropic-ai/claude-agent-sdk` 0.3.220
runtime module under `dist/vendor/claude-agent-sdk`. Its package metadata,
README, and license notice are distributed beside the runtime module. The
package declares `SEE LICENSE IN README.md` and links to Anthropic's commercial
terms and privacy policy:

- https://github.com/anthropics/claude-agent-sdk-typescript
- https://www.anthropic.com/legal/commercial-terms
- https://www.anthropic.com/legal/privacy

Codex, Claude Code, Pi, and any custom harness are independently installed and
authenticated by the operator. Their availability and use are governed by
their respective licenses and service terms.

Installed npm dependencies retain their own package metadata and license files.
Review the lockfile, the installed dependency tree, and the vendored SDK
metadata for the exact revisions being distributed.

The optional bundled Discord source item declares Apache-2.0 dependencies
`discord.js` and `@discordjs/voice`, the MIT-licensed
`@node-webrtc-rust/sdk` headless WebRTC implementation, and the MIT-licensed
`opusscript` codec. The voice stack transitively includes the MIT-licensed
`@snazzah/davey` DAVE implementation.
They are installed only when the operator mounts that item into the private
runtime project. Discord and OpenAI are independent services governed by their
respective terms and privacy policies.

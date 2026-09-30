# common-auth

Shared libraries for the CortexKit auth plugins for OpenCode and Pi: openai-auth, anthropic-auth and antigravity-auth. Published on npm as `@cortexkit/common-auth`; each plugin bundles it at build time, so users never install it directly.

`research/` holds the spike reports that inform the design:

- [OpenCode 2 transport spike](research/opencode2-transport/REPORT.md): can a plugin own the transport on OpenCode 2?
- [OpenCode 2 native-driver spike](research/opencode2-thin/REPORT.md): multi-account support through hooks on OpenCode 2's built-in OpenAI driver.

Licensed under MIT; see [LICENSE](LICENSE).

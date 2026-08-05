# Contributing to opencode-vision-bridge

Thanks for your interest in improving vision-bridge! This is a tiny, zero-dependency
opencode plugin, so the contribution bar is low but the surface area is small.

## Reporting bugs

Open an issue and include:

1. Your opencode version — `opencode --version`
2. The model you were using (e.g. `opencode-go/deepseek-v4-flash`)
3. Relevant `[vision-bridge]` log lines — run with `VISION_BRIDGE_DEBUG=1`

## Suggesting features

Open an issue **first** to discuss the approach before sending a PR. The plugin is
intentionally minimal; new behavior should stay dependency-free and not break the
blacklist-only bridging model.

## Development

- Verify plugin syntax before committing:

  ```bash
  node --check plugins/vision-bridge.mjs
  ```

- Run the dependency-free smoke tests:

  ```bash
  npm test
  ```

- Keep it ESM and zero-dependency. New Node built-ins are fine; new npm packages are not.
- Match the existing code style (2-space indent, double quotes, no trailing semicolons).

## Pull requests

- Target the `main` branch.
- Keep PRs focused; describe the motivation and the manual test you ran.

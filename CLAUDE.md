# CLAUDE.md

Context for Claude Code when working with the mirrord VS Code extension.

## Quick Reference

```bash
# Install dependencies
npm install

# Build (webpack, output to dist/)
npm run compile

# Watch mode (incremental rebuilds)
npm run watch

# Lint
npm run lint

# Auto-fix lint issues
npm run format

# Package as .vsix
npm run package
```

## Overview

mirrord-vscode is a Visual Studio Code extension that integrates mirrord into the IDE. It intercepts debug/run configurations to inject mirrord environment variables, letting developers run local processes in the context of their Kubernetes cluster.

- **Extension ID:** MetalBear.mirrord
- **Language:** TypeScript (strict mode, ES2020 target, CommonJS)
- **Bundler:** Webpack (output: dist/extension.js)
- **Min VS Code:** 1.63.0
- **Current version:** Check package.json

## Architecture

**Activation:** `onStartupFinished` (lazy). Entry point: `src/extension.ts`.

**Key modules:**

| File | Purpose |
|------|---------|
| `extension.ts` | Activation, global setup, status bar initialization |
| `api.ts` | Wrapper around mirrord CLI binary (list targets, verify config, exec) |
| `debugger.ts` | Debug configuration provider, intercepts run configs, handles macOS SIP |
| `config.ts` | Config file parsing/validation (JSON, TOML, YAML), target detection |
| `binaryManager.ts` | Binary discovery (PATH, extension storage), download from GitHub releases |
| `status.ts` | Status bar button, command registration, toggle mirroring |
| `notification.ts` | NotificationBuilder fluent API for user messages |
| `targetQuickPick.ts` | Pod/target selection QuickPick UI |
| `versionCheck.ts` | Version checking against https://version.mirrord.dev |

**Flow:** User starts debug session -> `debugger.ts` intercepts -> calls `api.ts` to run mirrord CLI -> injects env vars (DYLD_INSERT_LIBRARIES on macOS, LD_PRELOAD on Linux) -> user process runs with mirrord.

## Code Style

- **TypeScript strict mode** enabled
- **Semicolons required** (enforced by ESLint @stylistic/semi)
- **ESLint** with flat config (`eslint.config.mjs`), includes @stylistic plugin
- No separate Prettier config; ESLint handles formatting
- Format via: `npm run format` (eslint --fix)
- Unused params: prefix with `_` (e.g., `_unused`)
- camelCase for functions/variables, PascalCase for types/classes

## Testing

- **Framework:** Mocha + Chai (unit), vscode-extension-tester (E2E)
- **Run:** `npm run test` (compiles, lints, then runs E2E)
- E2E tests use a real VS Code instance with the extension loaded
- Test workspace: `test-workspace/` (Python HTTP server)
- E2E requires: minikube, mirrord binary, Python 3.10

## Key Patterns

- **Global context:** `globalContext: ExtensionContext` exported from extension.ts, used by all modules
- **NotificationBuilder:** Fluent API with `.withMessage().withDisableAction().error()`, respects "Don't show again" settings
- **Config manager singleton:** `MirrordConfigManager.getInstance()`, emits change events
- **SIP handling (macOS):** Patches executables or uses DYLD_INSERT_LIBRARIES workaround in debugger.ts

## Settings (package.json contributes.configuration)

- `mirrord.enabledByDefault` (false) - Start with mirroring enabled
- `mirrord.binaryPath` (null) - Custom binary path
- `mirrord.autoUpdate` (true) - Auto-download updates
- `mirrord.prompt*` - 8 notification suppression flags

## Changelog

Uses **towncrier** for changelog management. Fragments in `changelog.d/` with naming: `<issue-number>.<type>` (types: added, changed, fixed, etc.). CI checks for fragment on every PR.

## CI/CD

- **ci.yaml:** towncrier check, lint, E2E tests
- **release.yaml:** On git tag, builds .vsix, publishes to VS Code Marketplace + Open VSX
- **Reusable E2E:** `reusable_e2e.yaml` (shared with main mirrord repo)

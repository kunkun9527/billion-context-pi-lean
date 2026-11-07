# Contributor guide (humans and agents)

This repository started as a fork of `billion-context-pi` v0.1.83 and is versioned on its own since 0.2.0; upstream fixes are ported as needed. Goals: stable for daily long Pi sessions, and as few tokens as possible (lean tool surface, cheap dedicated summary model). See [README.md](README.md) for what differs from upstream and [MAINTENANCE.md](MAINTENANCE.md) (Chinese) for implementation notes and the release flow.

## Layout

- `src/` — Pi adapter runtime (TypeScript, ESM). `npm run build` bundles it with `acp-kernel@0.0.101` into `dist/`.
- `lean/index.ts` — the facade Pi loads (`package.json` → `pi.extensions`). It imports `../dist/index.js`.
- `dist/` — committed build output. Pi installs git packages without building, so every source change ships with its rebuilt `dist/`; CI fails when they diverge.
- `tests/` (runtime), `lean/tests/` (facade). Upstream papers, devlogs and design docs were removed; see the upstream repo for them.

## Rules

- Run `npm run check` before committing; commit `dist/` together with the source change.
- Running one test file directly needs `--import ./tests/support/isolate-env.ts`, otherwise it writes to the real `~/.pi/acp.log`.
- Keep the resident prompt small: the facade's tool surface and prompt budget are asserted in `lean/tests/facade.test.mjs`. Grow them only with a measured reason.
- Dedicated-model call failures leave that range uncompressed; successful ranges in the batch still fold. When configuration/host limitations or no extractable content make the adapter use the caller summary instead, it must be meaningful; never store a placeholder.
- Upstream fixes are cherry-picked by hand (`git cherry-pick -x` when it applies) and noted in `MAINTENANCE.md`. Do not merge `upstream/master` wholesale.
- Published to npm as `billion-context-pi-lean`. Versions follow semver independently of upstream (`0.2.0`, `0.2.1`, …). A release is one commit on `main`: tag `v<version>`, GitHub release, `npm publish`; steps in `MAINTENANCE.md`.
- Record user-visible changes in `CHANGELOG.md` under the top Lean section.

# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13, "Merge pull request #45 from haydenbleasel/feat/group-singleline-bindings")
- Copied with the skill's installer (`skills/install-anti-slop/scripts/install.mjs`): the contents of `src/` without its `*.test.ts` files.
- Installed at `tools/oxlint/anti-slop/`, registered in `.oxlintrc.json` as the `anti-slop` JS plugin.
- Dependencies: `oxlint` and `@oxlint/plugins` pinned to the same exact version.

## Local deviations

- The Effect plugin (`effect/`) is copied but not registered: this project does not use Effect.
- `anti-slop/no-runtime-typeof` may be configured with `allowInTypeGuards` in `.oxlintrc.json`; see that file for the current policy.
- No changes to the rule sources.

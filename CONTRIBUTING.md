# Contributing

Issues and small fixes are welcome. Please open an issue before starting a large change.

`@bloxwap/smart-solana` is published to npm. A release needs Joe's approval: bump `version` in `packages/smart-solana/package.json`, then run `npm publish` from `packages/smart-solana`. `prepublishOnly` typechecks, tests, and builds `dist/` with declarations first. Tag the release commit `vX.Y.Z`.

## Development

Requires [Bun](https://bun.sh) 1.4.4 and Node.js 22.12 or newer.

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run build
```

`bun run check` is format, lint, and typecheck. Tests use `bun test` and do not call the public network. Live tests and benchmarks are manual because public providers enforce rate limits.

## Documentation

Run `bun dev` or `bun run docs:dev` for the documentation site at `http://localhost:3916`. Edit pages in `apps/docs/content/docs`; register new pages in `meta.json`. `bun run docs:build` writes the static GitHub Pages export to `apps/docs/out`.

## Package changes

Keep the published package free of runtime dependencies unless a capability cannot be implemented correctly in the transport. Solana client libraries used only for integration tests belong in `devDependencies`. Run `npm pack --dry-run` from `packages/smart-solana` before publishing and verify that the artifact contains only `dist`, `src`, `README.md`, `LICENSE`, and `package.json`.

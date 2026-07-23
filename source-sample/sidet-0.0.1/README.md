# Sidet source sample

This directory contains a frozen, reduced source placeholder derived from an early Sidet codebase. It is not the current Sidet source and does not reproduce the current product.

The sample only loads a notice, registers one command and ribbon action, and exposes one settings toggle. It contains no chat, AI, network, vault-writing, or private product workflow.

## Installation for local review

Use a separate test vault. Do not install this sample alongside a current Sidet build because both use the `sidet` plugin ID.

1. Install Node.js and npm.
2. Run `npm ci`.
3. Run `npm run verify`.
4. Create `<test-vault>/.obsidian/plugins/sidet/`.
5. Copy `dist/main.js`, `dist/manifest.json`, and `dist/styles.css` into that directory.
6. Restart the app and enable **Sidet** under **Settings → Community plugins**.

## Usage

- Select the message-circle ribbon icon to display the source-sample notice.
- Run **Show source sample notice** from the command palette for the same result.
- Open **Settings → Sidet** to control whether the notice appears after the workspace is ready.

## Development

- `npm run dev` builds a development bundle with an inline source map.
- `npm run build` creates a minified production bundle without a source map.
- `npm run verify` runs type checking, metadata validation, and the production build.

Generated files stay under `dist/` and are intentionally excluded from this frozen source inventory.

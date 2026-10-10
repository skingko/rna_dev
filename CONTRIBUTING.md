# Contributing

Thanks for taking an interest. Rna is an actively developed project; small, focused changes are
easiest to review.

## Set up

Node.js 22.19 or newer. The host (`prototypes/control-center`) and the SDK (`packages/sdk`) have no
runtime dependencies; the web UI and the desktop shell have their own `package.json`.

```bash
npm ci --prefix prototypes/control-center/web        # web UI
npm ci --prefix prototypes/control-center/desktop    # desktop shell (Electron)
npm ci --prefix prototypes/control-center            # terminal support (node-pty)
```

## Before you open a pull request

Tests run on your machine; the repository has no test workflow on GitHub. The only workflow builds and publishes releases.

```bash
(cd packages/sdk && node --test test/*.test.mjs)
(cd prototypes/control-center && node --test)
(cd prototypes/control-center/web && npm run typecheck && npm test)
```

A few host tests need local files that are not part of the repository and are skipped without them;
a few timing tests can fail under heavy load and pass when run alone.

## Conventions

- Every behavior change comes with a test that fails without it.
- User-facing text exists in both Chinese and English (`web/src/i18n/en/*.ts` holds the English
  dictionary; host error texts have English entries in `api-error-catalog/`).
- Text the model reads is English; replies follow the interface language.
- Add a line to the changelog at the end of `docs/specs/stream-protocol-v2.md` for an API or
  behavior change.
- **No key, token or credential ever goes into code, tests, docs or commits.** Tests use obviously
  synthetic values.
- See [AGENTS.md](AGENTS.md) for the conventions coding agents follow here, including how judgments
  are routed through the decision kernel.

## Reporting a problem

Open an issue with the version, your platform, what you did and what you expected. For anything that
touches credentials or the local service's exposure, use [SECURITY.md](SECURITY.md) instead.

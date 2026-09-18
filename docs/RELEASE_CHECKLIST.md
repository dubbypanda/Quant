# Release Checklist

Quant uses a local, deterministic release gate. No GitHub Actions workflow is required.

## Baseline

From a clean checkout:

```bash
npm ci
npm run verify
```

`npm run verify` must pass TypeScript checking, core regression tests, Signal Engine V2 regression tests, and the production build.

## Forecast Gate

When forecast functionality or packaging changes:

```bash
npm run check:forecast
```

Build the native forecast sidecar on the target operating system before packaging. PyInstaller does not cross-compile the supported sidecars.

## Runtime Smoke Tests

Run the smoke surfaces relevant to the change:

```bash
npm run smoke
npm run smoke:signals
npm run smoke:modal
npm run smoke:forecast
```

For signal changes, verify that sample/offline candles never appear in Signal Board rankings and that coverage reports unavailable names rather than silently substituting them.

## Package

On the native target:

```bash
npm run package:mac
# or
npm run package:win
```

Open the packaged application and verify the watchlist, Signal Board, chart modal, Signal Desk, and—when included—the forecast sidecar.

## Release Discipline

- Do not commit `dist/`, `release/`, sidecars, credentials, local market state, or user data.
- Keep the public Quant repository on stable 2.x behavior; experimental QuantDesktop work belongs in its separate repository.
- Update `CHANGELOG.md`, `RELEASE_NOTES.md`, `package.json`, and `package-lock.json` together for a versioned release.
- Create a public tag/release only after the local release gate and native package smoke test pass.

# macOS Signing And Notarization

This document lists the release-prep steps and environment variable names only. Do not commit secrets.

## Required Environment Variables

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `CSC_LINK` or an installed Developer ID Application certificate
- `CSC_KEY_PASSWORD`

## Internal Beta Unsigned Build

Use this for local/internal testing only:

```bash
npm run package:mac --workspace apps/desktop-recorder
```

## Signed And Notarized Build

1. Use Node 20+ on the signing machine.
2. Install or unlock the Developer ID Application certificate.
3. Export the required environment variables in the shell or CI secret store.
4. Confirm hardened runtime and entitlements stay enabled in `apps/desktop-recorder/electron-builder.json`.
5. Build:

```bash
npm run package:mac --workspace apps/desktop-recorder
```

## Verification

- Confirm both x64 and arm64 DMGs are produced.
- Confirm Gatekeeper accepts the DMG on a clean macOS account.
- Confirm Screen Recording and Microphone prompts still appear after signing.
- Confirm the app records, saves, recovers, and uploads after notarization.

## Release Evidence

- Commit hash:
- Build machine:
- Certificate identity:
- DMG filenames:
- Notarization result:
- Gatekeeper screenshot:
- Runtime smoke test result:

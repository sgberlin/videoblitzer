# Windows Signing

This document lists Windows signing setup and command flow for the desktop recorder. It includes environment variable names only.

## Required Environment Variables

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`
- `WINDOWS_PUBLISHER_NAME`

Use the variables that match the selected certificate provider and `electron-builder` setup. Do not commit certificate files or passwords.

## Internal Beta Unsigned Build

Use this for trusted internal testing:

```bash
npm run package:win --workspace apps/desktop-recorder
```

## Signed Build

1. Use Node 20+ on the release machine.
2. Provide the code-signing certificate through CI secrets or local environment variables.
3. Confirm `electron-builder.json` keeps the NSIS installer target.
4. Build:

```bash
npm run package:win --workspace apps/desktop-recorder
```

## Verification

- Confirm `VideoBlitzer-Recorder-win-x64.exe` is produced.
- Confirm Windows SmartScreen/signature details show the expected publisher after signing reputation is established.
- Install on a clean Windows device.
- Test screen capture, browser/window capture, system audio behavior, local save, recovery, upload, and WebM to MP4 conversion.

## Release Evidence

- Commit hash:
- Build machine:
- Certificate provider:
- Installer filename:
- Signature verification screenshot:
- Windows runtime QA result:

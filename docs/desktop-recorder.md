# VideoBlitzer Desktop Recorder

VideoBlitzer Recorder is an Electron app for local-first browser/window/screen recording, match workflows, markers, signed upload to VideoBlitzer, and backend MP4 conversion. It uses Electron context isolation with a preload bridge; cloud credentials are never exposed in the desktop app.

## Run Locally

```bash
npm install
npm --workspace @videoblitzer/desktop-recorder run build
npm --workspace @videoblitzer/desktop-recorder run dev
```

## Authentication

For the current MVP, sign in to `https://app.videoblitzer.com`, copy your Supabase access token from the browser auth session, and paste it into the recorder. The recorder sends it only as `Authorization: Bearer <token>` to the VideoBlitzer API.

## Recording Modes

- **Browser Recording**: records authorized browser windows, app windows, full screens, livestreams, meetings, gameplay, dashboards, and online sessions visible to the OS capture API.
- **Record Online Match**: uses the same capture engine but adds match metadata, permission audit data, live markers, and Match Intelligence planning.

Protected or DRM-restricted video/audio may appear black or muted depending on platform and OS restrictions. VideoBlitzer does not bypass DRM or protected content controls.

## Source Selection

The recorder lists Electron `desktopCapturer` sources with thumbnails. Sources are grouped as screens, windows, and browser windows where names suggest Chrome/Safari/Firefox/Edge/Brave/browser. Refresh sources if a window is missing.

## Audio Setup

Controls include:

- System audio toggle where OS/Electron/source allows it.
- Microphone toggle and microphone device selector.
- Audio status and meter before/during recording.

### macOS

Screen Recording permission is required in System Settings -> Privacy & Security -> Screen Recording. System audio capture is limited and may require a source that exposes audio or a virtual audio device. Protected platform audio may be muted.

### Windows

System audio support varies by source and Electron/Chromium capture behavior. If system audio is missing, try full-screen capture, a different window source, or microphone narration.

## Local-First Recording And Recovery

Recording always saves locally first. The app writes chunk files approximately every 30 seconds and maintains a JSON manifest with:

- session ID, mode, source label, created/completed timestamps
- chunks and local filenames
- duration estimate
- audio settings
- markers
- metadata and permission confirmation
- upload status

If the app crashes mid-recording, use **Recover recordings** to scan for unfinished manifests and merge readable chunks with FFmpeg. One bad chunk should not destroy the full recording.

## Metadata And Permission

Before recording, the user must confirm:

> I confirm that I own this content, am authorized to record it, or have permission to use it.

For match mode, optional metadata includes title, sport/game type, teams/players, league, source platform, URL, match date, and notes. Metadata is stored in the local manifest and sent to the API upload completion payload.

## Markers

Live marker buttons include Goal, Save, Foul, Key Moment, Start, End, and Custom Note. Markers are timestamped relative to the recording start, written to the manifest, and uploaded with the video metadata.

## Post-Recording

The result screen shows local path, duration estimate, file size, audio status, marker count, upload progress, project link, and MP4 conversion status where available. Upload failures do not delete local files; retry upload after fixing network/API/auth issues.

## Upload Retry And Resume Policy

The MVP uses a retry-safe local-first fallback, not true multipart resume. Every recording is saved locally before upload, and recovered/combined files can be re-read from disk for another signed PUT attempt. If a network failure or cancellation occurs, the local file and manifest remain on disk; request a fresh signed URL and retry the upload from the beginning.

True multipart resumable uploads remain a post-MVP requirement for very large files and unstable networks.

## Quick Clips

FFmpeg-backed local clip buttons create 15/30/60 second clips or clips around the latest marker. Clips are saved locally as MP4. Sentence-aware editing rules are represented in metadata: preserve full spoken sentences when transcript timestamps are available, add 1-3 second handles, and warn if exact manual cuts may interrupt a sentence.

## Combine Video + Audio

The Combine workflow accepts a video file and separate audio file, validates both through FFprobe where available, supports an audio offset, converts audio to AAC, preserves the video stream when compatible, and outputs MP4. The result can be uploaded through the same project pipeline.

## Admin Source Import

Source Import is admin/owner only and enforced by the backend. Supported flows are direct file upload, cloud storage URL, permitted direct media URL, existing local recording, and metadata-only inspection for YouTube/Vimeo/stream pages. The app does not implement arbitrary YouTube downloading, stream ripping, DRM bypassing, or protected content extraction.

## Captions And Transcripts

Caption generation remains a workflow hook until production caption endpoints are ready. The API now stores transcript segments, sentence boundaries, clip source sentence IDs, and manual override flags for sentence-aware editing.

## Manual QA Checklist

Status legend: `implemented` means code path exists; `manual` means requires OS/API credentials/FFmpeg verification.

1. Record full screen with mic off/on - implemented, manual verification required.
2. Record browser window with mic off/on - implemented, manual verification required.
3. Test system audio detection - implemented status/warnings, platform-dependent manual verification required.
4. Record 2+ minute chunked session - implemented chunking every ~30s, manual verification required.
5. Kill app mid-recording and recover - implemented recovery scan/merge, manual verification required.
6. Add markers during recording - implemented.
7. Upload recording to project - implemented existing signed upload flow with metadata.
8. Confirm MP4 conversion job starts - implemented existing API pipeline.
9. Confirm metadata stored - implemented via migration and upload payload.
10. Confirm markers stored - implemented via video metadata JSON.
11. Confirm failed upload can retry - implemented local-first retry surface.
12. Confirm local file remains after failed upload - implemented.
13. Confirm admin-only Source Import hidden from normal user - desktop shows surface, backend blocks unauthorized users; future UI can hide based on role.
14. Confirm backend blocks unauthorized Source Import - implemented.
15. Confirm direct file upload import works - existing upload path; import audit endpoint implemented.
16. Confirm direct media URL import works - audit/metadata validation implemented; downloader not implemented.
17. Confirm YouTube URL metadata-only behavior - implemented safe metadata-only response, no downloading.
18. Confirm protected/DRM warning appears - implemented in UI.

## Runtime QA Checklist For Release

Do not mark a release production-ready until these tests are run on real devices:

1. macOS screen recording: record full screen for 5 minutes, save locally, upload, confirm project video appears.
2. macOS window recording: record a browser window for 5 minutes, verify no black frame unless source is protected.
3. macOS system audio behavior: test with system audio off, requested, and with a known virtual audio path if needed; document whether audio is captured or blocked.
4. Windows screen recording: record full screen for 5 minutes, save locally, upload, confirm project video appears.
5. Windows window recording: record browser and app windows, verify source picker thumbnails and output.
6. Windows system audio behavior: test full-screen and window capture with source audio; document supported/unsupported cases.
7. 2+ hour recording: record at Studio quality, verify chunk manifest, final local file, disk usage, and no app crash.
8. Crash recovery: force quit mid-recording, reopen, recover unfinished session, play recovered file.
9. Recovered file upload: upload recovered file to a project, confirm signed URL, upload completion, analyze job, and conversion job if WebM.
10. FFmpeg clipping: create 15/30/60 second clips and clip around marker; verify playback and audio sync.
11. Video + audio combine: mux separate video/audio with positive and negative offsets; verify normalized MP4 output.
12. Worker conversion: confirm `export_jobs` transitions queued -> processing -> completed and MP4 appears in R2.
13. Failure path: temporarily break R2 or FFmpeg, confirm job status becomes failed and error is visible in admin jobs.

## Mac Signing And Notarization Checklist

1. Use Node 20+ on release machine.
2. Install Apple Developer ID Application certificate in the login keychain.
3. Set electron-builder notarization credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) or equivalent notarytool config.
4. Verify `apps/desktop-recorder/build/entitlements.mac.plist` is included and hardened runtime stays enabled.
5. Run `npm run package:mac --workspace apps/desktop-recorder`.
6. Confirm both `VideoBlitzer-Recorder-mac-x64.dmg` and `VideoBlitzer-Recorder-mac-arm64.dmg` are signed and notarized.
7. Download the DMG on a clean macOS account, launch it, and confirm Gatekeeper does not block it.
8. Re-test Screen Recording and Microphone permission prompts after signing/notarization.

## Worker Daemon

MP4 conversion is processed by the video worker daemon:

```bash
npm run daemon --workspace services/video-worker
```

On the VPS, run it with PM2 after `npm ci`:

```bash
pm2 start "npm run daemon --workspace services/video-worker" --name videoblitzer-video-worker --update-env
pm2 save
```

The worker requires `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME`. It loads `/var/www/videoblitzer-api/.env` by default.

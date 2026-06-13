# VideoBlitzer Release Candidate Runtime QA Checklist

Use this checklist for every private-beta release candidate. Attach evidence for each test before marking the item passed.

## Evidence Fields

- Tester:
- Date/time:
- App commit hash:
- Desktop recorder version:
- OS and version:
- Device model / CPU / RAM:
- Network:
- Test project URL:
- Source file path or R2 object key:
- Expected result:
- Actual result:
- Pass / fail:
- Evidence link or screenshot:
- Notes / follow-up issue:

## Test Cases

### 2+ Hour Recording

- Steps: Start a 2+ hour full-screen recording at the intended release quality. Add at least five markers. Stop and save locally.
- Expected: Recording completes without app crash, final local file plays, chunk manifest exists, markers are present, disk-space warnings did not appear unless disk was actually low.
- Evidence: screenshot of timer after 2+ hours, final file path, file size, manifest path, playback proof, marker count.

### Crash Recovery During Recording

- Steps: Start recording, wait for at least two chunks, force quit the app, reopen, scan recovery, recover the unfinished session.
- Expected: Unfinished session is listed, chunk count is visible, recovered file is created and playable.
- Evidence: recovery UI screenshot, recovered file path, playback proof, manifest JSON excerpt.

### Recovered Upload

- Steps: Upload a recovered recording to a new or existing project.
- Expected: Signed upload succeeds, video row appears, analyze job is queued, WebM sources queue MP4 conversion.
- Evidence: project URL, video ID, R2 raw object key, upload progress screenshot, job IDs.

### Windows Screen Recording

- Steps: On Windows, record full screen and a normal app window for at least five minutes each.
- Expected: Source picker shows screens/windows, output is not black, recording saves locally and plays.
- Evidence: Windows version, source picker screenshot, saved files, playback proof.

### Windows System Audio

- Steps: On Windows, enable system audio and record a source with audible playback.
- Expected: Audio is captured when the OS/source supports it. If unsupported, UI clearly states system audio was not detected and recording can continue video-only or mic-only.
- Evidence: audio waveform/playback proof, UI status screenshot, source type.

### macOS Screen Recording

- Steps: On macOS, record full screen and browser window after granting Screen Recording permission.
- Expected: Permission prompt appears as needed, source capture succeeds after permission grant/restart, output plays.
- Evidence: macOS version, permission settings screenshot, saved file path, playback proof.

### macOS Permissions

- Steps: Test with Screen Recording permission disabled, then enabled. Test microphone permission disabled, then enabled.
- Expected: Disabled permissions produce friendly actionable errors; enabled permissions allow capture/mic input.
- Evidence: error screenshot, System Settings screenshot, successful retry proof.

### MP4 Conversion After Desktop Upload

- Steps: Upload a WebM from the desktop recorder.
- Expected: `videos`, `export_jobs`, and mirrored `jobs` rows are created. Worker changes status from `queued` to `processing` to `completed`. MP4 appears in R2 and workspace shows completion.
- Evidence: project workspace URL, job IDs, R2 raw key, R2 MP4 key, PM2 worker log excerpt.

### Video + Separate Audio Combine

- Steps: Select a video file and separate audio file, test zero offset and non-zero offset, create combined MP4.
- Expected: Combined MP4 is saved locally, plays with expected sync, can be uploaded.
- Evidence: input file paths, offset, output path, playback proof.

### Marker-Based Clip Export

- Steps: Add markers while recording, create a clip around the latest marker, and create 15/30/60 second clips.
- Expected: Clip files are created, playable, named clearly, and preserve expected segment timing.
- Evidence: marker screenshot, clip paths, playback proof.

## Release Gate

Do not mark the product public production-ready until all required runtime tests pass on real macOS and Windows devices, including a 2+ hour recording.

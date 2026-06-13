# Private Beta Release Checklist

Complete this checklist before inviting private-beta users to a new release candidate.

## Release Identity

- Release date:
- Deploy commit hash:
- Git branch:
- Desktop recorder version:
- API host:
- Web app host:
- Supabase project:
- R2 bucket:

## Deployment Proof

- `git rev-parse --short HEAD` output:
- `npm ci` completed:
- `npm --workspace @videoblitzer/api run build` completed:
- `npm --workspace @videoblitzer/video-worker run build` completed:
- Vercel deploy URL:
- VPS deploy timestamp:

## PM2 Status

Run:

```bash
pm2 list
pm2 save
```

Evidence:

- `videoblitzer-api` status:
- `videoblitzer-video-worker` status:
- Process list screenshot or pasted output:

## Worker Status

Run:

```bash
pm2 logs videoblitzer-video-worker --lines 100 --nostream
```

Evidence:

- Worker polling log present:
- No schema-cache error:
- No R2 credential error:
- No FFmpeg error:

## Test Upload Proof

- Test project URL:
- Raw upload object key:
- Video ID:
- Upload completion response:
- Screenshot showing uploaded video in workspace:

## Conversion Proof

- Export job ID:
- Mirrored job ID:
- Status sequence observed: `queued -> processing -> completed`
- MP4 output key:
- R2 HeadObject or dashboard proof:
- Workspace screenshot showing completed conversion:

## Desktop Recorder Proof

- macOS package filename:
- Windows package filename:
- Recorder version:
- Internal beta unsigned or signed:
- Runtime QA checklist link:

## Known Limitations

- macOS system audio can be unavailable without source support or a virtual audio device.
- Windows system audio behavior depends on OS/source/Electron capture support.
- Protected or DRM-restricted content may record black or muted.
- True multipart resumable upload is not implemented; retry-safe local-first upload is the MVP fallback.
- Public production-ready status requires real-device 2+ hour recording and Windows runtime QA.

## Rollback

Replace `PREVIOUS_GOOD_COMMIT` before running:

```bash
cd /var/www/videoblitzer-api
git fetch origin main
git reset --hard PREVIOUS_GOOD_COMMIT
npm ci
npm --workspace @videoblitzer/api run build
npm --workspace @videoblitzer/video-worker run build
pm2 restart videoblitzer-api --update-env
pm2 restart videoblitzer-video-worker --update-env
pm2 save
```

## Log Check Commands

```bash
pm2 logs videoblitzer-api --lines 100 --nostream
pm2 logs videoblitzer-video-worker --lines 100 --nostream
curl -i https://api.videoblitzer.com/health
```

## Release Decision

- Private beta release approved:
- Public production-ready approved:
- Approver:
- Notes:

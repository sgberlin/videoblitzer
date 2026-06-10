# VideoBlitzer

VideoBlitzer is a private-beta AI video clipping and content-pack platform for turning match recordings into highlights, Shorts, captions, thumbnails, stats, and ready-to-post social packages.

## Product URLs

- Marketing: `https://videoblitzer.com`
- App: `https://app.videoblitzer.com`
- API: `https://api.videoblitzer.com`
- Footer identity: Powered by Lordan Labs
- Owner email: `gizlenweb@gmail.com`

## Monorepo Layout

- `apps/marketing-site` - public Next.js marketing site.
- `apps/web-app` - private-beta Next.js application.
- `apps/desktop-recorder` - Electron recorder scaffold.
- `services/api` - Express API for auth checks, projects, uploads, jobs, billing, contact, and generation endpoints.
- `services/video-worker` - video processing worker scaffold with FFmpeg command builders.
- `services/ai-worker` - OpenAI-backed content generation scaffold.
- `packages/*` - shared domain types, presets, highlight logic, stats logic, thumbnail templates, and prompts.
- `infra/*` - deployment notes, Vercel targets, and Nginx sample config.
- `docs/*` - product manual, privacy, terms, and about content.

## Setup

```bash
npm install
cp .env.example .env
npm run dev:api
npm run dev:web
npm run dev:marketing
```

Create workspace-specific env files from each `.env.example` before running production-like flows. Never expose `SUPABASE_SECRET_KEY`, R2 secret keys, OpenAI keys, or Stripe secrets in frontend code.

## Root Scripts

```json
{
  "dev:web": "npm --workspace apps/web-app run dev",
  "dev:marketing": "npm --workspace apps/marketing-site run dev",
  "dev:api": "npm --workspace services/api run dev",
  "build": "npm run build --workspaces",
  "lint": "npm run lint --workspaces"
}
```

## Supabase

Run SQL in `services/api/supabase/migrations` against the `videoblitzer-prod` project, then run `services/api/supabase/seed.sql` to add the owner allowlist row, plan, and profile bootstrap data. RLS is enabled for user-owned tables and owner administration is handled server-side by the API.

## Storage

Cloudflare R2 bucket: `videoblitzer-videos`. Uploads use signed URLs created by the API. Browser clients must never upload videos through Vercel serverless payloads and must never receive secret keys.

## Current Milestone

The first build milestone includes a marketing landing page, OTP login UI, server-side allowlist check, owner unlimited role model, dashboard, project creation, upload UI, project workspace tabs, placeholder social and thumbnail generators, API health check, content/legal pages, and owner-only allowed users management UI.

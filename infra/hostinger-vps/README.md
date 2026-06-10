# Hostinger VPS API Deployment

These steps replace the old test `server.js` process with the real compiled `services/api` app at `/var/www/videoblitzer-api`.

## 1. Build From Repo Root

Run this from the repository root before deploying:

```bash
npm install
npm --workspace @videoblitzer/api run build
```

This creates the real API entrypoint:

```text
services/api/dist/server.js
```

## 2. Deploy Files To VPS

Recommended method: keep the repo on the VPS and pull updates.

```bash
ssh root@YOUR_VPS_IP
mkdir -p /var/www/videoblitzer-api
cd /var/www/videoblitzer-api
```

First deploy:

```bash
git clone https://github.com/sgberlin/videoblitzer.git .
```

Later deploys:

```bash
cd /var/www/videoblitzer-api
git pull origin main
```

Alternative upload method: upload the full repository contents to `/var/www/videoblitzer-api`, including:

```text
apps/
docs/
infra/
packages/
services/
package.json
package-lock.json
tsconfig.base.json
```

Do not overwrite `/var/www/videoblitzer-api/.env`.

## 3. Keep Server Env File In Place

The API loads server env vars from:

```text
/var/www/videoblitzer-api/.env
```

That file should contain server-only values such as:

```bash
APP_NAME=VideoBlitzer
APP_URL=https://app.videoblitzer.com
API_URL=https://api.videoblitzer.com
OWNER_EMAIL=gizlenweb@gmail.com
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
R2_BUCKET_NAME=videoblitzer-videos
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_ENDPOINT=...
PORT=8080
```

R2 credentials must stay only on the VPS/API server. Do not add R2 credentials to Vercel or frontend environment variables.

## 4. Install And Build On VPS

On the VPS:

```bash
cd /var/www/videoblitzer-api
npm ci
npm --workspace @videoblitzer/api run build
npm prune --omit=dev
```

`npm ci` installs build dependencies, `npm --workspace @videoblitzer/api run build` creates `services/api/dist/server.js`, and `npm prune --omit=dev` leaves production dependencies for runtime.

## 5. Replace Old PM2 Test Process

Check existing PM2 processes:

```bash
pm2 list
```

If the old test process exists, delete it:

```bash
pm2 delete videoblitzer-api
```

If the old process has a different name, delete that name or id:

```bash
pm2 delete OLD_PROCESS_NAME_OR_ID
```

Start the real compiled API:

```bash
cd /var/www/videoblitzer-api
pm2 start services/api/dist/server.js --name videoblitzer-api --update-env
pm2 save
```

Useful checks:

```bash
pm2 logs videoblitzer-api
pm2 describe videoblitzer-api
```

The PM2 script path should be:

```text
/var/www/videoblitzer-api/services/api/dist/server.js
```

It should not point to the old test `server.js`.

## 6. Nginx Target

Nginx should proxy `api.videoblitzer.com` to the API port, normally `8080`:

```nginx
proxy_pass http://127.0.0.1:8080;
```

Reload Nginx after changes:

```bash
nginx -t
systemctl reload nginx
```

## 7. Verify Deployment

Health should return JSON from the real API:

```bash
curl -i https://api.videoblitzer.com/health
```

Expected shape:

```json
{"ok":true,"service":"videoblitzer-api","product":"VideoBlitzer"}
```

Storage metadata should return `401 Unauthorized` without a Supabase JWT, or JSON when called with a valid JWT:

```bash
curl -i https://api.videoblitzer.com/storage/metadata
```

Acceptable unauthenticated result:

```json
{"error":"Unauthorized"}
```

Authenticated check:

```bash
curl -i https://api.videoblitzer.com/storage/metadata \
  -H "Authorization: Bearer YOUR_SUPABASE_ACCESS_TOKEN"
```

Expected authenticated shape:

```json
{
  "metadata": {
    "configured": true,
    "bucket": "videoblitzer-videos",
    "totalObjects": 0,
    "totalBytes": 0,
    "rawFiles": 0,
    "exports": 0,
    "thumbnails": 0,
    "captions": 0
  }
}
```

If either endpoint returns `VideoBlitzer API running`, PM2 is still running the old test server. Delete that PM2 process and start `services/api/dist/server.js` as shown above.

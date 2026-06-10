# Hostinger VPS Deployment Notes

Deploy `services/api`, `services/video-worker`, and optionally `services/ai-worker` to the VPS. Use Node LTS, install dependencies with `npm ci`, provide production env vars, and run the API behind Nginx at `api.videoblitzer.com`.

Recommended process manager: systemd or pm2. Keep R2, Supabase secret, OpenAI, and Stripe keys only on the server.

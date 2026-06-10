# VideoBlitzer Product Manual

## Upload Video
Use Upload Existing Video for `mp4`, `mov`, `mkv`, and `webm`. The app requests a signed Cloudflare R2 URL from the API, uploads directly to storage, then records the video against the project.

## Record With Desktop App
The desktop recorder scaffold supports source selection, audio settings, recording settings, replay buffer, hotkeys, local recordings, dashboard upload, and settings. Native capture will be added after the scaffold milestone.

## Confirm Stats
Every stat includes value, source, confidence, and confirmed state. AI may summarize confirmed data but must not invent coaches, squads, scores, goal scorers, cards, possession, or other stats.

## Highlight Detection
Highlight candidates can come from manual markers, audio spikes, mic reactions, scoreboard changes, replay scenes, scene changes, post-match stats, and user-confirmed events.

## Create Shorts
Choose a 9:16 preset and crop mode. Ball-follow and action-follow are structured now as placeholders for future tracking logic.

## Generate Thumbnails
Choose a template and size. Review the checklist for readable text, strong action frame, visible team colors, score/hook, mobile readability, and too-much-text warnings.

## Commentary
Commentary scripts are generated from confirmed events and timeline notes only. Missing fields are omitted or marked not provided.

## Social Packs
Social packs include YouTube title variants, description, chapters, pinned comment, TikTok caption, Instagram caption, X post, hashtags, thumbnail text options, posting strategy, and multi-language variants.

## Credits
Owner bypasses all credit deductions. Standard examples: upload/analyze video 10, 3-minute highlight export 20, Shorts export 15, commentary cut 25, thumbnail pack 5, social content pack 5, caption generation 10.

## Troubleshooting
Check failed jobs, upload status, R2 configuration, Supabase environment variables, and API health at `https://api.videoblitzer.com/health`.

## System Requirements
Modern browser for the web app. Desktop recorder requirements will be finalized with native capture support.

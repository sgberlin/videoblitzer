import { AI_SYSTEM_INSTRUCTION } from "@videoblitzer/prompts";

export interface ConfirmedProjectData { title?: string; teams?: string[]; score?: string; keyMoments?: string[]; language?: string; }

function clean(data: ConfirmedProjectData) { return { title: data.title ?? "VideoBlitzer project", teams: data.teams ?? [], score: data.score, keyMoments: data.keyMoments ?? [], language: data.language ?? "English" }; }

export function generateTitleVariants(data: ConfirmedProjectData) { const d = clean(data); return [`${d.title} Highlights`, `${d.teams.join(" vs ") || d.title} Key Moments`, `${d.title} Match Package`]; }
export function generateYouTubeDescription(data: ConfirmedProjectData) { const d = clean(data); return [`${d.title} packaged with confirmed match data only.`, d.score ? `Final score: ${d.score}` : "", d.keyMoments.length ? `Key moments: ${d.keyMoments.join(", ")}` : ""].filter(Boolean).join("\n"); }
export function generateChapters(data: ConfirmedProjectData) { return clean(data).keyMoments.map((moment, index) => `00:${String(index * 15).padStart(2, "0")} ${moment}`); }
export function generatePinnedComment() { return "Which confirmed moment changed the match?"; }
export function generateTikTokCaption(data: ConfirmedProjectData) { return `${clean(data).title} clipped for vertical highlights.`; }
export function generateInstagramCaption(data: ConfirmedProjectData) { return `${clean(data).title} highlights, captions, and match story ready to publish.`; }
export function generateXPost(data: ConfirmedProjectData) { return `${clean(data).title}: confirmed highlights and key moments packaged by VideoBlitzer.`; }
export function generateHashtags() { return ["#VideoBlitzer", "#MatchHighlights", "#SportsContent"]; }
export function generateThumbnailText(data: ConfirmedProjectData) { const d = clean(data); return ["MATCH HIGHLIGHTS", d.score ? d.score : "KEY MOMENTS", "ALL ACTION"]; }
export function generateCommentaryScript(data: ConfirmedProjectData) { return `Commentary draft for ${clean(data).title}. Only confirmed events should be narrated.`; }
export function generateMatchStory(data: ConfirmedProjectData) { return `${clean(data).title} story built from confirmed timeline and match data.`; }
export function generatePostingStrategy() { return "Publish the 16:9 highlight reel first, then schedule vertical cuts around the highest-confidence confirmed moments."; }
export function translateContentPack(pack: Record<string, unknown>, language: string) { return { language, pack, note: "Translation placeholder. Preserve factual constraints and omit missing data." }; }
export { AI_SYSTEM_INSTRUCTION };

console.log("VideoBlitzer AI worker ready");

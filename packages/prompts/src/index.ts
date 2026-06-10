export const AI_SYSTEM_INSTRUCTION = "Use only confirmed match/project data. Do not invent coaches, squads, scores, goal scorers, cards, possession, or statistics. If a field is missing, omit it. Write clear, platform-ready copy.";

export const socialPackPrompt = `${AI_SYSTEM_INSTRUCTION}
Generate platform-specific copy for YouTube, TikTok, Instagram, X, hashtags, thumbnail text options, chapters, pinned comment, and posting strategy.`;

export const commentaryPrompt = `${AI_SYSTEM_INSTRUCTION}
Write commentary that reflects only confirmed events and avoids unsupported factual claims.`;

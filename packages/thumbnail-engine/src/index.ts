export type ThumbnailTemplate = "Full Match Highlights" | "All Goals" | "Comeback" | "Last-Minute Winner" | "Tactical Breakdown" | "Shorts Cover" | "Reaction Cut";
export type ThumbnailSize = "YouTube 1280x720" | "Shorts 1080x1920" | "Square 1080x1080";

export const thumbnailTemplates: ThumbnailTemplate[] = ["Full Match Highlights", "All Goals", "Comeback", "Last-Minute Winner", "Tactical Breakdown", "Shorts Cover", "Reaction Cut"];
export const thumbnailSizes: Record<ThumbnailSize, { width: number; height: number }> = {
  "YouTube 1280x720": { width: 1280, height: 720 },
  "Shorts 1080x1920": { width: 1080, height: 1920 },
  "Square 1080x1080": { width: 1080, height: 1080 },
};

export const thumbnailQualityChecklist = [
  "Large readable text",
  "Strong player/action frame",
  "Team colors visible",
  "Score or hook included",
  "Mobile readability",
  "Too much text warning",
] as const;

export function buildThumbnailBrief(template: ThumbnailTemplate, teamColors: string[], initials: string[]) {
  return {
    template,
    visualIdentity: "Team colors + initials + player/game frames",
    teamColors,
    initials,
    checklist: thumbnailQualityChecklist,
  };
}

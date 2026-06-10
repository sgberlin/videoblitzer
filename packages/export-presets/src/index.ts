export type CropMode = "center" | "scoreboard_safe" | "action_follow" | "ball_follow" | "facecam_gameplay" | "manual";
export type OutputFormat = "16:9 YouTube" | "9:16 Shorts/Reels/TikTok" | "1:1 Square" | "4:5 Instagram Feed" | "Custom";

export interface ExportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  aspectRatio: string;
  target: string;
  videoCodec: "h264";
  audioCodec: "aac";
  defaultCropMode: CropMode;
}

export const cropModes: Record<CropMode, string> = {
  center: "Center Crop",
  scoreboard_safe: "Scoreboard Safe",
  action_follow: "Action Follow",
  ball_follow: "Ball Follow",
  facecam_gameplay: "Facecam + Gameplay",
  manual: "Manual Crop",
};

export const exportPresets: ExportPreset[] = [
  { id: "youtube_16_9_1080p", label: "YouTube 16:9 1080p", width: 1920, height: 1080, aspectRatio: "16:9", target: "YouTube", videoCodec: "h264", audioCodec: "aac", defaultCropMode: "scoreboard_safe" },
  { id: "youtube_16_9_1440p", label: "YouTube 16:9 1440p", width: 2560, height: 1440, aspectRatio: "16:9", target: "YouTube", videoCodec: "h264", audioCodec: "aac", defaultCropMode: "scoreboard_safe" },
  { id: "shorts_9_16_1080x1920", label: "Shorts 9:16", width: 1080, height: 1920, aspectRatio: "9:16", target: "YouTube Shorts", videoCodec: "h264", audioCodec: "aac", defaultCropMode: "action_follow" },
  { id: "reels_9_16_1080x1920", label: "Reels 9:16", width: 1080, height: 1920, aspectRatio: "9:16", target: "Instagram Reels", videoCodec: "h264", audioCodec: "aac", defaultCropMode: "action_follow" },
  { id: "tiktok_9_16_1080x1920", label: "TikTok 9:16", width: 1080, height: 1920, aspectRatio: "9:16", target: "TikTok", videoCodec: "h264", audioCodec: "aac", defaultCropMode: "action_follow" },
  { id: "square_1_1_1080", label: "Square 1:1", width: 1080, height: 1080, aspectRatio: "1:1", target: "Social Feed", videoCodec: "h264", audioCodec: "aac", defaultCropMode: "center" },
  { id: "instagram_4_5", label: "Instagram 4:5", width: 1080, height: 1350, aspectRatio: "4:5", target: "Instagram Feed", videoCodec: "h264", audioCodec: "aac", defaultCropMode: "center" },
  { id: "archive_master", label: "Archive Master", width: 1920, height: 1080, aspectRatio: "source", target: "Archive", videoCodec: "h264", audioCodec: "aac", defaultCropMode: "manual" },
];

export const PRODUCT = {
  name: "VideoBlitzer",
  domain: "videoblitzer.com",
  appUrl: "https://app.videoblitzer.com",
  apiUrl: "https://api.videoblitzer.com",
  ownerEmail: "gizlenweb@gmail.com",
  poweredBy: "Lordan Labs",
} as const;

export type UserRole = "owner" | "admin" | "member";
export type PlanKey = "owner_unlimited" | "starter_weekly" | "creator_weekly" | "pro_weekly";
export type JobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
export type OutputStatus = "not_started" | "ready" | "processing" | "complete" | "failed";
export type ConfidenceLabel = "User Confirmed" | "High" | "Medium" | "Low" | "Derived";
export type StatSource = "user_confirmed" | "ocr_post_match_screen" | "espn_connector_placeholder" | "manual_entry" | "ai_derived";
export type SocialLanguage = "English" | "Spanish" | "Portuguese" | "Turkish" | "German" | "French" | "Arabic";

export interface AllowedUser {
  id: string;
  email: string;
  role: UserRole;
  planKey: PlanKey;
  isUnlimited: boolean;
  isSuspended: boolean;
}

export interface Profile {
  id: string;
  email: string;
  displayName?: string;
  role: UserRole;
  planKey: PlanKey;
  isUnlimited: boolean;
}

export interface Project {
  id: string;
  ownerId: string;
  title: string;
  homeTeam?: string;
  awayTeam?: string;
  status: "draft" | "uploaded" | "analyzing" | "ready" | "exporting" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface VideoRecord {
  id: string;
  projectId: string;
  ownerId: string;
  filename: string;
  mimeType: "video/mp4" | "video/quicktime" | "video/x-matroska" | "video/webm";
  storageKey: string;
  durationSeconds?: number;
  sizeBytes?: number;
}

export interface MatchStat<T = string | number | boolean | string[]> {
  value: T;
  source: StatSource;
  confidence: ConfidenceLabel;
  confirmed: boolean;
}

export interface MatchData {
  projectId: string;
  teams: MatchStat<string[]>;
  teamColors: MatchStat<string[]>;
  teamShortCodes: MatchStat<string[]>;
  score: MatchStat<string>;
  coach: MatchStat<string>;
  formation: MatchStat<string>;
  startingXi: MatchStat<string[]>;
  bench: MatchStat<string[]>;
  captain: MatchStat<string>;
  venue: MatchStat<string>;
  date: MatchStat<string>;
  competition: MatchStat<string>;
  possession: MatchStat<string>;
  shots: MatchStat<number>;
  shotsOnTarget: MatchStat<number>;
  corners: MatchStat<number>;
  fouls: MatchStat<number>;
  cards: MatchStat<string[]>;
  passAccuracy: MatchStat<string>;
  xg: MatchStat<number>;
  goalScorers: MatchStat<string[]>;
  goalTimes: MatchStat<string[]>;
  keyMoments: MatchStat<string[]>;
}

export interface HighlightCandidate {
  id: string;
  projectId: string;
  startTime: number;
  endTime: number;
  eventTime: number;
  label: string;
  confidence: ConfidenceLabel;
  importanceScore: number;
  signals: string[];
}

export interface SocialContentBlock {
  id: string;
  label: string;
  copy: string;
  language: SocialLanguage;
}

export interface SocialPackage {
  projectId: string;
  titleVariants: SocialContentBlock[];
  youtubeDescription: SocialContentBlock;
  chapters: SocialContentBlock;
  pinnedComment: SocialContentBlock;
  tiktokCaption: SocialContentBlock;
  instagramCaption: SocialContentBlock;
  xPost: SocialContentBlock;
  hashtags: SocialContentBlock;
  thumbnailTextOptions: SocialContentBlock[];
  postingStrategy: SocialContentBlock;
}

export interface CreditCost {
  action: string;
  credits: number;
}

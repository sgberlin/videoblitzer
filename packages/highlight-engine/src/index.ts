import type { ConfidenceLabel, HighlightCandidate } from "@videoblitzer/shared-types";

export type HighlightSignal = "manual_marker" | "audio_spike" | "mic_reaction" | "scoreboard_change" | "replay_scene" | "scene_change" | "post_match_stats" | "user_confirmed_event";

export const signalScores: Record<HighlightSignal, number> = {
  manual_marker: 80,
  audio_spike: 40,
  mic_reaction: 60,
  scoreboard_change: 90,
  replay_scene: 50,
  scene_change: 10,
  post_match_stats: 20,
  user_confirmed_event: 100,
};

export interface CandidateInput {
  id: string;
  projectId: string;
  eventTime: number;
  label: string;
  signals: HighlightSignal[];
  isGoalMarker?: boolean;
  isLateGame?: boolean;
}

export function scoreHighlight(input: CandidateInput): number {
  const signalTotal = input.signals.reduce((sum, signal) => sum + signalScores[signal], 0);
  const goalBonus = input.isGoalMarker ? 100 : 0;
  const lateBonus = input.isLateGame ? 25 : 0;
  return signalTotal + goalBonus + lateBonus;
}

export function confidenceFromScore(score: number): ConfidenceLabel {
  if (score >= 140) return "High";
  if (score >= 80) return "Medium";
  return "Low";
}

export function createHighlightCandidate(input: CandidateInput): HighlightCandidate {
  const importanceScore = scoreHighlight(input);
  return {
    id: input.id,
    projectId: input.projectId,
    startTime: Math.max(0, input.eventTime - 12),
    endTime: input.eventTime + 18,
    eventTime: input.eventTime,
    label: input.label,
    confidence: confidenceFromScore(importanceScore),
    importanceScore,
    signals: input.signals,
  };
}

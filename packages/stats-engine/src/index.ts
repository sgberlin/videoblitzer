import type { ConfidenceLabel, MatchStat, StatSource } from "@videoblitzer/shared-types";

export interface SportsDataConnector {
  id: string;
  label: string;
  fetchMatchData(matchId: string): Promise<Record<string, unknown>>;
}

export class EspnConnectorPlaceholder implements SportsDataConnector {
  id = "espn_connector_placeholder";
  label = "ESPN Connector Placeholder";

  async fetchMatchData(): Promise<Record<string, unknown>> {
    return { status: "not_configured", message: "ESPN is optional and must not be the only source of truth." };
  }
}

export function confidenceForSource(source: StatSource, confirmed = false): ConfidenceLabel {
  if (confirmed || source === "user_confirmed") return "User Confirmed";
  if (source === "manual_entry") return "High";
  if (source === "ocr_post_match_screen") return "Medium";
  if (source === "espn_connector_placeholder") return "Medium";
  return "Derived";
}

export function createStat<T>(value: T, source: StatSource, confirmed = false): MatchStat<T> {
  return { value, source, confirmed, confidence: confidenceForSource(source, confirmed) };
}

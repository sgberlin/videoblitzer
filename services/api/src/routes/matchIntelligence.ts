import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { requireAuth } from "../middleware/auth";

export type MatchProvider = "api-football" | "sportradar" | "espn" | "manual";

export interface NormalizedMatchEvent {
  id: string;
  minute: number;
  stoppageMinute?: number;
  period: "first_half" | "second_half" | "extra_time" | "penalties" | "unknown";
  team?: string;
  player?: string;
  assistingPlayer?: string;
  eventType: string;
  description: string;
  source: MatchProvider;
  confidence: "high" | "medium" | "low" | "manual";
  importanceScore: number;
}

const requestSchema = z.object({
  sport: z.literal("Soccer").default("Soccer"),
  league: z.string().optional(),
  teamA: z.string().optional(),
  teamB: z.string().optional(),
  matchDate: z.string().optional(),
  matchUrl: z.string().url().optional().or(z.literal("")),
  provider: z.enum(["API-Football", "Sportradar", "ESPN fallback", "Manual entry"]).default("API-Football"),
  manualEvents: z.array(z.object({ minute: z.number(), stoppageMinute: z.number().optional(), eventType: z.string(), team: z.string().optional(), player: z.string().optional(), note: z.string().optional(), importance: z.number().optional() })).default([]),
});

export const matchIntelligenceRouter = Router();
matchIntelligenceRouter.use(requireAuth);

function providerKey(provider: string): MatchProvider {
  if (provider === "API-Football") return "api-football";
  if (provider === "Sportradar") return "sportradar";
  if (provider === "ESPN fallback") return "espn";
  return "manual";
}

function periodForMinute(minute: number): NormalizedMatchEvent["period"] {
  if (minute <= 45) return "first_half";
  if (minute <= 90) return "second_half";
  if (minute <= 120) return "extra_time";
  return "unknown";
}

export function importanceForEvent(eventType: string) {
  const key = eventType.toLowerCase();
  if (key.includes("goal")) return 10;
  if (key.includes("red")) return 9;
  if (key.includes("penalty")) return 9;
  if (key.includes("var") && (key.includes("overturn") || key.includes("cancel"))) return 8;
  if (key.includes("big chance")) return 8;
  if (key.includes("shot on target")) return 6;
  if (key.includes("tactical")) return 6;
  if (key.includes("yellow")) return 5;
  if (key.includes("substitution")) return 4;
  return 3;
}

function normalizeEvent(input: { id?: string; minute: number; stoppageMinute?: number; team?: string; player?: string; assistingPlayer?: string; eventType: string; description?: string; source: MatchProvider; confidence: NormalizedMatchEvent["confidence"]; importanceScore?: number; }): NormalizedMatchEvent {
  return {
    id: input.id ?? crypto.randomUUID(),
    minute: input.minute,
    stoppageMinute: input.stoppageMinute,
    period: periodForMinute(input.minute),
    team: input.team,
    player: input.player,
    assistingPlayer: input.assistingPlayer,
    eventType: input.eventType,
    description: input.description ?? [input.team, input.player, input.eventType].filter(Boolean).join(" - "),
    source: input.source,
    confidence: input.confidence,
    importanceScore: input.importanceScore ?? importanceForEvent(input.eventType),
  };
}

function manualTimeline(events: z.infer<typeof requestSchema>["manualEvents"]): NormalizedMatchEvent[] {
  return events.map((event) => normalizeEvent({ minute: event.minute, stoppageMinute: event.stoppageMinute, team: event.team, player: event.player, eventType: event.eventType, description: event.note, source: "manual", confidence: "manual", importanceScore: event.importance }));
}

function includesTeam(name: string | undefined, query: string | undefined) {
  return Boolean(name && query && name.toLowerCase().includes(query.toLowerCase().trim()));
}

function apiFootballHeaders() {
  return { "x-apisports-key": config.API_FOOTBALL_KEY ?? "" };
}

async function fetchApiFootballTimeline(body: z.infer<typeof requestSchema>) {
  if (!config.API_FOOTBALL_KEY) {
    return { events: [] as NormalizedMatchEvent[], stats: null, fixture: null, warning: "API-Football key is not configured on the API server." };
  }
  if (!body.matchDate || !body.teamA || !body.teamB) {
    return { events: [] as NormalizedMatchEvent[], stats: null, fixture: null, warning: "Match date, Team A, and Team B are required for API-Football lookup." };
  }

  const fixturesResponse = await fetch(`https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(body.matchDate)}`, { headers: apiFootballHeaders() });
  if (!fixturesResponse.ok) throw new Error(`API-Football fixture lookup failed with ${fixturesResponse.status}`);
  const fixturesJson = await fixturesResponse.json() as { response?: Array<{ fixture: { id: number; date: string }; league?: { name: string }; teams: { home: { name: string }; away: { name: string } }; goals?: { home: number | null; away: number | null }; score?: unknown }> };
  const fixture = (fixturesJson.response ?? []).find((item) => {
    const teamsMatch = (includesTeam(item.teams.home.name, body.teamA) && includesTeam(item.teams.away.name, body.teamB)) || (includesTeam(item.teams.home.name, body.teamB) && includesTeam(item.teams.away.name, body.teamA));
    const leagueMatch = !body.league || item.league?.name.toLowerCase().includes(body.league.toLowerCase().trim());
    return teamsMatch && leagueMatch;
  });
  if (!fixture) return { events: [] as NormalizedMatchEvent[], stats: null, fixture: null, warning: "No matching fixture found from API-Football. Use Manual entry or refine teams/date." };

  const [eventsResponse, statsResponse] = await Promise.all([
    fetch(`https://v3.football.api-sports.io/fixtures/events?fixture=${fixture.fixture.id}`, { headers: apiFootballHeaders() }),
    fetch(`https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixture.fixture.id}`, { headers: apiFootballHeaders() }),
  ]);
  if (!eventsResponse.ok) throw new Error(`API-Football event lookup failed with ${eventsResponse.status}`);
  const eventsJson = await eventsResponse.json() as { response?: Array<{ time?: { elapsed?: number; extra?: number }; team?: { name?: string }; player?: { name?: string }; assist?: { name?: string }; type?: string; detail?: string; comments?: string | null }> };
  const statsJson = statsResponse.ok ? await statsResponse.json() : null;

  const events = (eventsJson.response ?? []).map((event) => {
    const detail = [event.type, event.detail].filter(Boolean).join(" - ") || "Match event";
    return normalizeEvent({
      minute: event.time?.elapsed ?? 0,
      stoppageMinute: event.time?.extra,
      team: event.team?.name,
      player: event.player?.name,
      assistingPlayer: event.assist?.name,
      eventType: detail,
      description: `${detail}${event.comments ? ` (${event.comments})` : ""}`,
      source: "api-football",
      confidence: "high",
    });
  });

  return { events, stats: statsJson?.response ?? null, fixture: { id: fixture.fixture.id, league: fixture.league?.name, home: fixture.teams.home.name, away: fixture.teams.away.name, goals: fixture.goals, score: fixture.score }, warning: null };
}

function generatedOutputs(events: NormalizedMatchEvent[]) {
  const important = [...events].sort((a, b) => b.importanceScore - a.importanceScore).slice(0, 8);
  return {
    markerTimeline: important.map((event) => `${event.minute}${event.stoppageMinute ? `+${event.stoppageMinute}` : "'"} ${event.eventType}: ${event.team ?? ""} ${event.player ?? ""}`.trim()),
    commentaryOutline: important.map((event) => `At ${event.minute}', explain the context around ${event.eventType}${event.player ? ` involving ${event.player}` : ""}.`),
    suggestedClips: important.map((event) => ({ title: `${event.eventType} at ${event.minute}'`, hook: event.description, importanceScore: event.importanceScore })),
    titleIdeas: important.slice(0, 3).map((event) => `${event.team ?? "Match"} ${event.eventType} Changed The Game`),
    captionIdeas: important.slice(0, 4).map((event) => `${event.minute}' ${event.eventType}. Add your own analysis before publishing.`),
    chapters: events.map((event) => ({ minute: event.minute, title: `${event.eventType}${event.team ? ` - ${event.team}` : ""}` })),
    tacticalQuestions: important.map((event) => `What changed tactically around ${event.minute}' after ${event.eventType}?`),
    shortFormPlan: important.slice(0, 5).map((event) => ({ format: "9:16", moment: `${event.minute}' ${event.eventType}`, angle: "Use factual event data plus original commentary." })),
  };
}

matchIntelligenceRouter.post("/timeline", async (req, res) => {
  const body = requestSchema.parse(req.body);
  const provider = providerKey(body.provider);
  let result: { events: NormalizedMatchEvent[]; stats: unknown; fixture: unknown; warning: string | null };

  if (provider === "api-football") {
    result = await fetchApiFootballTimeline(body);
  } else if (provider === "manual") {
    result = { events: manualTimeline(body.manualEvents), stats: null, fixture: null, warning: body.manualEvents.length ? null : "Manual entry selected. Add events to build the timeline." };
  } else if (provider === "sportradar") {
    result = { events: [], stats: null, fixture: null, warning: config.SPORTRADAR_API_KEY ? "Sportradar adapter is reserved for production integration." : "Sportradar key is not configured. Use API-Football or Manual entry for MVP." };
  } else {
    result = { events: [], stats: null, fixture: null, warning: "ESPN fallback is disabled unless legally and technically permitted. No scraping or copied commentary is used." };
  }

  const events = [...result.events].sort((a, b) => (a.minute + (a.stoppageMinute ?? 0) / 100) - (b.minute + (b.stoppageMinute ?? 0) / 100));
  return res.json({
    provider,
    attribution: provider === "api-football" ? "Factual event data from API-Football/API-Sports, subject to provider license." : provider,
    complianceNote: "Use factual event data and your original analysis. Do not republish copied long-form commentary from providers.",
    fixture: result.fixture,
    stats: result.stats,
    events,
    outputs: generatedOutputs(events),
    warning: result.warning,
  });
});

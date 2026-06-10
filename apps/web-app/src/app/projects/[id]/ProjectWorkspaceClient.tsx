"use client";
import { useEffect, useState } from "react";
import { FormatSelector, OutputFormatCards, ReadinessChecklist, TimelineClipCard, CopyBlock } from "../../../components/Cards";
import { StatsEditor } from "../../../components/StatsEditor";
import { ThumbnailPreview } from "../../../components/ThumbnailPreview";
import { authedApiFetch } from "../../../lib/api";
import type { ProjectDetail } from "../../../lib/types";

type WorkspaceTab = "overview" | "timeline" | "match-data" | "highlights" | "captions" | "commentary" | "thumbnail" | "social-pack" | "exports" | "debug";

function JsonCard({ title, value }: { title: string; value: unknown }) {
  return <div className="card"><h3>{title}</h3><pre style={{ whiteSpace: "pre-wrap", overflowX: "auto" }}>{JSON.stringify(value, null, 2)}</pre></div>;
}

function EmptyState({ label }: { label: string }) { return <p className="muted">No {label} records yet. Generate or confirm content to populate this workspace tab.</p>; }

export function ProjectWorkspaceClient({ projectId, tab }: { projectId: string; tab: WorkspaceTab }) {
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authedApiFetch<ProjectDetail>(`/projects/${projectId}`)
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <section className="card"><h2>Loading project workspace</h2><p className="muted">Fetching project records from the API.</p></section>;
  if (error) return <section className="card"><h2>Project unavailable</h2><p className="warning">{error}</p></section>;
  if (!data) return null;

  if (tab === "overview") return <section className="grid grid-2"><div className="card"><h2>{data.project.title}</h2><p className="muted">Status: {data.project.status}</p><p>Videos: {data.videos.length} · Jobs: {data.jobs.length} · Exports: {data.exports.length}</p><p className="muted">Workflow: upload or record video, analyze, confirm stats, choose outputs, edit timeline, build thumbnail, generate social pack, export.</p></div><div className="card"><h3>Latest Jobs</h3>{data.jobs.length ? data.jobs.slice(0, 5).map((job) => <p key={job.id}>{job.type} · <span className="status">{job.status}</span> · {job.progress ?? 0}%</p>) : <EmptyState label="job" />}</div><JsonCard title="Source Videos" value={data.videos} /></section>;

  if (tab === "timeline") return <section className="grid"><TimelineClipCard />{data.events.length ? data.events.map((event, index) => <JsonCard key={index} title="Timeline Event" value={event} />) : <div className="card"><EmptyState label="timeline event" /></div>}</section>;
  if (tab === "match-data") return <section><h2>Confirm match data</h2><StatsEditor />{data.matchData ? <JsonCard title="Saved Match Data" value={data.matchData} /> : <div className="card"><EmptyState label="match data" /></div>}</section>;
  if (tab === "highlights") return <section className="grid"><div className="card"><h2>Highlight candidates</h2><p>Signals include manual markers, audio spikes, mic reactions, scoreboard changes, replay scenes, scene changes, post-match stats, and user-confirmed events.</p></div>{data.events.length ? data.events.map((event, index) => <JsonCard key={index} title="Detected or Confirmed Event" value={event} />) : <div className="card"><EmptyState label="highlight" /></div>}</section>;
  if (tab === "captions") return <section className="grid grid-2"><div className="card"><h2>Captions</h2><p>Caption generation costs 10 credits and will use confirmed transcript/timeline data when enabled.</p></div><JsonCard title="Caption Jobs" value={data.jobs.filter((job) => job.type.includes("caption"))} /></section>;
  if (tab === "commentary") return <section className="grid grid-2"><div className="card"><h2>Commentary</h2><p>Commentary scripts must not invent goals, players, coaches, stats, or cards.</p></div><CopyBlock title="Commentary draft" copy="Generate commentary after confirmed match data and timeline notes are available." /></section>;
  if (tab === "thumbnail") return <section className="grid"><ThumbnailPreview />{data.thumbnails.length ? <JsonCard title="Saved Thumbnails" value={data.thumbnails} /> : <div className="card"><EmptyState label="thumbnail" /></div>}</section>;
  if (tab === "social-pack") return <section className="grid grid-2">{["YouTube title variants", "YouTube description", "Chapters", "Pinned comment", "TikTok caption", "Instagram caption", "X post", "Hashtags", "Thumbnail text options", "Posting strategy", "Multi-language variants"].map((label) => <CopyBlock key={label} title={label} copy="Generated copy will use only confirmed match and project data." />)}{data.socialPackages.length ? <JsonCard title="Saved Social Packages" value={data.socialPackages} /> : <div className="card"><EmptyState label="social package" /></div>}</section>;
  if (tab === "exports") return <section className="grid"><FormatSelector /><OutputFormatCards /><ReadinessChecklist />{data.exports.length ? <JsonCard title="Exports" value={data.exports} /> : <div className="card"><EmptyState label="export" /></div>}</section>;
  return <section className="grid"><JsonCard title="Project" value={data.project} /><JsonCard title="Videos" value={data.videos} /><JsonCard title="Jobs" value={data.jobs} /><JsonCard title="Exports" value={data.exports} /><JsonCard title="Match Data" value={data.matchData} /></section>;
}

"use client";
import { useEffect, useState } from "react";
import { authedApiFetch } from "../../lib/api";
import type { DashboardProject } from "../../lib/types";

export function ProjectsClient() {
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [title, setTitle] = useState("Saturday Match Highlights");
  const [status, setStatus] = useState("Load your projects or create a new match workspace.");

  async function loadProjects() {
    try {
      const response = await authedApiFetch<{ projects: DashboardProject[] }>("/projects");
      setProjects(response.projects);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load projects.");
    }
  }

  async function createProject() {
    try {
      setStatus("Creating project...");
      const response = await authedApiFetch<{ project: DashboardProject }>("/projects", { method: "POST", body: JSON.stringify({ title }) });
      setStatus("Project created.");
      location.href = `/projects/${response.project.id}/overview`;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create project.");
    }
  }

  useEffect(() => { void loadProjects(); }, []);

  return <section className="grid"><div className="hero"><h1>Create a match project</h1><p className="muted">Projects keep the source video, match data, highlight timeline, thumbnail, social pack, and exports together.</p><input className="input" value={title} onChange={(event) => setTitle(event.target.value)} /><br /><br /><button className="button" onClick={createProject}>Create Project Workspace</button><p className="muted">{status}</p></div><div className="grid grid-2">{projects.map((project) => <a className="card" href={`/projects/${project.id}/overview`} key={project.id}><h3>{project.title}</h3><p className="muted">{project.status}</p></a>)}</div></section>;
}

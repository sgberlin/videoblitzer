"use client";
import { useEffect, useState } from "react";
import { AuthStatusMessage } from "../../components/AuthStatus";
import { apiFetch } from "../../lib/api";
import { authDebug, type AuthState, isInvalidLinkError, isPrivateBetaError, useAuthSession } from "../../lib/auth";
import type { DashboardProject } from "../../lib/types";

export function ProjectsClient() {
  const [projects, setProjects] = useState<DashboardProject[]>([]);
  const [title, setTitle] = useState("Match Upload");
  const [status, setStatus] = useState("Create or open a project to manage uploaded videos and packages.");
  const [authStatus, setAuthStatus] = useState<AuthState>("loading");
  const auth = useAuthSession();

  async function loadProjects() {
    if (!auth.session?.access_token) return;
    try {
      const response = await apiFetch<{ projects: DashboardProject[] }>("/projects", {}, auth.session.access_token);
      setProjects(response.projects);
      setAuthStatus("authenticated");
      authDebug("allowlist result", { allowed: true, userEmail: auth.email, currentRoute: "/projects" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load projects.";
      authDebug("allowlist result", { allowed: false, userEmail: auth.email, error: message, currentRoute: "/projects" });
      if (isPrivateBetaError(message)) setAuthStatus("unauthorized_email");
      else if (isInvalidLinkError(message)) setAuthStatus("invalid_link");
      else setStatus(message.toLowerCase() === "unauthorized" ? "Your sign-in was created, but the API could not verify it yet. Please refresh once." : message);
    }
  }

  async function createProject() {
    if (!auth.session?.access_token) return;
    try {
      setStatus("Creating project...");
      const response = await apiFetch<{ project: DashboardProject }>("/projects", { method: "POST", body: JSON.stringify({ title }) }, auth.session.access_token);
      setStatus("Project created.");
      location.href = `/projects/${response.project.id}/overview`;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create project.");
    }
  }

  useEffect(() => {
    if (auth.status !== "authenticated") {
      setAuthStatus(auth.status);
      return;
    }
    setAuthStatus("authenticated");
    void loadProjects();
  }, [auth.session?.access_token, auth.status]);

  if (auth.status === "loading" || authStatus === "loading") return <AuthStatusMessage status="loading" />;
  if (authStatus !== "authenticated") return <AuthStatusMessage status={authStatus} error={auth.error} />;

  return <section className="grid"><div className="hero"><h1>Projects</h1><p className="muted">Projects keep uploaded source videos, package recipes, generated ZIPs, and package history together.</p><div className="tabs"><a className="button" href="/upload">Upload Video and Create Package</a></div><br /><input className="input" value={title} onChange={(event) => setTitle(event.target.value)} /><br /><br /><button className="button secondary" onClick={createProject}>Create Empty Project</button><p className="muted">{status}</p></div><div className="grid grid-2">{projects.map((project) => <a className="card" href={`/projects/${project.id}/overview`} key={project.id}><h3>{project.title}</h3><p className="muted">{project.status}</p></a>)}</div></section>;
}

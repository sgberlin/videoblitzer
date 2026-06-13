import { ProjectWorkspaceClient } from "../ProjectWorkspaceClient";
export default function Page({ params }: { params: { id: string } }) {
  if (process.env.NODE_ENV === "production") {
    return <section className="card"><h2>Debug view unavailable</h2><p className="muted">Raw project diagnostics are hidden in production. Owners can use Admin tools for operational details.</p></section>;
  }
  return <ProjectWorkspaceClient projectId={params.id} tab="debug" />;
}

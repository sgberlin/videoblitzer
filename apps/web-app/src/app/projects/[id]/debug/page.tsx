import { ProjectWorkspaceClient } from "../ProjectWorkspaceClient";

type ProjectPageProps = { params: Promise<{ id: string }> };

export default async function Page({ params }: ProjectPageProps) {
  const { id } = await params;
  if (process.env.NODE_ENV === "production") {
    return <section className="card"><h2>Debug view unavailable</h2><p className="muted">Raw project diagnostics are hidden in production. Owners can use Admin tools for operational details.</p></section>;
  }
  return <ProjectWorkspaceClient projectId={id} tab="debug" />;
}

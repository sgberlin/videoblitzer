import { ProjectWorkspaceClient } from "../ProjectWorkspaceClient";

type ProjectPageProps = { params: Promise<{ id: string }> };

export default async function Page({ params }: ProjectPageProps) {
  const { id } = await params;
  return <ProjectWorkspaceClient projectId={id} tab="social-production" />;
}

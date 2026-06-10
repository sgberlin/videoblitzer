import { ProjectWorkspaceClient } from "../ProjectWorkspaceClient";
export default function Page({ params }: { params: { id: string } }) { return <ProjectWorkspaceClient projectId={params.id} tab="match-data" />; }

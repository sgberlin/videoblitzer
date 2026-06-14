import { redirect } from "next/navigation";

type ProjectIndexProps = { params: Promise<{ id: string }> };

export default async function ProjectIndex({ params }: ProjectIndexProps) {
  const { id } = await params;
  redirect(`/projects/${id}/overview`);
}

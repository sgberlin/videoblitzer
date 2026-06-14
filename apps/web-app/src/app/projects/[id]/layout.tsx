const tabs = ["overview", "imports", "timeline", "match-data", "highlights", "captions", "commentary", "thumbnail", "social-pack", "exports", "debug"];

type ProjectLayoutProps = { children: React.ReactNode; params: Promise<{ id: string }> };

export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  const { id } = await params;
  return <><section className="hero"><span className="pill">Project Workspace</span><h1>{id}</h1><div className="tabs">{tabs.map((tab) => <a className="tab" key={tab} href={`/projects/${id}/${tab}`}>{tab.replace("-", " ")}</a>)}</div></section><br />{children}</>;
}

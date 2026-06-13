const links: Array<[string, string]> = [
  ["Users", "/admin/users"],
  ["Credits", "/admin/credits"],
  ["Jobs", "/admin/jobs"],
  ["Imports", "/admin/imports"],
  ["Storage", "/admin/storage"],
  ["Logs", "/admin/logs"],
];

export default function AdminIndex(){
  return <section className="grid"><div className="hero"><span className="pill">Owner only</span><h1>Admin Operations</h1><p className="muted">Manage access, credits, jobs, source imports, storage, and audit logs.</p></div><div className="grid grid-3">{links.map(([label, href]) => <a className="card" href={href} key={href}><h3>{label}</h3><p className="muted">Open {label.toLowerCase()} admin tools.</p></a>)}</div></section>;
}

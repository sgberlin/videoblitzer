export function ProjectCard({ title, status }: { title: string; status: string }) {
  return <div className="card"><h3>{title}</h3><p className="muted">Status: <span className="status">{status}</span></p></div>;
}

const outputs = [
  ["16:9 Match Highlights", "Goals, penalties, big chances, cards, VAR, saves, and late drama", "15-20 min"],
  ["9:16 Goal Reel", "Goals only, with big-chance fallback if there are no goals", "Max 10 min"],
  ["Caption Assets", "SRT files and social text generated from package moments", "Included when captions are on"],
  ["Embedded Event Text", "Event type, minute, scorer, and team burned into videos when enabled", "Included when embedded captions are on"],
  ["Merged Master", "Normalized master with replacement audio", "Only when separate audio is used"],
];

export function OutputFormatCards() {
  return <div className="grid grid-2">{outputs.map(([name, format, duration]) => <div className="card" key={name}><h3>{name}</h3><p>{format}</p><p className="muted">{duration}</p></div>)}</div>;
}

export function FormatSelector() {
  return <div className="card"><h3>Package Formula</h3><p className="muted">VideoBlitzer now creates a fixed, reviewable package: one landscape highlights edit, one vertical goal reel, supporting captions/metadata, and an optional merged master.</p><a className="button" href="/upload">Create New Package</a></div>;
}

export function ReadinessChecklist() {
  const checks = ["Source video verified", "Package recipe selected", "Match data confirmed when available", "Caption assets selected", "Embedded event text selected", "Package ZIP downloaded"];
  return <div className="card"><h3>Package Readiness</h3>{checks.map((check) => <p key={check} className="muted">□ {check}</p>)}</div>;
}

export function TimelineClipCard() {
  return <div className="card"><h3>Opening pressure sequence</h3><p className="muted">Timestamp 08:14 · Duration 00:22 · Importance 72</p><p>Detected signals: audio spike, scene change, mic reaction</p><div className="tabs"><span className="tab">Trim start</span><span className="tab">Trim end</span><span className="tab">Remove</span><span className="tab">Reorder</span><span className="tab">Caption</span><span className="tab">Commentary note</span></div></div>;
}

export function CopyBlock({ title, copy }: { title: string; copy: string }) {
  return <div className="card copy-block"><h3>{title}</h3><p>{copy}</p><div className="tabs"><button className="button secondary">Copy</button><button className="button secondary">Edit</button><button className="button secondary">Regenerate</button><button className="button secondary">Translate</button></div></div>;
}

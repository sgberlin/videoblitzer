import { exportPresets } from "@videoblitzer/export-presets";

export function ProjectCard({ title, status }: { title: string; status: string }) {
  return <div className="card"><h3>{title}</h3><p className="muted">Status: <span className="status">{status}</span></p></div>;
}

const outputs = [
  ["Pure Master", "16:9 source-safe", "12-18 min", "0 credits"],
  ["3-Min Highlight Reel", "16:9 YouTube", "3 min", "20 credits"],
  ["60-Sec Shorts", "9:16 vertical", "60 sec", "15 credits"],
  ["Goals Only", "16:9 or 9:16", "Variable", "15 credits"],
  ["Commentary Cut", "YouTube package", "3-8 min", "25 credits"],
  ["Tactical Breakdown", "16:9 analysis", "4-10 min", "20 credits"],
  ["Thumbnail Pack", "3 sizes", "Fast", "5 credits"],
  ["Social Stats Pack", "Copy pack", "Fast", "5 credits"],
];

export function OutputFormatCards() {
  return <div className="grid grid-2">{outputs.map(([name, format, duration, cost]) => <div className="card" key={name}><h3>{name}</h3><p>{format}</p><p className="muted">Estimated duration: {duration}</p><p className="muted">Processing estimate: queue dependent</p><p className="pill">{cost}</p><br /><button className="button secondary">Generate</button></div>)}</div>;
}

export function FormatSelector() {
  return <div className="card"><h3>Global Format & Crop Controls</h3><div className="grid grid-2"><select className="input">{exportPresets.map((preset) => <option key={preset.id}>{preset.label}</option>)}</select><select className="input"><option>Center Crop</option><option>Scoreboard Safe</option><option>Action Follow</option><option>Ball Follow</option><option>Facecam + Gameplay</option><option>Manual Crop</option></select></div></div>;
}

export function ReadinessChecklist() {
  const checks = ["Stats confirmed", "Thumbnail selected", "Title generated", "Description generated", "Captions included", "Chapters included", "Output formats selected", "Coach/squad fields complete if selected"];
  return <div className="card"><h3>Ready to publish: 42%</h3>{checks.map((check) => <p key={check} className="muted">□ {check}</p>)}</div>;
}

export function TimelineClipCard() {
  return <div className="card"><h3>Opening pressure sequence</h3><p className="muted">Timestamp 08:14 · Duration 00:22 · Importance 72</p><p>Detected signals: audio spike, scene change, mic reaction</p><div className="tabs"><span className="tab">Trim start</span><span className="tab">Trim end</span><span className="tab">Remove</span><span className="tab">Reorder</span><span className="tab">Caption</span><span className="tab">Commentary note</span></div></div>;
}

export function CopyBlock({ title, copy }: { title: string; copy: string }) {
  return <div className="card copy-block"><h3>{title}</h3><p>{copy}</p><div className="tabs"><button className="button secondary">Copy</button><button className="button secondary">Edit</button><button className="button secondary">Regenerate</button><button className="button secondary">Translate</button></div></div>;
}

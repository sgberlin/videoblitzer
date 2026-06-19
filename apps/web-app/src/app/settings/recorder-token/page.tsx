"use client";

import { useEffect } from "react";

export default function RecorderTokenPage() {
  useEffect(() => {
    window.location.replace("/settings");
  }, []);

  return <section className="grid">
    <div className="card"><h1>Recorder setup moved</h1><p className="muted">The web app now focuses on uploaded videos and package production. Redirecting to settings...</p><a className="button" href="/settings">Open Settings</a></div>
  </section>;
}

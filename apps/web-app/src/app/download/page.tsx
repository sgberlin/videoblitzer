export default function DownloadPage() {
  return <section className="grid">
    <div className="hero"><span className="pill">Private beta</span><h1>Download Screen Recorder</h1><p className="muted">Recorder installers are distributed to approved beta users after each signed build is verified.</p></div>
    <div className="grid grid-2">
      <div className="card"><h3>Mac Recorder</h3><p className="muted">Request the latest macOS beta installer from the VideoBlitzer owner. Use only signed/notarized builds for production QA.</p><a className="button" href="mailto:gizlenweb@gmail.com?subject=VideoBlitzer%20Mac%20Recorder%20Beta%20Installer">Request Mac installer</a></div>
      <div className="card"><h3>Windows Recorder</h3><p className="muted">Request the latest Windows beta installer from the VideoBlitzer owner. Use only signed builds for production QA.</p><a className="button secondary" href="mailto:gizlenweb@gmail.com?subject=VideoBlitzer%20Windows%20Recorder%20Beta%20Installer">Request Windows installer</a></div>
    </div>
    <div className="card"><h3>How to record browser video</h3><p>Download and open the recorder, choose a screen/browser/app window, record locally, then upload to VideoBlitzer for clips, exports, and MP4 conversion.</p><p className="warning">DRM or protected content may record black or muted. VideoBlitzer does not bypass platform restrictions.</p></div>
  </section>;
}

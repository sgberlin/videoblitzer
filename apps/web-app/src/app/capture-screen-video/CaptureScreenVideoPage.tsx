import { appConfig } from "../../lib/config";

const recorderDownloads = {
  mac: `${appConfig.apiUrl}/downloads/recorders/mac-arm64`,
  windows: `${appConfig.apiUrl}/downloads/recorders/windows-x64`,
};

export function CaptureScreenVideoPage() {
  return <section className="grid">
    <div className="hero"><span className="pill">Private beta recorder</span><h1>Capture Screen Video</h1><p className="muted">Record your browser, screen, or app window, then upload it to VideoBlitzer for clips, exports, and MP4 conversion.</p><div className="tabs"><a className="button" href={recorderDownloads.mac}>Download Mac Recorder</a><a className="button secondary" href={recorderDownloads.windows}>Download Windows Recorder</a><a className="button secondary" href="/manual">How to record browser video</a></div></div>
    <div className="grid grid-3">
      <div className="card"><h3>1. Download and open the recorder.</h3><p className="muted">Use the Mac or Windows recorder build for your device.</p></div>
      <div className="card"><h3>2. Choose screen, browser window, or app window.</h3><p className="muted">Capture browser video, online matches, app windows, or your full screen when you are authorized to record.</p></div>
      <div className="card"><h3>3. Record, save locally, and upload.</h3><p className="muted">Your recording is saved locally first, then uploaded to VideoBlitzer for analysis and MP4 conversion.</p></div>
    </div>
    <div className="card"><h3>Supported capture modes</h3><p>Record your screen, browser, or app window. Capture Match Video mode adds match metadata, permission confirmation, markers, and timeline assistance.</p><p className="warning">DRM or protected content may record black or muted. VideoBlitzer does not bypass platform restrictions.</p></div>
  </section>;
}

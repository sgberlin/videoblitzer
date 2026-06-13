import { appConfig } from "../../lib/config";

const downloads = {
  macArm64: `${appConfig.apiUrl}/downloads/recorders/mac-arm64`,
  macX64: `${appConfig.apiUrl}/downloads/recorders/mac-x64`,
  windowsX64: `${appConfig.apiUrl}/downloads/recorders/windows-x64`,
};

export default function DownloadPage() {
  return <section className="grid">
    <div className="hero"><span className="pill">Private beta</span><h1>Download Screen Recorder</h1><p className="muted">Download the VideoBlitzer Screen Recorder installer for your device, then record locally and upload when ready.</p></div>
    <div className="grid grid-2">
      <div className="card"><h3>Mac Recorder</h3><p className="muted">Apple Silicon Macs should use the arm64 DMG. Intel Macs should use the x64 DMG.</p><div className="tabs"><a className="button" href={downloads.macArm64}>Download Mac Recorder</a><a className="button secondary" href={downloads.macX64}>Download Mac Intel Recorder</a></div></div>
      <div className="card"><h3>Windows Recorder</h3><p className="muted">Use the x64 installer for current Windows beta testing.</p><a className="button secondary" href={downloads.windowsX64}>Download Windows Recorder</a></div>
    </div>
    <div className="card"><h3>Installation instructions</h3><p>Download and open the installer, approve OS security prompts, choose a screen/browser/app window, record locally, then upload to VideoBlitzer for clips, exports, and MP4 conversion.</p><p className="warning">DRM or protected content may record black or muted. VideoBlitzer does not bypass platform restrictions.</p></div>
    <div className="card"><h3>Deployment artifact paths</h3><p className="muted">If a download returns setup JSON, copy the built installers into the API download directory on the VPS.</p><pre>{`Local build artifacts:
apps/desktop-recorder/release/VideoBlitzer-Recorder-mac-arm64.dmg
apps/desktop-recorder/release/VideoBlitzer-Recorder-mac-x64.dmg
apps/desktop-recorder/release/VideoBlitzer-Recorder-win-x64.exe

VPS download directory:
/var/www/videoblitzer-api/recorder-downloads/`}</pre></div>
  </section>;
}

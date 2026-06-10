"use client";
import { useEffect, useState } from "react";
import { authedApiFetch } from "../../../lib/api";
import type { R2Usage } from "../../../lib/types";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function StorageMetadataClient() {
  const [metadata, setMetadata] = useState<R2Usage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authedApiFetch<{ metadata: R2Usage }>("/storage/metadata")
      .then((response) => setMetadata(response.metadata))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <section className="card"><h1>R2 Storage</h1><p className="muted">Loading bucket metadata from the API.</p></section>;
  if (error) return <section className="card"><h1>R2 Storage</h1><p className="warning">{error}</p></section>;
  if (!metadata) return null;

  return <section className="grid">
    <div className="hero"><span className="pill">Owner only</span><h1>R2 Storage Metadata</h1><p className="muted">This page calls the API with your Supabase JWT. R2 credentials remain server-side on the VPS.</p></div>
    <div className="grid grid-3">
      <div className="card"><h3>Configured</h3><p className={metadata.configured ? "status" : "warning"}>{metadata.configured ? "R2 credentials active" : "R2 not available"}</p><p className="muted">Endpoint configured: {metadata.endpointConfigured ? "yes" : "no"}</p></div>
      <div className="card"><h3>Bucket</h3><p>{metadata.bucket}</p><p className="muted">Last modified: {metadata.lastModified ? new Date(metadata.lastModified).toLocaleString() : "No objects yet"}</p></div>
      <div className="card"><h3>Total Usage</h3><p>{metadata.totalObjects} objects</p><p>{formatBytes(metadata.totalBytes)}</p></div>
      <div className="card"><h3>Raw Files</h3><p>{metadata.rawFiles}</p></div>
      <div className="card"><h3>Exports</h3><p>{metadata.exports}</p></div>
      <div className="card"><h3>Thumbnails</h3><p>{metadata.thumbnails}</p></div>
      <div className="card"><h3>Captions</h3><p>{metadata.captions}</p></div>
    </div>
    {metadata.error && <div className="card"><h3>Storage warning</h3><p className="warning">{metadata.error}</p></div>}
  </section>;
}

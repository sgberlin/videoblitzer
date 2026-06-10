export function OwnerModeBadge() { return <span className="pill">Owner Mode: unlimited credits</span>; }
export function CreditBadge({ credits }: { credits: number | "Unlimited" }) { return <span className="pill">Credits: {credits}</span>; }
export function ExportStatusPill({ status }: { status: string }) { return <span className="pill">{status}</span>; }
export function ConfidenceBadge({ label }: { label: string }) { return <span className="pill">{label}</span>; }

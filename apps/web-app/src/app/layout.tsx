import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "VideoBlitzer App", description: "Private-beta AI video clipping and social content platform." };

const links: Array<[string, string]> = [
  ["Dashboard", "/dashboard"],
  ["Projects", "/projects"],
  ["Upload", "/upload"],
  ["Admin", "/admin"],
  ["Manual", "/manual"],
  ["Privacy", "/privacy"],
  ["Terms", "/terms"],
  ["About", "/about"],
  ["Contact", "/contact"],
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><div className="shell"><aside className="nav"><div className="brand">VideoBlitzer</div><p className="muted">Private beta workspace</p>{links.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}<p className="muted">Powered by Lordan Labs</p></aside><main className="main">{children}</main></div></body></html>;
}

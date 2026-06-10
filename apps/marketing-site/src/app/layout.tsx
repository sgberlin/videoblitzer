import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
export const metadata: Metadata = { title: "VideoBlitzer", description: "AI video clipping, highlights, Shorts, captions, thumbnails, and social packs." };
const nav = ["features", "how-it-works", "pricing", "download", "manual", "privacy", "terms", "about", "contact"];
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en"><body><div className="wrap"><header className="nav"><Link href="/"><strong>VideoBlitzer</strong></Link><nav>{nav.map((item) => <Link key={item} href={`/${item}`}>{item.replaceAll("-", " ")}</Link>)}<Link href="https://app.videoblitzer.com">Open App</Link></nav></header>{children}<footer className="footer">Powered by Lordan Labs</footer></div></body></html>; }

import { UpdateNotice } from "./updates";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./features.css";
import "./highlight.css";
import "./context-banner.css";

export const metadata: Metadata = {
  title: "cmux companion",
  description: "Monitor and interact with cmux from your phone, privately over Tailscale.",
  applicationName: "cmux companion",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "cmux",
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon-192.png",
    shortcut: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#07090b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><UpdateNotice />{children}</body>
    </html>
  );
}

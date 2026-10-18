import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "QuickBooks Command Center",
  description: "Turn your business finances into a clear, evidence-backed action plan.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

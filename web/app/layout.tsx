import type { Metadata } from "next";
import { SiteHeader } from "./site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ops Coach",
  description: "Linux foundations lab practice in the browser",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@unturf/unfirehose-ui/layout/Sidebar";
import { ThemeProvider } from "@unturf/unfirehose-ui/ThemeProvider";
import { VaultShell } from "./VaultShell";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "unfirehose",
  description: "unfirehose nextjs logger",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistMono.variable} antialiased h-screen flex overflow-hidden`}>
        <VaultShell>
          <ThemeProvider />
          <Sidebar />
          <main className="flex-1 overflow-auto p-6">
            {children}
          </main>
        </VaultShell>
      </body>
    </html>
  );
}

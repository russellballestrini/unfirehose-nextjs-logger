import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@unturf/unfirehose-ui/layout/Sidebar";
import { ThemeProvider } from "@unturf/unfirehose-ui/ThemeProvider";
import { VaultShell } from "./VaultShell";
import { VitalsReporter } from "@/components/VitalsReporter";
import { ScrollRestorer } from "@/components/ScrollRestorer";

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
      <body className={`${geistMono.variable} antialiased h-screen flex flex-col lg:flex-row overflow-hidden`}>
        <VaultShell>
          <ThemeProvider />
          <Sidebar />
          <main className="flex-1 min-w-0 min-h-0 overflow-auto p-4 sm:p-6 relative">
            {children}
          </main>
        </VaultShell>
        <VitalsReporter />
        <ScrollRestorer />
      </body>
    </html>
  );
}

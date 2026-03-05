import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@unfirehose/ui/layout/Sidebar";
import { ThemeProvider } from "@unfirehose/ui/ThemeProvider";

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
      <body className={`${geistMono.variable} antialiased min-h-screen flex`}>
        <ThemeProvider />
        <Sidebar />
        <main className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </body>
    </html>
  );
}

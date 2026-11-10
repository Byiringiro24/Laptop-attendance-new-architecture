import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Toaster } from "react-hot-toast";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "FK Biometric Attendance System - Tablet",
  description: "Professional Enterprise Biometric Attendance Management System",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" data-theme="dark" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen bg-dark-500 text-slate-100 antialiased`} suppressHydrationWarning>
        <Toaster
          position="top-right"
          toastOptions={{
            style: {
              border: "1px solid var(--toast-border)",
              background: "var(--toast-bg)",
              color: "var(--toast-text)",
            },
          }}
        />
        {children}
      </body>
    </html>
  );
}
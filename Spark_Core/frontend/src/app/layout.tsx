import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AuthProvider } from "./auth-context";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Spark",
    template: "%s | Spark",
  },
  description: "Discover startup communities and collaborate in your workspace.",
  icons: {
    icon: "/icon.svg",
  },
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

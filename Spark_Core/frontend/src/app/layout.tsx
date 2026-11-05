import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AuthProvider } from "./auth-context";
import "./globals.css";
import "./_ui/viz/viz.css";
import "./_ui/app.css";
import { appFont } from "./_ui/font";

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
    <html className={appFont.variable} data-scroll-behavior="smooth" lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

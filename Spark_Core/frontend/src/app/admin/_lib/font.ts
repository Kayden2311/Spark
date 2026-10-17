import { Plus_Jakarta_Sans } from "next/font/google";

// Self-hosted at build time by next/font; scoped to the admin console through a CSS variable.
export const adminFont = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--adm-font",
});

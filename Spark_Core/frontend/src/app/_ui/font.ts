import { Plus_Jakarta_Sans } from "next/font/google";

// The member app's typeface, self-hosted by next/font. It only declares --sp-font, so pages that never read the
// variable (landing, auth) keep their own font; it sits on <html> so dialogs portalled to <body> get it too.
export const appFont = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--sp-font",
});

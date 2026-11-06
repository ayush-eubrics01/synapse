import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { THEME_BOOT_SCRIPT } from "../lib/theme";
import { ToastProvider, Toasts } from "./components/ui/Toasts";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/primitives.css";
import "./styles/cards.css";
import "./styles/system.css";
import "./styles/inbox.css";
import "./styles/people.css";
import "./styles/jira.css";
import "./styles/brain.css";

// Self-hosted at build time: the browser never requests Google (spec D4).
const sans = IBM_Plex_Sans({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = { title: "Synapse" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The boot script sets data-theme before React hydrates, hence suppressHydrationWarning.
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static, app-owned theme boot script (spec D3)
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body>
        <ToastProvider>
          {children}
          <Toasts />
        </ToastProvider>
      </body>
    </html>
  );
}

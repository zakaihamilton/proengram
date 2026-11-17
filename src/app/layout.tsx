import type { Metadata } from "next";
import { ThemeProvider } from "panel-frame-ui";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ProEngram", template: "%s · ProEngram" },
  description: "Shared company knowledge, saved answers, and policy context.",
};

const themePersistence = { type: "localStorage", key: "proengram-theme" } as const;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider persistence={themePersistence}>{children}</ThemeProvider>
      </body>
    </html>
  );
}

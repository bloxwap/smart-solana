import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { mono, sans } from "@/lib/fonts";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://bloxwap.github.io/smart-solana/"),
  title: { default: "Smart Solana · Bloxwap", template: "%s · Smart Solana" },
  description: "A latency-aware, cached, multi-endpoint Solana RPC transport for Kit and web3.js.",
  icons: { icon: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/logos/bloxwap-icon-green.svg` },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} dark`} suppressHydrationWarning>
      <body>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}

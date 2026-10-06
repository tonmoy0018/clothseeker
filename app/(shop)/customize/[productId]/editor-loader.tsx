"use client";

import dynamic from "next/dynamic";

import type { DesignEditorProps } from "./design-editor";

// The editor uses Fabric.js and canvas APIs, so it only renders in the browser.
const DesignEditor = dynamic(() => import("./design-editor").then((m) => m.DesignEditor), {
  ssr: false,
  loading: () => (
    <div className="flex aspect-[1200/1560] w-full max-w-[560px] items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">
      Loading the designer…
    </div>
  ),
});

export function EditorLoader(props: DesignEditorProps) {
  return <DesignEditor {...props} />;
}

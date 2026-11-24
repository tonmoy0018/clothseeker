import * as React from "react"
import { cn } from "cn"

/** The look of a <textarea>, matching Input. */
const textareaClass =
  "min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive md:text-sm"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(textareaClass, "w-full", className)} {...props} />
}

export { Textarea, textareaClass }

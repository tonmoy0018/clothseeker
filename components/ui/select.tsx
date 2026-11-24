import * as React from "react"
import { cn } from "cn"

/** The look of a native <select> (and of plain inputs that sit beside one), matching Input. */
const nativeSelectClass =
  "h-9 min-w-0 rounded-lg border border-input bg-card px-2.5 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive"

/** A native <select>, styled like Input. Native on purpose: it works without JavaScript and on phones. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="select" className={cn(nativeSelectClass, className)} {...props} />
}

export { NativeSelect, nativeSelectClass }

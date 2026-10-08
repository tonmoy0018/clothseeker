// Pages that stand in for third-party services (e.g. the payment gateway). Deliberately unbranded.
export default function MockServicesLayout({ children }: LayoutProps<"/">) {
  return <main className="flex flex-1 items-center justify-center bg-slate-100 px-4 py-10 dark:bg-slate-950">{children}</main>;
}

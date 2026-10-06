# lib/auth

- `session.ts`: `getCurrentUser()`. Reads Supabase claims, then loads the role from the `users` table (never from the JWT or the client).
- `guards.ts`: `requireUser(next)` redirects to `/login`; `requireAdmin()` returns a 404 for non-admins.
- `policy.ts`: pure rules (`assertCustomer`, `assertOwns`, `assertAdmin`) used by domain services.
- `safe-next.ts`: sanitizes `?next=` redirects.

See [docs/developers/permissions-matrix.md](../../docs/developers/permissions-matrix.md).

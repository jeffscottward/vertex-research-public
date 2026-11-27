// What: the not-found state of a route that has no shell of its own. It renders in the root
// layout, so it follows the active theme.
// Used by: notFound() calls of routes outside the (public) and (portal) groups (the lab pages when
// the lab is off). An unmatched address renders app/(public)/not-found.tsx; a portal route renders
// app/(portal)/not-found.tsx inside the portal shell.
export default function RootNotFound() {
  return (
    <main
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6 py-12 text-center text-foreground"
      id="main-content"
    >
      <h1 className="font-heading font-semibold text-3xl">Page not found</h1>
      <p className="text-base text-muted-foreground leading-7">
        There is no page to show at this address.
      </p>
      <a
        className="inline-flex min-h-11 items-center font-semibold text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        href="/"
      >
        Go to the start page
      </a>
    </main>
  );
}

// What: the not-found state inside the portal shell. It has no main landmark and no page height
// of its own, because the shell already supplies both.
// Used by: notFound() calls of portal routes (a stock symbol, a lesson or a course that does not
// exist). A route without a shell uses app/not-found.tsx.
export default function PortalNotFound() {
  return (
    <section
      aria-labelledby="portal-not-found-title"
      className="flex flex-col items-start gap-3 py-8"
    >
      <h1
        className="font-heading font-semibold text-2xl"
        id="portal-not-found-title"
      >
        Page not found
      </h1>
      <p className="text-muted-foreground text-sm leading-6">
        There is no page to show at this address.
      </p>
      <a
        className="inline-flex min-h-11 items-center font-semibold text-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        href="/dashboard"
      >
        Go to Mission control
      </a>
    </section>
  );
}

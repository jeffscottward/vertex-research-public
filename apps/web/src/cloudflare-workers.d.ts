declare module "cloudflare:workers" {
  export const env: Readonly<Record<string, unknown>>;
  export function waitUntil(task: Promise<unknown>): void;
}

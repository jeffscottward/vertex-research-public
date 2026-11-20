import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { scaledTimeout } from "../../../scripts/lib/test-timeout-scale.ts";

import {
  type PreviewCaptureServer,
  startPreviewCaptureServer,
} from "./preview-capture.ts";

// A capture publishes three preview files, each with a physical fsync
// (FileHandle.sync) in TMPDIR. CI runners keep TMPDIR on the shared btrfs
// /var/tmp, where fsync waits for other jobs' writeback; CPU load does not
// show it, so the load scale stays at x1 (card
// vertex-ci-rig-load-timeouts-1104). Measured: the capture test took 10.6 s
// in CI coverage shard 4/12 (run 41827093229); a sibling fsync test reached
// 15 s in run 41816221283. Locally with 8 dirty-page writers plus syncfs on
// /var/tmp: up to 2.0 s. Budget: 2x the 15 s CI worst case.
vi.setConfig({ testTimeout: scaledTimeout(30_000) });

const temporaryDirectories = new Set<string>();
const servers = new Set<PreviewCaptureServer>();

const createFixture = async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "darkfactory-preview-capture-"))
  );
  temporaryDirectories.add(root);
  const binding = {
    runId: "run_capture_test",
    hmacKey: Buffer.alloc(32, 7).toString("base64url"),
  };
  const server = await startPreviewCaptureServer({
    appOrigin: "https://darkfactory.localhost:43123",
    authDirectory: join(root, "auth"),
    contactDirectory: join(root, "contact"),
    binding,
  });
  servers.add(server);
  return { root, binding, server };
};

afterEach(async () => {
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
  await Promise.all(
    [...temporaryDirectories].map((root) =>
      rm(root, {
        force: true,
        recursive: true,
      })
    )
  );
  return temporaryDirectories.clear();
});

describe("preview capture server", () => {
  it("accepts one authenticated loopback capture and persists signed artifacts", async () => {
    const { root, binding, server } = await createFixture();
    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${binding.hmacKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        runId: binding.runId,
        operation: "verify-email",
        input: {
          to: "member@domain.test",
          recipientName: "Member Example",
          verificationUrl:
            "https://darkfactory.localhost:43123/api/auth/verify-email?token=header.payload.signature&callbackURL=%2Fverify-email%3Fverified%3D1",
          expiresInMinutes: 60,
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // No idle connection to reuse: the client must open a new one per capture.
    expect(response.headers.get("connection")).toBe("close");
    const names = await readdir(join(root, "auth"));
    expect(names.filter((name) => name.endsWith(".html"))).toHaveLength(1);
    expect(names.filter((name) => name.endsWith(".txt"))).toHaveLength(1);
    const metadataName = names.find((name) => name.endsWith(".metadata.json"));
    expect(metadataName).toBeDefined();
    const metadata = JSON.parse(
      await readFile(join(root, "auth", metadataName!), "utf8")
    );
    expect(metadata).toMatchObject({
      version: 1,
      runId: binding.runId,
      operation: "verify-email",
    });
    return expect(metadata.binding).toEqual({
      algorithm: "hmac-sha256",
      hmac: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("rejects a wrong bearer, run, path, and content type without writing files", async () => {
    const { root, binding, server } = await createFixture();
    const payload = JSON.stringify({
      version: 1,
      runId: "another_run",
      operation: "contact",
      input: {
        name: "Ada Lovelace",
        email: "ada@example.test",
        subject: "Question",
        message: "Hello",
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const responses = await Promise.all([
      fetch(server.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"x".repeat(binding.hmacKey.length)}`,
          "content-type": "application/json",
        },
        body: payload,
      }),
      fetch(server.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${binding.hmacKey}`,
          "content-type": "application/json",
        },
        body: payload,
      }),
      fetch(server.endpoint.replace("/v1/capture", "/wrong"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${binding.hmacKey}`,
          "content-type": "application/json",
        },
        body: payload,
      }),
      fetch(server.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${binding.hmacKey}`,
          "content-type": "text/plain",
        },
        body: payload,
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      404, 400, 404, 404,
    ]);
    // Each rejection names its cause on stderr, without the bearer or the input.
    const lines = stderr.mock.calls.map(([chunk]) => String(chunk)).sort();
    stderr.mockRestore();
    expect(lines).toEqual([
      "[preview-capture] rejected 400: invalid payload or another run id\n",
      ...Array.from(
        { length: 3 },
        () =>
          "[preview-capture] rejected 404: not an authorized loopback JSON POST to the capture path\n"
      ),
    ]);
    expect(lines.join("")).not.toContain(binding.hmacKey);
    expect(lines.join("")).not.toContain("Lovelace");
    await expect(readdir(join(root, "auth"))).rejects.toThrow();
    return await expect(readdir(join(root, "contact"))).rejects.toThrow();
  });

  it("names the preview failure on stderr when the email cannot be written", async () => {
    const { root, binding } = await createFixture();
    // A regular file where the auth folder's parent should be: the preview write fails.
    await writeFile(join(root, "not-a-folder"), "");
    const server = await startPreviewCaptureServer({
      appOrigin: "https://darkfactory.localhost:43123",
      authDirectory: join(root, "not-a-folder", "auth"),
      contactDirectory: join(root, "contact"),
      binding,
    });
    servers.add(server);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${binding.hmacKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        runId: binding.runId,
        operation: "verify-email",
        input: {
          to: "member@domain.test",
          recipientName: "Member Example",
          verificationUrl:
            "https://darkfactory.localhost:43123/api/auth/verify-email?token=header.payload.signature&callbackURL=%2Fverify-email%3Fverified%3D1",
          expiresInMinutes: 60,
        },
      }),
    });
    const lines = stderr.mock.calls.map(([chunk]) => String(chunk));
    stderr.mockRestore();
    expect(response.status).toBe(503);
    expect(lines).toEqual([
      "[preview-capture] rejected 503: verify-email preview not written (EMAIL_PREVIEW_WRITE_FAILED)\n",
    ]);
    return expect(lines.join("")).not.toContain("member@domain.test");
  });

  it("names a request that fails to parse on stderr", async () => {
    const { binding, server } = await createFixture();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const response = await fetch(server.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${binding.hmacKey}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    const lines = stderr.mock.calls.map(([chunk]) => String(chunk));
    stderr.mockRestore();
    expect(response.status).toBe(400);
    return expect(lines).toEqual([
      "[preview-capture] rejected 400: request failed: SyntaxError\n",
    ]);
  });

  return it("binds the fixed port the app server was told about", async () => {
    const { root, binding, server } = await createFixture();
    const port = Number(new URL(server.endpoint).port);
    await server.close();
    const fixed = await startPreviewCaptureServer({
      appOrigin: "https://darkfactory.localhost:43123",
      authDirectory: join(root, "auth"),
      contactDirectory: join(root, "contact"),
      binding,
      port,
    });
    servers.add(fixed);
    return expect(fixed.endpoint).toBe(`http://127.0.0.1:${port}/v1/capture`);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMock = vi.hoisted(() => ({ isOperator: true }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../../../lib/request-portal-session.ts", () => ({
  getRequestPortalSession: async () => ({
    expiresAt: new Date(),
    isOperator: sessionMock.isOperator,
    name: "Owner",
    role: "member",
    userId: "u",
  }),
}));
vi.mock("@darkfactory/academy/lessons", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@darkfactory/academy/lessons")>();
  // A mutable copy so a test can drop one lesson's rendered media.
  return { ...actual, ACADEMY_MEDIA: { ...actual.ACADEMY_MEDIA } };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { ACADEMY_LESSONS, ACADEMY_MEDIA } from "@darkfactory/academy/lessons";
import { OperatorAccessRequired } from "../../../../components/portal/agent-ops-client.tsx";
import AcademyLessonError from "./error.tsx";
import AcademyLessonLoading from "./loading.tsx";
import AcademyLessonPage, { generateMetadata } from "./page.tsx";

beforeEach(() => {
  sessionMock.isOperator = true;
  vi.unstubAllEnvs();
});

describe("academy lesson route", () => {
  it("renders a lesson page and 404s an unknown slug", async () => {
    const page = await AcademyLessonPage({
      params: Promise.resolve({ slug: "itm-covered-call-otm-put" }),
    });
    expect(page).not.toBeNull();
    await expect(
      AcademyLessonPage({ params: Promise.resolve({ slug: "no-such-lesson" }) })
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows the access page and a generic title to a signed-in non-operator", async () => {
    sessionMock.isOperator = false;
    const params = Promise.resolve({ slug: "itm-covered-call-otm-put" });
    const page = await AcademyLessonPage({ params });
    expect((page as { type: unknown }).type).toBe(OperatorAccessRequired);
    expect(await generateMetadata({ params })).toEqual({
      title: "Academy lesson",
    });
  });

  it("titles the lesson for an operator", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "itm-covered-call-otm-put" }),
    });
    expect(metadata.title).toContain("· Academy");
    expect(
      await generateMetadata({
        params: Promise.resolve({ slug: "no-such-lesson" }),
      })
    ).toEqual({ title: "Academy lesson" });
  });

  it("ignores an invalid media base URL instead of failing the page", async () => {
    vi.stubEnv("VERTEX_ACADEMY_MEDIA_BASE_URL", "not a url");
    const page = (await AcademyLessonPage({
      params: Promise.resolve({ slug: "itm-covered-call-otm-put" }),
    })) as { props: { media: { video: string } | null } };
    expect(page.props.media?.video).toMatch(/^\/academy-media\//u);
    vi.stubEnv("VERTEX_ACADEMY_MEDIA_BASE_URL", "http://rig.example/media");
    const insecure = (await AcademyLessonPage({
      params: Promise.resolve({ slug: "itm-covered-call-otm-put" }),
    })) as { props: { media: { video: string } | null } };
    expect(insecure.props.media?.video).toMatch(/^\/academy-media\//u);
  });

  it("links no neighbour past either end and passes no media for an unrendered lesson", async () => {
    interface Props {
      props: {
        media: unknown;
        previous: { slug: string } | null;
        next: { slug: string } | null;
      };
    }
    const first = ACADEMY_LESSONS[0];
    const last = ACADEMY_LESSONS.at(-1);
    if (first === undefined || last === undefined)
      throw new Error("no lessons");
    const head = (await AcademyLessonPage({
      params: Promise.resolve({ slug: first.slug }),
    })) as Props;
    expect(head.props.previous).toBeNull();
    expect(head.props.next?.slug).toBe(ACADEMY_LESSONS[1]?.slug);
    const media = ACADEMY_MEDIA as Record<string, unknown>;
    delete media[last.slug];
    const tail = (await AcademyLessonPage({
      params: Promise.resolve({ slug: last.slug }),
    })) as Props;
    expect(tail.props.next).toBeNull();
    expect(tail.props.previous).not.toBeNull();
    expect(tail.props.media).toBeNull();
  });

  it("renders loading and error states", () => {
    expect(renderToStaticMarkup(<AcademyLessonLoading />)).toContain(
      "Loading the Academy"
    );
    expect(
      renderToStaticMarkup(<AcademyLessonError reset={() => undefined} />)
    ).toContain("Academy unavailable");
  });
});

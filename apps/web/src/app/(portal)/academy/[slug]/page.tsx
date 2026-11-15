import {
  ACADEMY_MEDIA,
  withAcademyMediaBaseUrl,
} from "@darkfactory/academy/lessons";
import { parseAcademyMediaBaseUrl } from "@darkfactory/config/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

import { AcademyLesson } from "../../../../components/portal/academy/academy-lesson.tsx";
import { OperatorAccessRequired } from "../../../../components/portal/agent-ops-client.tsx";
import { loadLesson } from "../../../../lib/academy-lessons.ts";
import { getRequestPortalSession } from "../../../../lib/request-portal-session.ts";

type Params = Promise<{ slug: string }>;

// Metadata and page share one lesson read per request.
const lessonFor = cache(loadLesson);

/** The request's cookie when an operator asks, else null. */
const operatorCookie = async (): Promise<string | null> => {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const session = await getRequestPortalSession(
    cookie,
    requestHeaders.get("cf-connecting-ip")
  );
  return session?.isOperator === true ? (cookie ?? "") : null;
};

// Lesson titles are operator-only like the transcripts: others get a generic title for any slug.
export const generateMetadata = async ({
  params,
}: {
  readonly params: Params;
}) => {
  const cookie = await operatorCookie();
  const found =
    cookie === null ? null : await lessonFor((await params).slug, cookie);
  return {
    title:
      found === null ? "Academy lesson" : `${found.lesson.title} · Academy`,
  };
};

export default async function AcademyLessonPage({
  params,
}: {
  readonly params: Params;
}) {
  const cookie = await operatorCookie();
  if (cookie === null) return <OperatorAccessRequired feature="academy" />;
  const found = await lessonFor((await params).slug, cookie);
  if (found === null) notFound();
  // Previous and next stay inside the lesson's course.
  const { lesson, previous, next } = found;
  const media = ACADEMY_MEDIA[lesson.slug];
  return (
    <AcademyLesson
      lesson={lesson}
      media={
        media === undefined
          ? null
          : withAcademyMediaBaseUrl(
              media,
              parseAcademyMediaBaseUrl(process.env) ?? undefined
            )
      }
      next={next}
      previous={previous}
    />
  );
}

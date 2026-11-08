import {
  ACADEMY_LESSONS,
  ACADEMY_MEDIA,
  lessonBySlug,
  neighboursIn,
  withAcademyMediaBaseUrl,
} from "@darkfactory/academy/lessons";
import { parseAcademyMediaBaseUrl } from "@darkfactory/config/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { AcademyLesson } from "../../../../components/portal/academy/academy-lesson.tsx";
import { OperatorAccessRequired } from "../../../../components/portal/agent-ops-client.tsx";
import { getRequestPortalSession } from "../../../../lib/request-portal-session.ts";

type Params = Promise<{ slug: string }>;

const isOperatorRequest = async (): Promise<boolean> => {
  const requestHeaders = await headers();
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  return session?.isOperator === true;
};

// Lesson titles are operator-only like the transcripts: others get a generic title for any slug.
export const generateMetadata = async ({
  params,
}: {
  readonly params: Params;
}) => {
  const lesson = (await isOperatorRequest())
    ? lessonBySlug((await params).slug)
    : null;
  return {
    title: lesson === null ? "Academy lesson" : `${lesson.title} · Academy`,
  };
};

export default async function AcademyLessonPage({
  params,
}: {
  readonly params: Params;
}) {
  if (!(await isOperatorRequest()))
    return <OperatorAccessRequired feature="academy" />;
  const lesson = lessonBySlug((await params).slug);
  if (lesson === null) notFound();
  // Previous and next stay inside the lesson's course.
  const { previous, next } = neighboursIn(ACADEMY_LESSONS, lesson.slug);
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

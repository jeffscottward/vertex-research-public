import { isCourseId } from "@darkfactory/academy";
import { PageHeader } from "@darkfactory/ui";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { AcademyGallery } from "../../../../../components/portal/academy/academy-gallery.tsx";
import {
  type AcademySearchParams,
  readAcademyGalleryQuery,
} from "../../../../../components/portal/academy/academy-gallery-query.ts";
import { OperatorAccessRequired } from "../../../../../components/portal/agent-ops-client.tsx";
import { loadCourseLessons } from "../../../../../lib/academy-lessons.ts";
import { academyMedia } from "../../../../../lib/academy-media.ts";
import { getRequestPortalSession } from "../../../../../lib/request-portal-session.ts";

export const metadata = { title: "Academy" };

/** One course's lesson gallery (/academy/c/<course id>, ids from the course registry). */
export default async function AcademyCoursePage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ course: string }>;
  searchParams: Promise<AcademySearchParams>;
}>) {
  const requestHeaders = await headers();
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  if (session?.isOperator !== true)
    return (
      <div className="space-y-6">
        <PageHeader title="Academy" variant="portal" />
        <OperatorAccessRequired feature="academy" />
      </div>
    );
  const { course } = await params;
  if (!isCourseId(course)) notFound();
  const { lessons, sourceCount } = await loadCourseLessons(
    course,
    requestHeaders.get("cookie")
  );
  return (
    <AcademyGallery
      course={course}
      initialQuery={readAcademyGalleryQuery(await searchParams)}
      lessons={lessons}
      media={academyMedia()}
      sourceCount={sourceCount}
    />
  );
}

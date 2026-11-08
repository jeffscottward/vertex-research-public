import { COURSE_LIST } from "@darkfactory/academy";
import { PageHeader } from "@darkfactory/ui";
import { headers } from "next/headers";
import {
  AcademyCatalog,
  type AcademyCourseListing,
} from "../../../components/portal/academy/academy-gallery.tsx";
import {
  type AcademySearchParams,
  readAcademyGalleryQuery,
} from "../../../components/portal/academy/academy-gallery-query.ts";
import { OperatorAccessRequired } from "../../../components/portal/agent-ops-client.tsx";
import { loadCourseLessons } from "../../../lib/academy-lessons.ts";
import { academyMedia } from "../../../lib/academy-media.ts";
import { getRequestPortalSession } from "../../../lib/request-portal-session.ts";

export const metadata = { title: "Academy" };

export default async function AcademyPage({
  searchParams,
}: Readonly<{ searchParams: Promise<AcademySearchParams> }>) {
  const requestHeaders = await headers();
  // Same cached lookup as the portal layout. The Academy shows private transcripts: operators only.
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
  // Database courses (QuantFinanceToGo) come through academy.lessons; one read at a time per request.
  const courses: AcademyCourseListing[] = [];
  for (const course of COURSE_LIST)
    courses.push({
      course: course.id,
      ...(await loadCourseLessons(course.id, requestHeaders.get("cookie"))),
    });
  return (
    <AcademyCatalog
      courses={courses}
      initialQuery={readAcademyGalleryQuery(await searchParams)}
      media={academyMedia()}
    />
  );
}

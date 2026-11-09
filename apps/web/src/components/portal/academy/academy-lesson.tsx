"use client";

import { courseOf, DEFAULT_COURSE_ID, type Lesson } from "@darkfactory/academy";
import { PageHeader, StatusBadge } from "@darkfactory/ui";
import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import {
  type AcademyGateway,
  createBrowserAcademyGateway,
} from "./academy-client.ts";
import type { AcademyMediaEntry } from "./academy-gallery.tsx";
import { AcademyThemeScope, AcademyThemeToggle } from "./academy-theme.tsx";
import { labelOf } from "./labels.ts";
import { LessonBacktest } from "./lesson-backtest.tsx";
import { LessonDeploy } from "./lesson-deploy.tsx";
import { LessonInteractive } from "./lesson-interactive.tsx";
import { LessonVideo } from "./lesson-video.tsx";

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

const Section = ({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) => (
  <section
    aria-labelledby={`${id}-title`}
    className="flex scroll-mt-20 flex-col gap-3"
    id={id}
  >
    <h2 className="font-heading font-semibold text-xl" id={`${id}-title`}>
      {title}
    </h2>
    {children}
  </section>
);

export type AcademyLessonProps = Readonly<{
  lesson: Lesson;
  media: AcademyMediaEntry | null;
  previous: { slug: string; title: string } | null;
  next: { slug: string; title: string } | null;
  gateway?: AcademyGateway;
}>;

export const AcademyLesson = ({
  lesson,
  media,
  previous,
  next,
  gateway: injected,
}: AcademyLessonProps) => {
  const gateway = useMemo(
    () => injected ?? createBrowserAcademyGateway(),
    [injected]
  );
  const course = courseOf(lesson);
  const strategy = lesson.kind === "strategy" && lesson.backtest !== undefined;
  const sections = [
    ["video", course.narrated ? "Video" : "Animation"],
    ["interactive", "Interactive example"],
    ...(strategy
      ? [
          ["backtest", "Backtest"],
          ["deploy", "Deploy"],
        ]
      : []),
    ["transcript", "Transcript"],
  ] as const;
  return (
    <AcademyThemeScope>
      <article
        className="mx-auto flex max-w-7xl flex-col gap-8"
        data-academy-lesson={lesson.slug}
      >
        <div className="flex flex-col gap-3">
          <PageHeader
            actions={<AcademyThemeToggle />}
            breadcrumb={
              <nav aria-label="Breadcrumb">
                <Link
                  className="inline-flex min-h-11 items-center gap-1 hover:text-foreground"
                  href="/academy"
                  prefetch={false}
                >
                  <ArrowLeft aria-hidden className="size-4" /> Academy
                </Link>
                {course.id === DEFAULT_COURSE_ID ? null : (
                  <>
                    {" / "}
                    <Link
                      className="inline-flex min-h-11 items-center hover:text-foreground"
                      href={`/academy/c/${course.id}`}
                      prefetch={false}
                    >
                      {course.title}
                    </Link>
                  </>
                )}
              </nav>
            }
            description={lesson.summary}
            status={
              <StatusBadge
                data-lesson-kind={strategy ? "strategy" : "concept"}
                status={strategy ? "info" : "neutral"}
              >
                {strategy ? "Strategy" : "Concept lesson"}
              </StatusBadge>
            }
            title={lesson.title}
          />
          <div className="flex flex-wrap items-center gap-2">
            {[
              ...lesson.tags.regime,
              ...lesson.tags.instruments,
              lesson.tags.timeframe,
              lesson.tags.risk,
            ].map((tag) => (
              <span
                className="rounded border border-border px-1.5 py-0.5 text-muted-foreground text-xs"
                key={tag}
              >
                {labelOf(tag)}
              </span>
            ))}
          </div>
          {course.narrated ? null : (
            <p className="text-sm">
              <a
                className="inline-flex min-h-11 items-center gap-1 font-medium underline"
                data-source-reel
                href={lesson.source.url}
                rel="noreferrer"
                target="_blank"
              >
                Source reel by {course.creator}{" "}
                <ExternalLink aria-hidden className="size-4" />
              </a>
            </p>
          )}
          <nav aria-label="Lesson sections" className="flex flex-wrap gap-2">
            {sections.map(([id, label]) => (
              <a
                className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm hover:bg-muted"
                href={`#${id}`}
                key={id}
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
        <Section
          id="video"
          title={course.narrated ? "Chart video" : "Chart animation"}
        >
          <LessonVideo
            lesson={lesson}
            media={media}
            narrated={course.narrated}
          />
        </Section>
        <Section id="interactive" title="Interactive example">
          <LessonInteractive lesson={lesson} />
        </Section>
        <section aria-label="Key points" className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-border p-3">
            <h2 className="mb-2 font-semibold text-sm">Takeaways</h2>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {lesson.takeaways.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-border p-3">
            <h2 className="mb-2 font-semibold text-sm">Caveats</h2>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
              {[...lesson.caveats, course.disclaimer].map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </section>
        {strategy ? (
          <>
            <Section id="backtest" title="Backtest">
              <LessonBacktest gateway={gateway} lesson={lesson} />
            </Section>
            <Section id="deploy" title="Deploy (paper request)">
              <LessonDeploy gateway={gateway} lesson={lesson} />
            </Section>
          </>
        ) : (
          <p
            className="rounded-lg border border-border p-3 text-muted-foreground text-sm"
            data-concept-note
          >
            Concept lesson: this video explains an idea and has no tradeable
            rule set, so it has no backtest and no deploy button.
          </p>
        )}
        <Section id="transcript" title="Transcript">
          <p className="text-muted-foreground text-sm">
            Source:{" "}
            <a
              className="inline-flex items-center gap-1 underline"
              href={lesson.source.url}
              rel="noreferrer"
              target="_blank"
            >
              {lesson.source.caption.slice(0, 90)}{" "}
              <ExternalLink aria-hidden className="size-3" />
            </a>{" "}
            · published {lesson.source.publishedAt.slice(0, 10)} ·{" "}
            {clock(lesson.source.durationSeconds)}.{" "}
            {course.timestamps === "estimated"
              ? "Timestamps are estimated from word position (speech-to-text without segment times)."
              : "Timestamps are the speech-to-text segment start times."}
          </p>
          <ol
            className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm"
            data-transcript
          >
            {lesson.source.transcript.map((line) => (
              <li
                className="flex gap-3"
                key={`${line.start}-${line.text.slice(0, 12)}`}
              >
                <span className="w-12 shrink-0 text-muted-foreground tabular-nums">
                  {clock(line.start)}
                </span>
                <span>{line.text}</span>
              </li>
            ))}
          </ol>
        </Section>
        <nav
          aria-label="More lessons"
          className="flex flex-wrap justify-between gap-3 border-border border-t pt-4 text-sm"
        >
          {previous === null ? (
            <span />
          ) : (
            <Link
              className="min-h-11 underline"
              href={`/academy/${previous.slug}`}
              prefetch={false}
            >
              ← {previous.title}
            </Link>
          )}
          {next === null ? (
            <span />
          ) : (
            <Link
              className="min-h-11 underline"
              href={`/academy/${next.slug}`}
              prefetch={false}
            >
              {next.title} →
            </Link>
          )}
        </nav>
      </article>
    </AcademyThemeScope>
  );
};

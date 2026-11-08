// What: The Academy course registry. A course is one creator's lesson series (one knowledge-base
// folder of transcripts). Every course-specific string (gallery copy, disclaimer, strategy prefix,
// library section, spec and source locations) comes from here, so adding a course is one entry plus
// its sources file (docs/vertex-academy.md, "Courses").

export const COURSE_IDS = ["dyr", "quantfinancetogo"] as const;
export type CourseId = (typeof COURSE_IDS)[number];

/** Course of a spec or source that does not name one (every Define Your Risk lesson). */
export const DEFAULT_COURSE_ID: CourseId = "dyr";

export type Course = Readonly<{
  id: CourseId;
  /** Display name of the course (gallery section heading, course picker). */
  title: string;
  /** Short label for compact places (strategy names, badges). */
  shortTitle: string;
  /** Who made the source videos. */
  creator: string;
  platform: "instagram";
  /** Public profile of the creator. */
  profileUrl: string;
  /** Knowledge-base folder, relative to the knowledge-bases checkout root. */
  kbPath: string;
  /** One-line subtitle of the course gallery. */
  tagline: string;
  /** Shown under every gallery and in every lesson's caveats. */
  disclaimer: string;
  /** Narrated courses have rendered MP4s with narration timing; others show the live animation only. */
  narrated: boolean;
  /** How the transcript start times were made. */
  timestamps: "estimated" | "segments";
  /** Slug prefix of the strategy-library records created by this course's Academy deploys. */
  strategyPrefix: string;
  /** Strategy-library section of those records. */
  librarySection: string;
  /** First strategy-library tag of those records. */
  strategyTag: string;
  /** Spec folder below packages/academy/src/lessons/specs ("" = the specs folder itself). */
  specDir: string;
  /** Sources file in packages/academy/src/lessons (scripts/academy/build-sources.ts). */
  sourcesFile: string;
}>;

export const COURSES: Readonly<Record<CourseId, Course>> = {
  dyr: {
    id: "dyr",
    title: "Define Your Risk",
    shortTitle: "DYR",
    creator: "Define Your Risk",
    platform: "instagram",
    profileUrl: "https://www.instagram.com/defineyourrisk/",
    kbPath: "trading/define-your-risk-instagram",
    tagline:
      "Define Your Risk options lessons: video, interactive chart, backtest",
    disclaimer:
      "Educational content based on Define Your Risk videos. Charts use illustrative values and Black-Scholes pricing. Backtests are modeled, not historical option fills. Nothing here is advice or an order.",
    narrated: true,
    timestamps: "estimated",
    strategyPrefix: "dyr-",
    librarySection: "Define Your Risk Academy",
    strategyTag: "define-your-risk",
    specDir: "",
    sourcesFile: "sources.json",
  },
  quantfinancetogo: {
    id: "quantfinancetogo",
    title: "QuantFinanceToGo",
    shortTitle: "QFTG",
    creator: "QuantFinanceToGo",
    platform: "instagram",
    profileUrl: "https://www.instagram.com/quantfinancetogo/",
    kbPath: "trading/quantfinancetogo",
    tagline:
      "QuantFinanceToGo quant finance lessons: interactive chart and the source reel",
    disclaimer:
      "Educational concepts based on QuantFinanceToGo reels. Charts use illustrative values and textbook models; the creator's numbers and claims are not verified. Nothing here is advice or an order.",
    narrated: false,
    timestamps: "segments",
    strategyPrefix: "qftg-",
    librarySection: "QuantFinanceToGo Academy",
    strategyTag: "quantfinancetogo",
    specDir: "quantfinancetogo",
    sourcesFile: "sources.quantfinancetogo.json",
  },
};

/** Courses in display order (the default course first). */
export const COURSE_LIST: readonly Course[] = COURSE_IDS.map(
  (id) => COURSES[id]
);

export const courseOf = (
  value: Readonly<{ course?: CourseId | undefined }>
): Course => COURSES[value.course ?? DEFAULT_COURSE_ID];

export const isCourseId = (value: string): value is CourseId =>
  (COURSE_IDS as readonly string[]).includes(value);

/** Strategy-library slug of a lesson's Academy strategy (`dyr-<slug>`, `qftg-<slug>`). */
export const academyStrategySlug = (
  lesson: Readonly<{ slug: string; course?: CourseId | undefined }>
): string => `${courseOf(lesson).strategyPrefix}${lesson.slug}`;

/** The course whose Academy created this strategy slug, or null for any other strategy. */
export const courseOfStrategySlug = (slug: string): Course | null =>
  COURSE_LIST.find((course) => slug.startsWith(course.strategyPrefix)) ?? null;

/** True for every Academy strategy slug of every course (these deploy only from the lesson page). */
export const isAcademyStrategySlug = (slug: string): boolean =>
  courseOfStrategySlug(slug) !== null;

/** Lesson slug behind an Academy strategy slug, or null for any other strategy. */
export const lessonSlugOfStrategy = (slug: string): string | null => {
  const course = courseOfStrategySlug(slug);
  return course === null ? null : slug.slice(course.strategyPrefix.length);
};

/** Repository-relative path of a lesson's spec file. */
export const lessonSpecPath = (
  lesson: Readonly<{ slug: string; course?: CourseId | undefined }>
): string => {
  const { specDir } = courseOf(lesson);
  return `packages/academy/src/lessons/specs/${specDir === "" ? "" : `${specDir}/`}${lesson.slug}.json`;
};

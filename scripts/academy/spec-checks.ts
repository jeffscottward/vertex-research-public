// What: Draw checks shared by the Academy spec tools (build-lesson-index.ts, import-lessons.ts): a
// spec that LessonSpecSchema accepts must also build its scenes, tables and captions with finite
// points at the start, middle and end of the animation.
import {
  buildScene,
  buildTables,
  type LessonSpec,
  lessonVtt,
} from "../../packages/academy/src/index.ts";
import { defaultValues } from "../../packages/academy/src/position.ts";

/** Builds the lesson's scenes, tables and captions; returns one message per problem. */
export const sceneErrors = (file: string, lesson: LessonSpec): string[] => {
  const errors: string[] = [];
  try {
    const values = defaultValues(lesson.params);
    for (const t of [0, 0.5, 1]) {
      const scene = buildScene(lesson, values, t);
      for (const panel of scene.panels)
        for (const series of panel.series)
          if (
            series.points.some(
              (point) =>
                !(Number.isFinite(point[0]) && Number.isFinite(point[1]))
            )
          )
            errors.push(
              `${file}: non-finite point in ${panel.id}/${series.element} at t=${t}`
            );
      buildTables(lesson, values, t);
    }
    lessonVtt(lesson);
  } catch (error) {
    errors.push(
      `${file}: scene failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return errors;
};

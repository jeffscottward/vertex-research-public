import { createVertexExperienceCommands } from "./vertex-experience-commands.ts";
import { createVertexExperienceReads } from "./vertex-experience-reads.ts";
import type { VertexExperienceDependencies } from "./vertex-experience-core.ts";

export const createVertexExperienceService = (
  dependencies: VertexExperienceDependencies = {}
) =>
  Object.freeze({
    ...createVertexExperienceReads(dependencies),
    ...createVertexExperienceCommands(dependencies),
  });
export type VertexExperienceService = ReturnType<
  typeof createVertexExperienceService
>;

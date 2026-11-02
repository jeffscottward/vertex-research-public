import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Root = Readonly<{ id: string; sourcePath: string }>;
type RegistryModule = Readonly<{
  default: Readonly<{ roots: readonly Root[] }>;
}>;

// The parent directory of this checkout, as inspection.ts binds it.
const checkoutParent = dirname(
  fileURLToPath(new URL("../../", import.meta.url))
);

/**
 * The reviewed root registry, re-rooted beside this checkout.
 *
 * migration-matrix.json records the absolute sourcePath of each sibling
 * repository on the reviewing machine. A checkout anywhere else (CI, or a
 * project renamed by `bun run init`) binds none of them, so every fixture
 * repository would fail closed. Pass vi.mock's importOriginal: the registry
 * must keep one common parent, and only that parent moves; ids, roots and the
 * repository-id check stay exactly as reviewed.
 */
export const rerootRegistry = async (
  importOriginal: <Module>() => Promise<Module>
): Promise<RegistryModule> => {
  const module = await importOriginal<RegistryModule>();
  const { roots } = module.default;
  const parents = new Set(roots.map((root) => dirname(root.sourcePath)));
  if (
    parents.size !== 1 ||
    roots.some((root) => root.sourcePath !== join(...parents, root.id))
  ) {
    throw new Error("migration-matrix roots no longer share one parent");
  }
  return {
    ...module,
    default: {
      ...module.default,
      roots: roots.map((root) => ({
        ...root,
        sourcePath: join(checkoutParent, root.id),
      })),
    },
  };
};

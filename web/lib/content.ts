import fs from "fs";
import path from "path";
import type {
  ContentPackManifest,
  LabCatalogEntry,
  LabReference,
} from "./types";

function resolveContentRoot(): string {
  const configured = process.env.CONTENT_ROOT;
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(process.cwd(), configured);
  }
  return path.resolve(process.cwd(), "..", "ContentPacks");
}

function readManifest(packDir: string): ContentPackManifest | null {
  const manifestPath = path.join(packDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as ContentPackManifest;
  if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.modules)) {
    throw new Error(`Invalid content pack manifest at ${manifestPath}`);
  }
  return parsed;
}

export function getContentRoot(): string {
  const root = resolveContentRoot();
  if (!fs.existsSync(root)) {
    throw new Error(`Content root does not exist: ${root}`);
  }
  return root;
}

export function loadPacks(): ContentPackManifest[] {
  const root = getContentRoot();
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const packs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readManifest(path.join(root, entry.name)))
    .filter((manifest): manifest is ContentPackManifest => manifest !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
  if (packs.length === 0) {
    throw new Error(`No content pack manifests found under ${root}`);
  }
  return packs;
}

export function getLabCatalog(packId?: string): LabCatalogEntry[] {
  const packs = loadPacks().filter((pack) =>
    packId ? pack.id === packId : true
  );
  const catalog: LabCatalogEntry[] = [];
  for (const pack of packs) {
    for (const module of pack.modules) {
      for (const lab of module.labs) {
        if (lab.surface === "commandAlphabet") {
          continue;
        }
        catalog.push({
          packId: pack.id,
          packTitle: pack.title,
          moduleId: module.id,
          moduleTitle: module.title,
          labId: lab.id,
          labTitle: lab.title,
          kind: lab.kind,
          summary: lab.summary,
          estimatedMinutes: lab.estimatedMinutes,
          prompt: lab.prompt,
          hints: lab.hints ?? [],
          isAwsLab: Boolean(lab.aws),
        });
      }
    }
  }
  return catalog;
}

export function getLab(packId: string, labId: string): LabReference {
  const root = getContentRoot();
  const packRoot = path.join(root, packId);
  const manifest = readManifest(packRoot);
  if (!manifest) {
    throw new Error(`Content pack not found: ${packId}`);
  }
  for (const module of manifest.modules) {
    const lab = module.labs.find((candidate) => candidate.id === labId);
    if (lab) {
      return {
        packId: manifest.id,
        packRoot,
        packTitle: manifest.title,
        packVersion: manifest.version,
        moduleId: module.id,
        moduleTitle: module.title,
        lab,
      };
    }
  }
  throw new Error(`Lab not found: ${packId}/${labId}`);
}

export function findCatalogEntry(
  packId: string,
  labId: string
): LabCatalogEntry | null {
  return (
    getLabCatalog(packId).find(
      (entry) => entry.packId === packId && entry.labId === labId
    ) ?? null
  );
}

export function findCatalogEntryByLabId(labId: string): LabCatalogEntry | null {
  return getLabCatalog().find((entry) => entry.labId === labId) ?? null;
}

export function getCatalogGrouped(): Array<{
  packId: string;
  packTitle: string;
  labs: LabCatalogEntry[];
}> {
  const catalog = getLabCatalog();
  const grouped = new Map<string, { packId: string; packTitle: string; labs: LabCatalogEntry[] }>();
  for (const entry of catalog) {
    const existing = grouped.get(entry.packId);
    if (existing) {
      existing.labs.push(entry);
    } else {
      grouped.set(entry.packId, {
        packId: entry.packId,
        packTitle: entry.packTitle,
        labs: [entry],
      });
    }
  }
  return [...grouped.values()];
}

export function graderExecutablePath(reference: LabReference): string {
  // The grader path comes from the (trusted, code-reviewed) manifest, but guard against
  // a path that escapes the content pack — defense in depth against a poisoned manifest.
  const packRoot = path.resolve(reference.packRoot);
  const resolved = path.resolve(packRoot, reference.lab.grader.executable);
  if (resolved !== packRoot && !resolved.startsWith(packRoot + path.sep)) {
    throw new Error(
      `Grader executable escapes the content pack: ${reference.lab.grader.executable}`
    );
  }
  return resolved;
}

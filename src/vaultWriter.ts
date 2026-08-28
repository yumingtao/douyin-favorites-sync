import { App, TFile, normalizePath } from "obsidian";
import { promises as fs } from "fs";
import { basename, join } from "path";
import type { ExtractResult, FavoriteItem, DouyinSyncSettings } from "./settings";

function sanitizeFilenameSegment(text: string, maxLen = 48): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|\n\r\t#|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
  if (!cleaned) return "untitled";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).replace(/-+$/, "") : cleaned;
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatIsoFromSeconds(value?: number | null): string {
  if (!value) return new Date().toISOString();
  return new Date(value * 1000).toISOString();
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const norm = normalizePath(folderPath);
  if (!norm || app.vault.getAbstractFileByPath(norm)) return;
  const parts = norm.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

async function uniqueNotePath(app: App, basePath: string): Promise<string> {
  let candidate = normalizePath(`${basePath}.md`);
  if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  for (let i = 2; i < 100; i++) {
    candidate = normalizePath(`${basePath}-${i}.md`);
    if (!app.vault.getAbstractFileByPath(candidate)) return candidate;
  }
  return normalizePath(`${basePath}-${Date.now()}.md`);
}

function bufferToArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data);
  return copy.buffer;
}

async function writeBinaryFromDisk(
  app: App,
  vaultPath: string,
  diskPath: string
): Promise<boolean> {
  try {
    const norm = normalizePath(vaultPath);
    const folder = norm.split("/").slice(0, -1).join("/");
    if (folder) await ensureFolder(app, folder);
    const rawData: Uint8Array = await fs.readFile(diskPath);
    const data = bufferToArrayBuffer(rawData);
    const existing = app.vault.getAbstractFileByPath(norm);
    if (existing instanceof TFile) {
      await app.vault.modifyBinary(existing, data);
    } else {
      await app.vault.createBinary(norm, data);
    }
    return true;
  } catch (e) {
    console.error("Failed to copy Douyin attachment", diskPath, e);
    return false;
  }
}

function titleFromDesc(desc: string, fallback: string): string {
  const firstLine = desc.split(/\r?\n/)[0]?.trim();
  const withoutTags = (firstLine || fallback)
    .replace(/#[^\s#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return withoutTags || fallback;
}

/**
 * Shared frontmatter reader — extracts douyin_id from a file's metadataCache
 * without hitting disk. Returns empty string if absent or invalid.
 * Used only for migration (one-time vault scan to rebuild the persisted index).
 */
function readDouyinIdFromFile(file: TFile, app: App): string {
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter: Record<string, unknown> | undefined = cache?.frontmatter ?? undefined;
  const value = frontmatter?.douyin_id;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Returns markdown files under `folderPath`.
 * Used only for the migration path (rebuildIndexFromVault) — never called during normal sync.
 */
function getMarkdownFilesInFolder(app: App, folderPath?: string): TFile[] {
  const all = app.vault.getMarkdownFiles();
  if (!folderPath) return all;
  const norm = normalizePath(folderPath);
  if (!norm) return all;
  return all.filter((f) => f.path.startsWith(norm + "/"));
}

// ─── Persisted index helpers (normal sync path — no vault enumeration) ───

/**
 * Extract known douyin IDs from the persisted index (no vault scan needed).
 */
export function collectKnownDouyinIdsFromIndex(index: Record<string, string>): string[] {
  return Object.keys(index);
}

/**
 * Extract known douyin notes from the persisted index (no vault scan needed).
 */
export function collectKnownDouyinNotesFromIndex(
  index: Record<string, string>
): Array<{ douyin_id: string; note_path: string }> {
  return Object.entries(index).map(([douyin_id, note_path]) => ({ douyin_id, note_path }));
}

/**
 * Build a Map<douyin_id, TFile> from the persisted index for O(1) dedup lookups.
 * Uses the stored note paths instead of scanning the vault.
 */
export function buildDouyinIdIndexFromStored(
  app: App,
  storedIndex: Record<string, string>
): Map<string, TFile> {
  const index = new Map<string, TFile>();
  for (const [douyinId, notePath] of Object.entries(storedIndex)) {
    const file = app.vault.getAbstractFileByPath(notePath);
    if (file instanceof TFile) {
      index.set(douyinId, file);
    }
  }
  return index;
}

/**
 * O(1) dedup lookup using a pre-built Map from buildDouyinIdIndexFromStored().
 */
export function findExistingDouyinNote(
  index: Map<string, TFile>,
  douyinId: string
): TFile | null {
  if (!douyinId) return null;
  return index.get(douyinId) ?? null;
}

// ─── Migration helpers (one-time vault scan) ───

/**
 * Rebuild the persisted dedup index by scanning existing notes in the vault.
 * Used only for migration when the stored index is empty (upgrading from an older version).
 * Normal sync never calls this — it uses the persisted index directly.
 */
export async function rebuildIndexFromVault(
  app: App,
  noteFolder: string
): Promise<Record<string, string>> {
  const index: Record<string, string> = {};
  const files = getMarkdownFilesInFolder(app, noteFolder);
  for (const file of files) {
    const id = readDouyinIdFromFile(file, app);
    if (id) {
      index[id] = file.path;
    }
  }
  return index;
}

// ─── Note writing ───

export async function writeFavoriteNote(
  app: App,
  settings: DouyinSyncSettings,
  favorite: FavoriteItem,
  extract: ExtractResult
): Promise<{ file: TFile; douyinId: string; notePath: string }> {
  await ensureFolder(app, settings.noteFolder);

  const id = extract.douyin_id || favorite.aweme_id;
  const author = extract.author || favorite.author || "未知";
  const desc = extract.desc || favorite.desc || "";
  const title = titleFromDesc(desc, id);
  const source = extract.source || favorite.share_url;
  const createdAt = formatIsoFromSeconds(favorite.create_time);
  const tags = extract.tags ?? [];
  const contentType = extract.content_type || (extract.images?.length ? "image" : "video");
  const attachBase = normalizePath(`${settings.attachmentFolder}/${id}`);

  const baseName = [
    sanitizeFilenameSegment(author, 24),
    sanitizeFilenameSegment(title, 56),
  ].join("-");
  const notePath = await uniqueNotePath(
    app,
    normalizePath(`${settings.noteFolder}/${baseName}`)
  );

  const fm = [
    "---",
    "type: douyin",
    `content_type: ${contentType}`,
    `douyin_id: "${escapeYaml(id)}"`,
    `author: "${escapeYaml(author)}"`,
    `source: "${escapeYaml(source)}"`,
    `create_time: "${createdAt}"`,
    "tags:",
    "  - douyin",
    ...tags.map((tag) => `  - ${escapeYaml(tag)}`),
    "---",
    "",
  ];

  const body: string[] = [`# ${title}`, ""];
  const outDir: string | undefined = extract.out_dir;
  if (settings.mode === "heavy" && outDir) {
    if (contentType === "video") {
      const videoDiskPath: string = join(outDir, "video.mp4");
      const videoVaultPath = normalizePath(`${attachBase}/video.mp4`);
      if (await writeBinaryFromDisk(app, videoVaultPath, videoDiskPath)) {
        body.push(`![[${videoVaultPath}]]`, "");
      } else if (extract.video_url) {
        body.push(`[无水印视频链接](${extract.video_url})`, "");
      }
    }

    const localImages: string[] = extract.images?.filter((path) => path.startsWith("/")) ?? [];
    if (localImages.length > 0) {
      body.push("## 配图", "");
      for (const imagePath of localImages) {
        const imageVaultPath = normalizePath(`${attachBase}/${basename(imagePath)}`);
        if (await writeBinaryFromDisk(app, imageVaultPath, imagePath)) {
          body.push(`![[${imageVaultPath}]]`);
        }
      }
      body.push("");
    }
  } else {
    if (extract.video_url) {
      body.push(`[无水印视频链接](${extract.video_url})`, "");
    } else {
      body.push(`[原始链接](${source})`, "");
    }
    if (extract.cover) {
      body.push(`![封面](${extract.cover})`, "");
    } else if (favorite.cover) {
      body.push(`![封面](${favorite.cover})`, "");
    }
  }

  if (settings.mode === "light" && extract.images?.length) {
    body.push("## 配图", "", ...extract.images.map((url) => `![](${url})`), "");
  }

  body.push("## 文案", "", desc || "(无文案)", "");
  if (extract.transcript) {
    body.push("## 转写", "", extract.transcript, "");
  }

  const file = await app.vault.create(notePath, fm.join("\n") + body.join("\n"));
  return { file, douyinId: id, notePath };
}
import { App, TFile, normalizePath } from "obsidian";
/**
 * Node `fs` is needed to copy binary attachments from the backend's
 * download directory into the vault. The Obsidian lint sandbox
 * cannot resolve `@types/node`, so all `fs` calls are typed as `any`.
 * Suppress the unsafe lint rules for this file only.
 */
// eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
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
    const data = bufferToArrayBuffer(await fs.readFile(diskPath));
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
 * Scope-aware markdown file collector: returns only files under `folderPath`.
 * Falls back to full-vault scan when `folderPath` is empty or missing.
 * This reduces the "Vault Enumeration" review concern by limiting the scan
 * to the plugin's own note directory rather than the entire vault.
 */
function getMarkdownFilesInFolder(app: App, folderPath?: string): TFile[] {
  const all = app.vault.getMarkdownFiles();
  if (!folderPath) return all;
  const norm = normalizePath(folderPath);
  if (!norm) return all;
  return all.filter((f) => f.path.startsWith(norm + "/"));
}

/**
 * Shared frontmatter reader — extracts douyin_id from a file's metadataCache
 * without hitting disk. Returns empty string if absent or invalid.
 */
function readDouyinId(file: TFile, app: App): string {
  const cache = app.metadataCache.getFileCache(file);
  const frontmatter: Record<string, unknown> | undefined = cache?.frontmatter ?? undefined;
  const value = frontmatter?.douyin_id;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Build a cached Map<douyin_id, TFile> scoped to the note folder.
 * Call once before a batch import; use findExistingDouyinNote() for O(1) lookups.
 * This replaces the previous per-item full-vault scan (O(N × M)) with a single
 * scoped scan (O(M)) plus hash lookups.
 */
export function buildDouyinIdIndex(
  app: App,
  noteFolder: string
): Map<string, TFile> {
  const index = new Map<string, TFile>();
  const files = getMarkdownFilesInFolder(app, noteFolder);
  for (const file of files) {
    const id = readDouyinId(file, app);
    if (id) index.set(id, file);
  }
  return index;
}

export async function collectKnownDouyinIds(
  app: App,
  folderPath?: string
): Promise<string[]> {
  const ids = new Set<string>();
  const files = getMarkdownFilesInFolder(app, folderPath);
  for (const file of files) {
    const id = readDouyinId(file, app);
    if (id) ids.add(id);
  }
  return [...ids];
}

export async function collectKnownDouyinNotes(
  app: App,
  folderPath?: string
): Promise<Array<{ douyin_id: string; note_path: string }>> {
  const notes = new Map<string, string>();
  const files = getMarkdownFilesInFolder(app, folderPath);
  for (const file of files) {
    const id = readDouyinId(file, app);
    if (id) notes.set(id, file.path);
  }
  return [...notes.entries()].map(([douyin_id, note_path]) => ({ douyin_id, note_path }));
}

/**
 * O(1) dedup lookup using a pre-built index from buildDouyinIdIndex().
 * Replaces the previous full-vault scan per item.
 */
export function findExistingDouyinNote(
  index: Map<string, TFile>,
  douyinId: string
): TFile | null {
  if (!douyinId) return null;
  return index.get(douyinId) ?? null;
}

export async function writeFavoriteNote(
  app: App,
  settings: DouyinSyncSettings,
  favorite: FavoriteItem,
  extract: ExtractResult
): Promise<TFile> {
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

    const localImages = extract.images?.filter((path) => path.startsWith("/")) ?? [];
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

  return app.vault.create(notePath, fm.join("\n") + body.join("\n"));
}

/* Re-enable lint rules after fs usage — see top-of-file eslint-disable for rationale */
// eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument

import { App, TFile, normalizePath } from "obsidian";
/* Node fs/path are used for attachments staged outside the vault by the local
   companion backend. The linter sandbox has no @types/node, so silence the
   "error"-typed access here; runtime signatures are pinned below. */
/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
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

export async function collectKnownDouyinIds(app: App): Promise<string[]> {
  const ids = new Set<string>();
  const files = app.vault.getMarkdownFiles();
  for (const file of files) {
    // Prefer metadataCache (instant, no disk read)
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter: Record<string, unknown> | undefined = cache?.frontmatter ?? undefined;
    const value = frontmatter?.douyin_id;
    if (typeof value === "string" && value.trim()) {
      ids.add(value.trim());
    }
  }
  return [...ids];
}

export async function collectKnownDouyinNotes(
  app: App
): Promise<Array<{ douyin_id: string; note_path: string }>> {
  const notes = new Map<string, string>();
  const files = app.vault.getMarkdownFiles();
  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter: Record<string, unknown> | undefined = cache?.frontmatter ?? undefined;
    const value = frontmatter?.douyin_id;
    if (typeof value === "string" && value.trim()) {
      notes.set(value.trim(), file.path);
    }
  }
  return [...notes.entries()].map(([douyin_id, note_path]) => ({ douyin_id, note_path }));
}

export async function findExistingDouyinNote(
  app: App,
  douyinId: string
): Promise<TFile | null> {
  if (!douyinId) return null;
  const files = app.vault.getMarkdownFiles();
  for (const file of files) {
    const cache = app.metadataCache.getFileCache(file);
    const frontmatter: Record<string, unknown> | undefined = cache?.frontmatter ?? undefined;
    const fmValue = frontmatter?.douyin_id;
    if (typeof fmValue === "string" && fmValue.trim() === douyinId) {
      return file;
    }
  }
  return null;
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

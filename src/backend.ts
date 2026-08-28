import { requestUrl } from "obsidian";
import type {
  DouyinSyncSettings,
  ExtractResult,
  FavoriteItem,
  SyncFavoritesResponse,
  WhisperModel,
} from "./settings";

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export async function checkHealth(
  backendUrl: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = `${normalizeBaseUrl(backendUrl)}/api/health`;
  const viaRequestUrl = await tryRequestUrl(url);
  if (viaRequestUrl !== null) return viaRequestUrl;
  // requestUrl 在客户端失败（Electron net 栈可能缓存了指向已重启后端的失效连接，
  // 请求不会到达服务器）——降级用原生 fetch 重试，走全新的连接。
  return tryFetch(url);
}

async function tryRequestUrl(
  url: string
): Promise<{ ok: boolean; status?: number; error?: string } | null> {
  try {
    const resp = await Promise.race([
      requestUrl({ url, method: "GET" }),
      new Promise<never>((_, reject) =>
        window.setTimeout(() => reject(new Error("timeout")), 5000)
      ),
    ]);
    return { ok: resp.status === 200, status: resp.status };
  } catch {
    // requestUrl 失败（含 HTTP 非 2xx 时的抛错）一律降级 fetch 重试，
    // 由 fetch 给出权威结果
    return null;
  }
}

async function tryFetch(
  url: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    return { ok: resp.status === 200, status: resp.status };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function syncFavorites(
  backendUrl: string,
  knownIds: string[],
  max = 30
): Promise<FavoriteItem[]> {
  const resp = await requestUrl({
    url: `${normalizeBaseUrl(backendUrl)}/api/sync/favorites`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ known_ids: knownIds, max }),
  });

  if (resp.status === 401) {
    throw new Error("AUTH_EXPIRED");
  }
  if (resp.status >= 400) {
    throw new Error(`SYNC_HTTP_${resp.status}`);
  }

  const data = JSON.parse(resp.text) as SyncFavoritesResponse;
  return data.items ?? [];
}

interface ExtractJob {
  job_id: string;
  status: string;
  progress?: number;
  stage?: string;
  result?: ExtractResult;
  error?: string;
}

export async function extractFavorite(
  backendUrl: string,
  url: string,
  mode: "light" | "heavy",
  model: WhisperModel
): Promise<ExtractResult> {
  // Step 1: create async extraction job
  const createResp = await requestUrl({
    url: `${normalizeBaseUrl(backendUrl)}/api/jobs/extract`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode, model }),
  });

  if (createResp.status >= 400) {
    throw new Error(`EXTRACT_CREATE_HTTP_${createResp.status}:${createResp.text}`);
  }

  const { job_id } = JSON.parse(createResp.text) as { job_id: string };

  // Step 2: poll until done
  // heavy: 下载视频 + Whisper 转写，长视频/大模型耗时可达 20min+，上限 30min
  const maxAttempts = mode === "heavy" ? 900 : 120; // heavy: 30min, light: 4min
  const intervalMs = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(intervalMs);

    const pollResp = await requestUrl({
      url: `${normalizeBaseUrl(backendUrl)}/api/jobs/${job_id}`,
      method: "GET",
    });

    if (pollResp.status >= 400) {
      throw new Error(`EXTRACT_POLL_HTTP_${pollResp.status}:${pollResp.text}`);
    }

    const job = JSON.parse(pollResp.text) as ExtractJob;

    if (job.status === "ok" && job.result) {
      return job.result;
    }
    if (job.status === "error") {
      throw new Error(job.error || "EXTRACT_FAILED");
    }
    // still running, keep polling
  }

  throw new Error("EXTRACT_TIMEOUT");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function registerVaultConfig(
  backendUrl: string,
  settings: DouyinSyncSettings,
  vaultPath: string,
  knownNotes: Array<{ douyin_id: string; note_path: string }>
): Promise<void> {
  const resp = await requestUrl({
    url: `${normalizeBaseUrl(backendUrl)}/api/config/vault`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vault_path: vaultPath,
      note_folder: settings.noteFolder,
      attachment_folder: settings.attachmentFolder,
      known_notes: knownNotes,
    }),
  });

  if (resp.status >= 400) {
    throw new Error(`VAULT_CONFIG_HTTP_${resp.status}:${resp.text}`);
  }
}

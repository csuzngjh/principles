/**
 * Build-time fetch of the latest PD Companion release.
 *
 * Bakes {version, url, sizeBytes} into .vitepress/theme/companion-release.json
 * so the download page never depends on the VISITOR's ability to reach
 * api.github.com (unreliable/blocked in CN; client-side fetch degraded the
 * page to a fallback link for the exact users we serve).
 *
 * Runtime contract (rc-1): the GitHub API response is untrusted — every
 * field is validated before use. On failure the previous JSON is kept (or a
 * null seed is written) and the build CONTINUES: the page then shows the
 * fallback link loudly, never a fabricated version (rc-9).
 *
 * URL safety: fixed https host `api.github.com` only — no dynamic host.
 */
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = 'https://api.github.com/repos/csuzngjh/principles/releases?per_page=30';
const parsedApiUrl = new URL(API_URL);
if (parsedApiUrl.protocol !== 'https:' || parsedApiUrl.hostname !== 'api.github.com') {
  throw new Error(`fetch-companion-release: unexpected API URL "${API_URL}"`);
}

const themeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.vitepress', 'theme');
const outputPath = path.join(themeDir, 'companion-release.json');
const RETRIES = 3;

function nullSeed() {
  return { version: null, url: null, sizeBytes: null, tag: null, fetchedAt: new Date().toISOString() };
}

function validateReleases(data) {
  if (!Array.isArray(data)) throw new Error('releases payload was not an array');
  for (const rel of data) {
    if (typeof rel !== 'object' || rel === null) continue;
    const tag = rel.tag_name;
    if (typeof tag !== 'string' || !tag.startsWith('companion-v')) continue;
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const exe = assets.find(
      (asset) =>
        typeof asset === 'object' &&
        asset !== null &&
        typeof asset.name === 'string' &&
        asset.name.endsWith('-setup.exe') &&
        typeof asset.browser_download_url === 'string',
    );
    if (exe) {
      return {
        version: tag.replace('companion-v', ''),
        url: exe.browser_download_url,
        sizeBytes: typeof exe.size === 'number' ? exe.size : null,
        tag,
        fetchedAt: new Date().toISOString(),
      };
    }
  }
  return null; // no companion release published yet
}

async function fetchWithRetries() {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(API_URL, {
        headers: { 'User-Agent': 'principles-website-build', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[fetch-companion-release] attempt ${attempt}/${RETRIES} failed: ${lastError}`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw new Error(`all ${RETRIES} attempts failed: ${lastError}`);
}

try {
  const data = await fetchWithRetries();
  const release = validateReleases(data) ?? nullSeed();
  await writeFile(outputPath, JSON.stringify(release, null, 2) + '\n', 'utf8');
  console.log(`[fetch-companion-release] baked companion-v${release.version ?? '(none)'}`);
} catch (err) {
  // Degrade loudly but keep the build green: keep the previous baked JSON if
  // it exists (stale beats broken), else write a null seed.
  let kept = null;
  try {
    const previous = JSON.parse(await readFile(outputPath, 'utf8'));
    if (typeof previous === 'object' && previous !== null) kept = previous;
  } catch {
    /* no previous file */
  }
  await writeFile(outputPath, JSON.stringify(kept ?? nullSeed(), null, 2) + '\n', 'utf8');
  console.warn(`[fetch-companion-release] WARN fetch failed, kept previous/null seed: ${err.message}`);
}

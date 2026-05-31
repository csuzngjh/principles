import semver from 'semver';

export interface UpdateCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  error?: string;
}

export async function checkForUpdates(currentVersion: string): Promise<UpdateCheckResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    let latestVersion = '';
    try {
      const response = await fetch('https://registry.npmjs.org/create-principles-disciple/latest', {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const rawData: unknown = await response.json();
      if (typeof rawData !== 'object' || rawData === null) {
        throw new Error('Invalid registry response: not an object');
      }
      const data = rawData as Record<string, unknown>;
      if (typeof data.version !== 'string') {
        throw new Error('Invalid registry response: missing version');
      }
      latestVersion = data.version;
    } finally {
      clearTimeout(timeoutId);
    }

    const hasUpdate = semver.gt(latestVersion, currentVersion);

    return {
      hasUpdate,
      currentVersion,
      latestVersion,
    };
  } catch (error) {
    return {
      hasUpdate: false,
      currentVersion,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function fetchChangelog(version: string): Promise<string | undefined> {
  try {
    const response = await fetch('https://registry.npmjs.org/create-principles-disciple');
    if (!response.ok) {
      return undefined;
    }

    const rawData: unknown = await response.json();
    if (typeof rawData !== 'object' || rawData === null) {
      return undefined;
    }
    const data = rawData as Record<string, unknown>;
    if (typeof data.versions !== 'object' || data.versions === null) {
      return undefined;
    }
    const versions = data.versions as Record<string, unknown>;
    const versionEntry = versions[version];
    if (typeof versionEntry !== 'object' || versionEntry === null) {
      return undefined;
    }
    const entry = versionEntry as Record<string, unknown>;
    if (typeof entry.description !== 'string') {
      return undefined;
    }
    return entry.description;
  } catch {
    return undefined;
  }
}

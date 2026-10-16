/**
 * Minimal GitLab REST client for CI jobs, authenticated with the job's own CI_JOB_TOKEN (never a
 * personal token). Node builtins only (global fetch), so it runs on the bare Node image.
 */

export interface ApiOptions {
  baseUrl: string;
  jobToken: string;
  fetchImpl?: typeof fetch;
}

export function apiFromEnv(env: NodeJS.ProcessEnv): ApiOptions {
  const baseUrl = env.CI_API_V4_URL;
  const jobToken = env.CI_JOB_TOKEN;
  if (!baseUrl || !jobToken)
    throw new Error('CI_API_V4_URL and CI_JOB_TOKEN are required (run inside a CI job)');
  return { baseUrl: baseUrl.replace(/\/$/, ''), jobToken };
}

export interface ApiResponse {
  status: number;
  text: string;
  nextPage: string | null;
}

export async function apiGet(o: ApiOptions, path: string): Promise<ApiResponse> {
  const res = await (o.fetchImpl ?? fetch)(`${o.baseUrl}${path}`, {
    headers: { 'JOB-TOKEN': o.jobToken },
  });
  return {
    status: res.status,
    text: await res.text(),
    nextPage: res.headers.get('x-next-page') || null,
  };
}

/** GET a JSON list across pages (bounded). Throws on any non-200 answer. */
export async function apiGetAll<T>(o: ApiOptions, path: string, maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  let page: string | null = '1';
  for (let i = 0; page && i < maxPages; i += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await apiGet(o, `${path}${sep}per_page=100&page=${page}`);
    if (r.status !== 200) throw new Error(`GET ${path} -> HTTP ${r.status}`);
    out.push(...(JSON.parse(r.text) as T[]));
    page = r.nextPage;
  }
  return out;
}

// 조사용 작업 통로: KV 'job' 에 작업을 넣으면 1분 크론이 실행하고 'job_result' 에 저장.
// (개발 중 헤이홈 API 구조 파악용 — 사용자 화면과 무관. 조사 끝나면 제거)
import type { Env } from './config';
import * as hej from './hej';

interface Job {
  type: 'web' | 'probe';
  pages?: string[];
  keywords?: string[];
  ctx?: number;
  gets?: string[];
}

async function webScan(job: Job) {
  const pages = job.pages ?? ['https://square.hej.so/list', 'https://square.hej.so/'];
  const kws = job.keywords ?? ['IrDiy', 'diy', 'Diy', 'DIY'];
  const ctxLen = job.ctx ?? 160;
  const scripts = new Set<string>();
  const pageInfo: any[] = [];
  for (const p of pages) {
    try {
      const r = await fetch(p, { redirect: 'follow' });
      const html = await r.text();
      pageInfo.push({ page: p, status: r.status, finalUrl: r.url, len: html.length });
      for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) scripts.add(new URL(m[1], r.url).toString());
    } catch (e: any) { pageInfo.push({ page: p, error: String(e?.message ?? e) }); }
  }
  const hits: any[] = [];
  for (const src of scripts) {
    try {
      const r = await fetch(src);
      const js = await r.text();
      const found: string[] = [];
      for (const kw of kws) {
        let i = js.indexOf(kw), n = 0;
        while (i >= 0 && n < 25) {
          found.push(`[${kw}] ` + js.slice(Math.max(0, i - ctxLen), i + kw.length + ctxLen));
          i = js.indexOf(kw, i + kw.length); n++;
        }
      }
      hits.push({ src, len: js.length, found });
    } catch (e: any) { hits.push({ src, error: String(e?.message ?? e) }); }
  }
  return { pageInfo, scripts: [...scripts], hits };
}

export async function runJob(env: Env, getSession: (env: Env) => Promise<hej.HejSession>): Promise<void> {
  const job = await env.KV.get('job', 'json') as Job | null;
  if (!job) return;
  await env.KV.delete('job');
  let result: unknown;
  try {
    if (job.type === 'web') result = await webScan(job);
    else { const s = await getSession(env); result = await Promise.all((job.gets ?? []).map((p) => hej.rawProbe(s, p))); }
  } catch (e: any) { result = { error: String(e?.message ?? e) }; }
  await env.KV.put('job_result', JSON.stringify({ ts: new Date().toISOString(), job, result }), { expirationTtl: 86400 });
}

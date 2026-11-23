import { DurableObject } from "cloudflare:workers";
import { ASSETS } from "./assets.generated";

export interface Env {
  SEATS: DurableObjectNamespace<SeatStore>;
  ADMIN_TOKEN?: string;
}

type SeatMap = Record<string, number>; // 자리 id -> 손님 앉은 시각(ms). 없으면 빈자리

const SEAT_ID = /^[A-Za-z0-9_-]{1,24}$/;
const MAX_SEATS = 500;

/** 매장 자리 상태 (매장 1곳 = 객체 1개). 모든 요청이 여기로 모여 순서대로 처리됨 */
export class SeatStore extends DurableObject<Env> {
  private async load(): Promise<SeatMap> {
    return (await this.ctx.storage.get<SeatMap>("seats")) ?? {};
  }

  private async save(seats: SeatMap) {
    const updatedAt = Date.now();
    await this.ctx.storage.put({ seats, updatedAt });
    return { seats, updatedAt };
  }

  async snapshot() {
    const seats = await this.load();
    const updatedAt = (await this.ctx.storage.get<number>("updatedAt")) ?? 0;
    return { seats, updatedAt };
  }

  /** occupied 를 주면 그 값으로, 안 주면 반대로 바꿈 */
  async setSeat(id: string, occupied?: boolean) {
    const seats = await this.load();
    const next = occupied ?? !(id in seats);
    if (next) {
      if (!(id in seats) && Object.keys(seats).length >= MAX_SEATS) throw new Error("too many seats");
      seats[id] = seats[id] ?? Date.now();
    } else {
      delete seats[id];
    }
    return this.save(seats);
  }

  async getBoard() {
    return (await this.ctx.storage.get<unknown>("board")) ?? null;
  }

  async setBoard(board: unknown) {
    await this.ctx.storage.put("board", board);
  }

  async reset() {
    return this.save({});
  }

  /** 손님 방문 기록: 하루(한국시간)마다 방문 id → [머문 시간 ms, 광고 클릭 수] */
  async recordVisit(day: string, sid: string, ms: number, ad: number) {
    const key = `v:${day}`;
    const m = (await this.ctx.storage.get<Record<string, [number, number]>>(key)) ?? {};
    if (!m[sid] && Object.keys(m).length >= MAX_VISITS_PER_DAY) return;
    const prev = m[sid] ?? [0, 0];
    m[sid] = [Math.max(prev[0], ms), Math.max(prev[1], ad)];
    await this.ctx.storage.put(key, m);
  }

  async stats(days: string[]) {
    const out = [];
    for (const day of days) {
      const m = (await this.ctx.storage.get<Record<string, [number, number]>>(`v:${day}`)) ?? {};
      const v = Object.values(m);
      const total = v.reduce((a, [ms]) => a + ms, 0);
      out.push({ day, visits: v.length, avgMs: v.length ? Math.round(total / v.length) : 0, adTaps: v.reduce((a, [, ad]) => a + ad, 0) });
    }
    return out;
  }
}

const MAX_VISITS_PER_DAY = 3000;
const kstDay = (offsetDays = 0) => new Date(Date.now() + 9 * 3600e3 - offsetDays * 86400e3).toISOString().slice(0, 10);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function timingSafeEqual(a: string, b: string) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function isAdmin(req: Request, env: Env) {
  const token = req.headers.get("x-admin-token") ?? "";
  return !!env.ADMIN_TOKEN && token.length > 0 && timingSafeEqual(token, env.ADMIN_TOKEN);
}

function serveAsset(req: Request, path: string): Response {
  const f = ASSETS[path];
  if (!f || (req.method !== "GET" && req.method !== "HEAD")) return new Response("Not found", { status: 404 });
  const headers = {
    "content-type": f.type,
    etag: f.etag,
    // 화면 파일은 매번 확인(수정 즉시 반영), three.js 라이브러리는 오래 캐시
    "cache-control": path.startsWith("/vendor/") ? "public, max-age=604800" : "no-cache",
  };
  if (req.headers.get("if-none-match") === f.etag) return new Response(null, { status: 304, headers });
  const body = f.b64 ? Uint8Array.from(atob(f.body), (c) => c.charCodeAt(0)) : f.body;
  return new Response(req.method === "HEAD" ? null : body, { headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const store = env.SEATS.get(env.SEATS.idFromName("store-1"));

    if (url.pathname === "/api/seats" && req.method === "GET") {
      return json(await store.snapshot());
    }

    // 관리자 버튼판 배치 (누구나 읽기, 저장은 관리자)
    if (url.pathname === "/api/board" && req.method === "GET") {
      return json({ board: await store.getBoard() });
    }

    // 손님 체류시간 기록 (로그인 없이, 숫자만 받음)
    if (url.pathname === "/api/visit" && req.method === "POST") {
      const b = (await req.json().catch(() => null)) as { sid?: unknown; ms?: unknown; ad?: unknown } | null;
      const sid = typeof b?.sid === "string" && /^[a-z0-9]{6,32}$/.test(b.sid) ? b.sid : null;
      const ms = typeof b?.ms === "number" && Number.isFinite(b.ms) ? Math.min(Math.max(0, Math.round(b.ms)), 3 * 3600e3) : null;
      const ad = typeof b?.ad === "number" && Number.isFinite(b.ad) ? Math.min(Math.max(0, Math.round(b.ad)), 50) : 0;
      if (!sid || ms === null) return json({ error: "bad visit" }, 400);
      await store.recordVisit(kstDay(), sid, ms, ad);
      return new Response(null, { status: 204 });
    }

    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "POST") return json({ error: "method" }, 405);
      if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN 이 설정되지 않았습니다" }, 500);
      if (!isAdmin(req, env)) return json({ error: "관리자 비밀번호가 틀렸습니다" }, 401);

      if (url.pathname === "/api/login") return json({ ok: true });
      if (url.pathname === "/api/reset") return json(await store.reset());
      if (url.pathname === "/api/board") {
        const b = (await req.json().catch(() => null)) as { board?: unknown } | null;
        const raw = JSON.stringify(b?.board ?? null);
        if (!b?.board || typeof b.board !== "object" || raw.length > 4000) return json({ error: "bad board" }, 400);
        const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
        const src = b.board as { barQ?: unknown; tables?: Record<string, { dx?: unknown; dz?: unknown; s?: unknown }> };
        const tables: Record<string, { dx: number; dz: number; s: number }> = {};
        for (const [id, t] of Object.entries(src.tables ?? {})) {
          if (!SEAT_ID.test(id) || Object.keys(tables).length >= 20) continue;
          tables[id] = { dx: num(t?.dx, -10, 10, 0), dz: num(t?.dz, -10, 10, 0), s: num(t?.s, 0.5, 2.5, 1) };
        }
        const clean = { barQ: num(src.barQ, 0.5, 2, 1.12), tables };
        await store.setBoard(clean);
        return json({ ok: true, board: clean });
      }
      if (url.pathname === "/api/stats") return json({ days: await store.stats([0, 1, 2, 3, 4, 5, 6].map(kstDay)) });

      const m = url.pathname.match(/^\/api\/seats\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!SEAT_ID.test(id)) return json({ error: "bad seat id" }, 400);
        const body = (await req.json().catch(() => ({}))) as { occupied?: unknown };
        const occupied = typeof body.occupied === "boolean" ? body.occupied : undefined;
        try {
          return json(await store.setSeat(id, occupied));
        } catch (e) {
          return json({ error: String((e as Error).message) }, 400);
        }
      }
      return json({ error: "not found" }, 404);
    }

    // /, /admin, /관리자 → 같은 화면(관리자 모드는 화면에서 주소를 보고 결정)
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* 잘못된 주소는 그대로 → 404 */ }
    if (path === "/" || path === "/admin" || path === "/관리자") path = "/index.html";
    return serveAsset(req, path);
  },
} satisfies ExportedHandler<Env>;

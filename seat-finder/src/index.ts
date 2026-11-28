import { DurableObject } from "cloudflare:workers";
import { ASSETS } from "./assets.generated";
import { type Look, cleanLook, cleanName, cleanChat, EMOJIS, randId, hashPw, EMAIL_RE } from "./live";

export interface Env {
  SEATS: DurableObjectNamespace<SeatStore>;
  ADMIN_TOKEN?: string;
  /** 스포티파이 앱 (developer.spotify.com) — 매장에서 지금 나오는 곡 보여주기 */
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  /** 매장 에어컨 앱(heyhome-smart-ac)의 KV — 읽기만 함 (영업시간·실내 온습도·에어컨 상태) */
  AC?: KVNamespace;
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
    const lights = (await this.ctx.storage.get<{ on: boolean; at: number }>("lights")) ?? null;
    return { seats, updatedAt, lights };
  }

  /** 매장 불 스위치 (관리자만): 모든 화면에 적용. 다음 새벽 4시·오전 10시가 되면 시간대 기본값으로 돌아감 */
  // ───────── 스포티파이: 사장님 계정에서 "지금 나오는 곡" 정보만 읽음 (소리는 내보내지 않음) ─────────
  private np: { at: number; data: unknown } | null = null;
  async spotifyState(state?: string) { // 로그인 시작할 때 만든 확인용 번호 저장 / 확인
    if (state === undefined) { const st = randId(16); await this.ctx.storage.put("spState", { st, at: Date.now() }); return st; }
    const v = await this.ctx.storage.get<{ st: string; at: number }>("spState");
    await this.ctx.storage.delete("spState");
    return !!v && v.st === state && Date.now() - v.at < 10 * 60e3;
  }
  async spotifySave(tok: { refresh_token?: string; access_token: string; expires_in: number }) {
    const old = await this.ctx.storage.get<{ refresh: string }>("spotify");
    await this.ctx.storage.put("spotify", { refresh: tok.refresh_token || old?.refresh, access: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 });
    this.np = null;
  }
  async nowPlaying(id?: string, secret?: string) {
    if (this.np && Date.now() - this.np.at < 10000) return this.np.data; // 10초 동안은 저장해 둔 값
    const sp = await this.ctx.storage.get<{ refresh: string; access: string; exp: number }>("spotify");
    let data: unknown = { connected: false };
    if (sp?.refresh && id && secret) {
      try {
        let access = sp.access;
        if (!access || Date.now() > sp.exp) {
          const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + btoa(`${id}:${secret}`) }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: sp.refresh }) });
          if (!r.ok) throw new Error("refresh " + r.status);
          const t = (await r.json()) as { access_token: string; expires_in: number; refresh_token?: string };
          await this.spotifySave(t); access = t.access_token;
        }
        const r = await fetch("https://api.spotify.com/v1/me/player/currently-playing", { headers: { authorization: `Bearer ${access}` } });
        if (r.status === 204) data = { connected: true, playing: false };
        else if (r.ok) {
          const j = (await r.json()) as { is_playing?: boolean; progress_ms?: number; item?: { name?: string; duration_ms?: number; artists?: { name: string }[]; album?: { name?: string; images?: { url: string; width: number }[] }; external_urls?: { spotify?: string } } };
          const it = j.item;
          const imgs = (it?.album?.images || []).slice().sort((a, b) => a.width - b.width);
          const art = (imgs.find((x) => x.width >= 250) || imgs[imgs.length - 1])?.url;
          data = it ? { connected: true, playing: !!j.is_playing, title: it.name, artist: (it.artists || []).map((a) => a.name).join(", "), album: it.album?.name, art: art && /^https:\/\/i\.scdn\.co\//.test(art) ? art : null, url: it.external_urls?.spotify, progress: j.progress_ms, duration: it.duration_ms, at: Date.now() } : { connected: true, playing: false };
        } else data = { connected: true, playing: false, error: r.status };
      } catch { data = { connected: true, playing: false, error: "fail" }; }
    }
    this.np = { at: Date.now(), data };
    return data;
  }

  async setLights(on: boolean) {
    const lights = { on, at: Date.now() };
    await this.ctx.storage.put("lights", lights);
    this.cast({ t: "lights", lights });
    return { lights };
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

  /** 버튼판 배치 + 기본값 (기본값이 아직 없으면 지금 저장된 배치를 기본값으로 삼음) */
  async getBoard() {
    const board = (await this.ctx.storage.get<unknown>("board")) ?? null;
    let def = (await this.ctx.storage.get<unknown>("boardDefault")) ?? null;
    if (!def && board) { def = board; await this.ctx.storage.put("boardDefault", board); }
    return { board, def };
  }

  async setBoard(board: unknown, asDefault = false) {
    await this.ctx.storage.put(asDefault ? { board, boardDefault: board } : { board });
  }

  /** 비밀번호 틀림 횟수 (IP별). blocked = 지금 막혀 있는지 */
  async loginGate(ip: string, failed?: boolean) {
    const key = `lf:${ip}`, now = Date.now();
    let r = (await this.ctx.storage.get<{ n: number; t: number }>(key)) ?? { n: 0, t: now };
    if (now - r.t > LOGIN_WINDOW_MS) r = { n: 0, t: now };
    if (failed === true) { r.n++; await this.ctx.storage.put(key, r); }
    else if (failed === false && r.n) await this.ctx.storage.delete(key);
    return r.n >= LOGIN_MAX_FAILS;
  }

  /** 예전 테스트 방문 기록 지우기 (STATS_SINCE 이전) */
  async purgeOldVisits() {
    const all = await this.ctx.storage.list({ prefix: "v:" });
    const old = [...all.keys()].filter((k) => k.slice(2) < STATS_SINCE);
    if (old.length) await this.ctx.storage.delete(old);
    return old.length;
  }

  async reset() {
    return this.save({});
  }

  /** 손님 방문 기록: 하루(한국시간)마다 방문 id → [머문 시간 ms, 광고 클릭 수] */
  async recordVisit(day: string, sid: string, ms: number, ad: number) {
    if (day < STATS_SINCE) return;
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
      if (day < STATS_SINCE) { out.push({ day, visits: 0, avgMs: 0, adTaps: 0 }); continue; }
      const m = (await this.ctx.storage.get<Record<string, [number, number]>>(`v:${day}`)) ?? {};
      const v = Object.values(m);
      const total = v.reduce((a, [ms]) => a + ms, 0);
      out.push({ day, visits: v.length, avgMs: v.length ? Math.round(total / v.length) : 0, adTaps: v.reduce((a, [, ad]) => a + ad, 0) });
    }
    return out;
  }

  // ───────── 실시간 접속: 매장 안 손님 캐릭터 · 채팅 (채팅은 저장하지 않고 지금 접속한 사람에게만 전달) ─────────
  /** 웹소켓 연결 받기 (Worker 가 /api/live 요청을 그대로 넘겨줌) */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    if (this.ctx.getWebSockets().length >= LIVE_MAX) return new Response("full", { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: "", ip, name: "", look: null, member: null, admin: false, walk: false, x: 0, z: 0, y: 0, s: 0, pt: 0, ct: [], et: 0, mute: 0 } satisfies LiveAtt);
    return new Response(null, { status: 101, webSocket: client });
  }

  private att(ws: WebSocket) { return ws.deserializeAttachment() as LiveAtt; }
  private peerOf(a: LiveAtt) { return { id: a.id, name: a.name, look: a.look, x: a.x, z: a.z, y: a.y, s: a.s, c: a.c ?? 0, sd: a.sd ?? "", boss: a.admin }; }
  private send(ws: WebSocket, m: unknown) { try { ws.send(JSON.stringify(m)); } catch { /* 끊긴 연결 */ } }
  private cast(m: unknown, except?: WebSocket, walkersOnly = false) {
    const raw = JSON.stringify(m);
    for (const w of this.ctx.getWebSockets()) {
      if (w === except) continue;
      const a = this.att(w);
      if (!a.id || a.left || (walkersOnly && !a.walk && !a.admin)) continue;
      try { w.send(raw); } catch { /* 끊긴 연결 */ }
    }
  }
  private online() { return this.ctx.getWebSockets().filter((w) => { const a = this.att(w); return a.id && a.walk; }).length; }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > 800) return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(raw); } catch { return; }
    const a = this.att(ws), now = Date.now();
    const save = () => ws.serializeAttachment(a);

    if (m.t === "hello") { // 첫 인사: 이름·모양 정하고 지금 매장 안 사람들 받기
      if (a.id) return;
      // 내보내기는 휴대폰(브라우저)별로: 매장 와이파이는 손님 모두 같은 IP 라서 IP 로 막으면 다 같이 막힘
      a.dev = typeof m.dev === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(m.dev) ? m.dev : "";
      const ban = a.dev ? await this.ctx.storage.get<number>(`ban:${a.dev}`) : undefined;
      if (ban && ban > now) { this.send(ws, { t: "kicked", until: ban }); try { ws.close(4003, "banned"); } catch { /* 닫힘 */ } return; }
      a.id = randId(6);
      a.walk = m.walk === true;
      const tok = typeof m.admin === "string" ? m.admin : "";
      a.admin = !!this.env.ADMIN_TOKEN && tok.length > 0 && timingSafe(tok, this.env.ADMIN_TOKEN);
      const user = typeof m.session === "string" ? await this.userBySession(m.session) : null;
      if (user) { a.member = user.email; a.name = user.name; a.look = user.look; }
      else { a.name = cleanName(m.name) ?? `손님${Math.floor(100 + Math.random() * 900)}`; }
      if (a.admin) { a.name = (await this.ctx.storage.get<string>("bossName")) ?? "사장님"; a.look = (await this.ctx.storage.get<Look>("bossLook")) ?? BOSS_LOOK; }
      save();
      const peers = this.ctx.getWebSockets().filter((w) => w !== ws).map((w) => this.att(w)).filter((p) => p.id && p.walk).map((p) => this.peerOf(p));
      this.send(ws, { t: "welcome", id: a.id, name: a.name, look: a.look, member: !!a.member, admin: a.admin, peers, emojis: EMOJIS });
      if (a.walk) this.cast({ t: "join", p: this.peerOf(a), n: this.online() }, ws);
      return;
    }
    if (!a.id) return;

    switch (m.t) {
      case "pos": { // 내 위치 (초당 5번까지)
        if (!a.walk || now - a.pt < 150) return;
        const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 100) / 100)) : 0);
        a.x = num(m.x, -30, 40); a.z = num(m.z, -30, 40); a.y = num(m.y, -10, 10); a.s = num(m.s, 0, 1.5); a.c = m.c === 1 ? 1 : 0; a.pt = now;
        const sd = typeof m.sd === "string" && SEAT_ID.test(m.sd) ? m.sd : "";
        if (sd && sd !== a.sd && this.ctx.getWebSockets().some((w) => { if (w === ws) return false; const o = this.att(w); return o.walk && !o.left && o.sd === sd; })) {
          this.send(ws, { t: "seatTaken", sd }); a.sd = ""; a.s = 0; // 한발 늦음: 다른 사람이 이미 앉음
        } else a.sd = sd;
        save();
        this.cast({ t: "p", id: a.id, x: a.x, z: a.z, y: a.y, s: a.s, c: a.c, sd: a.sd }, ws);
        return;
      }
      case "walk": { // 관리자: 3D 매장 안으로 들어감 / 나옴 → 사장님 캐릭터로 보임
        if (!a.admin) return;
        const on = m.on === true;
        if (on === a.walk) return;
        a.walk = on; a.left = false; save();
        if (on) this.cast({ t: "join", p: this.peerOf(a), n: this.online() }, ws);
        else this.cast({ t: "leave", id: a.id, n: this.online() }, ws);
        return;
      }
      case "bosslook": { // 관리자: 사장님 캐릭터 꾸미기
        const look = cleanLook(m.look);
        if (!a.admin || !look) return;
        const name = m.name === undefined ? a.name : cleanName(m.name);
        if (!name) return this.send(ws, { t: "sys", text: "그 이름은 쓸 수 없어요 (1~10자, 욕설 금지)" });
        await this.ctx.storage.put({ bossLook: look, bossName: name });
        const renamed = name !== a.name;
        a.look = look; a.name = name; save();
        this.send(ws, { t: "bosslook", look, name });
        if (a.walk) { this.cast({ t: "look", id: a.id, look }, ws); if (renamed) this.cast({ t: "name", id: a.id, name }, ws); }
        return;
      }
      case "act": { // 점프 등 순간 동작
        if (!a.walk || m.a !== "jump" || now - (a.jt || 0) < 400) return;
        a.jt = now; save();
        this.cast({ t: "act", id: a.id, a: "jump" }, ws);
        return;
      }
      case "chat": {
        if (a.mute > now) return this.send(ws, { t: "sys", text: `잠시 뒤에 다시 보낼 수 있어요 (${Math.ceil((a.mute - now) / 1000)}초)` });
        const text = cleanChat(m.text);
        if (!text) return;
        a.ct = a.ct.filter((t) => now - t < 10000);
        if (a.ct.length && now - a.ct[a.ct.length - 1] < 800) return this.send(ws, { t: "sys", text: "조금 천천히 보내 주세요" });
        a.ct.push(now);
        if (a.ct.length > 5) { a.mute = now + 30000; a.ct = []; save(); return this.send(ws, { t: "sys", text: "너무 빨리 보내서 30초 동안 채팅이 멈춰요" }); }
        save();
        this.cast({ t: "chat", mid: randId(6), id: a.id, name: a.name, boss: a.admin, text, ts: now }, undefined, true);
        return;
      }
      case "emo": { // 감정 이모지 말풍선
        const e = typeof m.e === "string" && EMOJIS.includes(m.e) ? m.e : null;
        if (!e || !a.walk || now - a.et < 700) return;
        a.et = now; save();
        this.cast({ t: "emo", id: a.id, e });
        return;
      }
      case "name": {
        const name = cleanName(m.name);
        if (!name) return this.send(ws, { t: "sys", text: "그 이름은 쓸 수 없어요 (1~10자, 욕설 금지)" });
        if (a.admin && !a.walk) return;
        a.name = name; save();
        if (a.member) await this.updateUser(a.member, { name });
        this.cast({ t: "name", id: a.id, name });
        return;
      }
      case "look": { // 캐릭터 꾸미기 (회원만)
        const look = cleanLook(m.look);
        if (!look || !a.member) return;
        a.look = look; save();
        await this.updateUser(a.member, { look });
        this.cast({ t: "look", id: a.id, look });
        return;
      }
      case "mod": { // 관리자: 글 지우기 · 내보내기
        if (!a.admin) return;
        if (m.op === "del" && typeof m.mid === "string" && m.mid.length < 20) return this.cast({ t: "del", mid: m.mid });
        if (m.op === "kick" && typeof m.id === "string") {
          for (const w of this.ctx.getWebSockets()) {
            const p = this.att(w);
            if (p.id !== m.id || p.admin) continue;
            if (p.dev) await this.ctx.storage.put(`ban:${p.dev}`, now + BAN_MS);
            this.send(w, { t: "kicked" });
            try { w.close(4003, "kicked"); } catch { /* 이미 끊김 */ }
            this.gone(w, p);
          }
        }
        return;
      }
    }
  }

  private gone(ws: WebSocket, a = this.att(ws)) {
    if (!a.id || a.left) return;
    a.left = true; try { ws.serializeAttachment(a); } catch { /* 닫힌 연결 */ }
    if (a.walk) this.cast({ t: "leave", id: a.id, n: this.online() }, ws);
  }
  async webSocketClose(ws: WebSocket) { this.gone(ws); }
  async webSocketError(ws: WebSocket) { this.gone(ws); }

  // ───────── 간단 회원가입 (이메일 + 비밀번호). 비밀번호는 PBKDF2 로 바꿔서만 저장 ─────────
  private async userBySession(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const s = await this.ctx.storage.get<{ email: string; exp: number }>(`s:${token}`);
    if (!s || s.exp < Date.now()) return null;
    const u = await this.ctx.storage.get<User>(`u:${s.email}`);
    return u ? { email: s.email, name: u.name, look: u.look } : null;
  }
  private async updateUser(email: string, patch: Partial<Pick<User, "name" | "look">>) {
    const u = await this.ctx.storage.get<User>(`u:${email}`);
    if (u) await this.ctx.storage.put(`u:${email}`, { ...u, ...patch });
  }
  private async newSession(email: string) {
    const token = randId(24);
    await this.ctx.storage.put(`s:${token}`, { email, exp: Date.now() + SESSION_MS });
    return token;
  }
  /** 가입·로그인 시도 제한 (IP 하나당 15분에 20번) */
  private async accountGate(ip: string) {
    const key = `af:${ip}`, now = Date.now();
    let r = (await this.ctx.storage.get<{ n: number; t: number }>(key)) ?? { n: 0, t: now };
    if (now - r.t > LOGIN_WINDOW_MS) r = { n: 0, t: now };
    r.n++; await this.ctx.storage.put(key, r);
    return r.n > 20;
  }
  async account(op: string, b: Record<string, unknown>, ip: string): Promise<{ status: number; text: string }> {
    const res = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });
    const err = (status: number, error: string) => res(status, { error });
    if (op === "signup" || op === "signin") {
      if (await this.accountGate(ip)) return err(429, "너무 많이 시도했어요. 15분 뒤에 다시 해 주세요");
      const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
      const pw = typeof b.pw === "string" ? b.pw : "";
      if (!EMAIL_RE.test(email)) return err(400, "이메일 주소를 확인해 주세요");
      if (pw.length < 6 || pw.length > 72) return err(400, "비밀번호는 6자 이상으로 해 주세요");
      const key = `u:${email}`;
      const u = await this.ctx.storage.get<User>(key);
      if (op === "signup") {
        if (u) return err(409, "이미 가입한 이메일이에요. 로그인해 주세요");
        const name = cleanName(b.name) ?? `손님${Math.floor(100 + Math.random() * 900)}`;
        const look = cleanLook(b.look) ?? (cleanLook({}) as Look);
        await this.ctx.storage.put(key, { ...(await hashPw(pw)), name, look, at: Date.now() } satisfies User);
        return res(200, { session: await this.newSession(email), name, look });
      }
      if (!u || (await hashPw(pw, u.salt)).hash !== u.hash) return err(401, "이메일이나 비밀번호가 맞지 않아요");
      return res(200, { session: await this.newSession(email), name: u.name, look: u.look });
    }
    const token = typeof b.session === "string" ? b.session : "";
    const me = await this.userBySession(token);
    if (op === "logout") { if (me) await this.ctx.storage.delete(`s:${token}`); return res(200, { ok: true }); }
    if (!me) return err(401, "다시 로그인해 주세요");
    if (op === "me") return res(200, { name: me.name, look: me.look });
    if (op === "profile") { // 이름·캐릭터 저장
      const patch: Partial<Pick<User, "name" | "look">> = {};
      if (b.name !== undefined) { const n = cleanName(b.name); if (!n) return err(400, "그 이름은 쓸 수 없어요 (1~10자, 욕설 금지)"); patch.name = n; }
      if (b.look !== undefined) { const l = cleanLook(b.look); if (!l) return err(400, "bad look"); patch.look = l; }
      await this.updateUser(me.email, patch);
      return res(200, { name: patch.name ?? me.name, look: patch.look ?? me.look });
    }
    if (op === "delete") { // 탈퇴: 계정 정보 지우기
      await this.ctx.storage.delete([`u:${me.email}`, `s:${token}`]);
      return res(200, { ok: true });
    }
    return err(404, "not found");
  }
}

type LiveAtt = { id: string; ip: string; dev?: string; c?: number; jt?: number; sd?: string; name: string; look: Look | null; member: string | null; admin: boolean; walk: boolean; x: number; z: number; y: number; s: number; pt: number; ct: number[]; et: number; mute: number; left?: boolean };
type User = { salt: string; hash: string; name: string; look: Look; at: number };
const BOSS_LOOK = { b: 1, h: 1, s: 0, a: 0, hs: 0, e: 0, m: 0, bl: 0, g: 0, f: 0, t: 1, p: 1, pc: 1, sh: 1, sc: 1, ap: 1 } as Look; // 사장님 기본 모습
const LIVE_MAX = 60; // 동시에 붙을 수 있는 사람 수
const BAN_MS = 60 * 60e3; // 내보낸 손님은 1시간 동안 못 들어옴
const SESSION_MS = 180 * 86400e3; // 로그인 유지 180일
const timingSafe = (x: string, y: string) => {
  const ea = new TextEncoder().encode(x), eb = new TextEncoder().encode(y);
  let d = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) d |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return d === 0;
};

const MAX_VISITS_PER_DAY = 3000;
/** 방문 통계는 이 날짜(한국시간) 0시부터 셈 — 개발·테스트 중 방문은 제외 */
const STATS_SINCE = "2026-11-24";
/** 관리자 비밀번호 틀림 제한: IP 하나당 15분에 10번 */
const LOGIN_MAX_FAILS = 10, LOGIN_WINDOW_MS = 15 * 60e3;
const kstDay = (offsetDays = 0) => new Date(Date.now() + 9 * 3600e3 - offsetDays * 86400e3).toISOString().slice(0, 10);

const SEC_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
// 화면(HTML): 같은 사이트의 스크립트만, 다른 사이트에 끼워 넣기(iframe) 금지
const CSP = "default-src 'self'; script-src 'self' 'sha256-x1TAhLj6rKB/Bc8IgFvrpLhJuvFs40ISRM3iiU77Ty4='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' https: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-src https://open.spotify.com";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SEC_HEADERS },
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
  const headers: Record<string, string> = {
    ...SEC_HEADERS,
    ...(f.type.startsWith("text/html") ? { "content-security-policy": CSP.replace("connect-src 'self'", `connect-src 'self' wss://${new URL(req.url).host}`), "x-frame-options": "DENY" } : {}),
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

    // 매장 정보 (에어컨 앱이 저장한 값을 읽기만): 영업시간, 실내 온도·습도, 에어컨 켜짐
    if (url.pathname === "/api/store" && req.method === "GET") {
      const cache = (caches as unknown as { default: Cache }).default;
      const key = new Request(new URL("/api/store", url.origin).toString());
      const hit = await cache.match(key);
      if (hit) return hit;
      let body: Record<string, unknown> = {};
      if (env.AC) {
        const [cfg, state, last] = await Promise.all([
          env.AC.get<{ hours?: unknown }>("config", "json").catch(() => null),
          env.AC.get<{ status?: { ts?: string; indoorTemp?: number | null; indoorHumidity?: number | null } }>("state", "json").catch(() => null),
          env.AC.get<{ power?: boolean; mode?: string }>("lastCommand", "json").catch(() => null),
        ]);
        const st = state?.status;
        body = { hours: cfg?.hours ?? null, temp: st?.indoorTemp ?? null, hum: st?.indoorHumidity ?? null, at: st?.ts ?? null, acOn: last ? !!last.power : null, acMode: last?.mode ?? null };
      }
      const res = new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" } });
      await cache.put(key, res.clone()).catch(() => {});
      return res;
    }

    // 관리자 버튼판 배치 (누구나 읽기, 저장은 관리자)
    // 지금 매장에서 나오는 곡 (스포티파이) — 누구나 읽기
    if (url.pathname === "/api/nowplaying" && req.method === "GET") return json(await store.nowPlaying(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET));
    if (url.pathname === "/api/nowplaying/art" && req.method === "GET") { // 앨범 표지 (스포티파이 이미지 서버만, 같은 주소로 받아 3D 화면에 그림)
      const u = url.searchParams.get("u") || "";
      if (!/^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(u)) return new Response("bad", { status: 400 });
      const r = await fetch(u, { cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit);
      return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=86400", ...SEC_HEADERS } });
    }
    // 스포티파이 연결 마무리 (로그인 후 돌아오는 곳)
    if (url.pathname === "/api/spotify/callback" && req.method === "GET") {
      const code = url.searchParams.get("code") || "", state = url.searchParams.get("state") || "";
      const back = (m: string) => Response.redirect(`${url.origin}/admin?spotify=${m}`, 302);
      if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET || !code || !(await store.spotifyState(state))) return back("fail");
      const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`) }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${url.origin}/api/spotify/callback` }) });
      if (!r.ok) return back("fail");
      await store.spotifySave((await r.json()) as { refresh_token?: string; access_token: string; expires_in: number });
      return back("ok");
    }

    if (url.pathname === "/api/board" && req.method === "GET") {
      return json(await store.getBoard());
    }

    // 손님 체류시간 기록 (로그인 없이, 숫자만 받음)
    if (url.pathname === "/api/visit" && req.method === "POST") {
      if (Number(req.headers.get("content-length") || 0) > 1024) return json({ error: "too large" }, 413);
      const b = (await req.json().catch(() => null)) as { sid?: unknown; ms?: unknown; ad?: unknown } | null;
      const sid = typeof b?.sid === "string" && /^[a-z0-9]{6,32}$/.test(b.sid) ? b.sid : null;
      const ms = typeof b?.ms === "number" && Number.isFinite(b.ms) ? Math.min(Math.max(0, Math.round(b.ms)), 3 * 3600e3) : null;
      const ad = typeof b?.ad === "number" && Number.isFinite(b.ad) ? Math.min(Math.max(0, Math.round(b.ad)), 50) : 0;
      if (!sid || ms === null) return json({ error: "bad visit" }, 400);
      await store.recordVisit(kstDay(), sid, ms, ad);
      return new Response(null, { status: 204 });
    }

    // 실시간 접속 (웹소켓) → 매장 객체로 그대로 넘김
    if (url.pathname === "/api/live") {
      const origin = req.headers.get("origin");
      if (origin && new URL(origin).host !== url.host) return new Response("bad origin", { status: 403 });
      return store.fetch(req);
    }

    // 손님 회원가입·로그인 (이메일 + 비밀번호)
    const acc = url.pathname.match(/^\/api\/account\/(signup|signin|me|profile|logout|delete)$/);
    if (acc) {
      if (req.method !== "POST") return json({ error: "method" }, 405);
      if (Number(req.headers.get("content-length") || 0) > 2048) return json({ error: "too large" }, 413);
      const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      const r = await store.account(acc[1], b, req.headers.get("cf-connecting-ip") || "unknown");
      return new Response(r.text, { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SEC_HEADERS } });
    }

    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "POST") return json({ error: "method" }, 405);
      if (!env.ADMIN_TOKEN) return json({ error: "관리자 설정이 필요합니다" }, 500);
      if (Number(req.headers.get("content-length") || 0) > 16384) return json({ error: "too large" }, 413);
      const ip = req.headers.get("cf-connecting-ip") || "unknown";
      if (await store.loginGate(ip)) return json({ error: "비밀번호를 여러 번 틀렸어요. 15분 뒤에 다시 시도해 주세요" }, 429);
      if (!isAdmin(req, env)) { await store.loginGate(ip, true); return json({ error: "관리자 비밀번호가 틀렸습니다" }, 401); }
      if (url.pathname === "/api/login") await store.loginGate(ip, false);

      if (url.pathname === "/api/login") return json({ ok: true });
      if (url.pathname === "/api/reset") return json(await store.reset());
      if (url.pathname === "/api/purge-visits") return json({ removed: await store.purgeOldVisits() });
      if (url.pathname === "/api/board") {
        const b = (await req.json().catch(() => null)) as { board?: unknown; asDefault?: unknown } | null;
        const raw = JSON.stringify(b?.board ?? null);
        if (!b?.board || typeof b.board !== "object" || raw.length > 8000) return json({ error: "bad board" }, 400);
        const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
        const src = b.board as { barQ?: unknown; bar?: { dx?: unknown; dz?: unknown }; seats?: Record<string, { dx?: unknown; dz?: unknown; r?: unknown }>; tables?: Record<string, { dx?: unknown; dz?: unknown; s?: unknown; r?: unknown }> };
        const tables: Record<string, { dx: number; dz: number; s: number; r: number }> = {};
        for (const [id, t] of Object.entries(src.tables ?? {})) {
          if (!SEAT_ID.test(id) || Object.keys(tables).length >= 20) continue;
          tables[id] = { dx: num(t?.dx, -10, 10, 0), dz: num(t?.dz, -10, 10, 0), s: num(t?.s, 0.5, 2.5, 1), r: num(t?.r, 0, 360, 0) };
        }
        const seats: Record<string, { dx: number; dz: number; r: number }> = {};
        for (const [id, t] of Object.entries(src.seats ?? {})) {
          if (!SEAT_ID.test(id) || Object.keys(seats).length >= 60) continue;
          seats[id] = { dx: num(t?.dx, -10, 10, 0), dz: num(t?.dz, -10, 10, 0), r: num(t?.r, 0, 360, 0) };
        }
        const clean = { barQ: num(src.barQ, 0.5, 2, 1.12), bar: { dx: num(src.bar?.dx, -10, 10, 0), dz: num(src.bar?.dz, -10, 10, 0) }, seats, tables };
        await store.setBoard(clean, b.asDefault === true);
        return json({ ok: true, board: clean });
      }
      if (url.pathname === "/api/spotify/start") { // 사장님: 스포티파이 연결 시작 → 로그인 주소
        if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return json({ error: "Cloudflare 에 SPOTIFY_CLIENT_ID · SPOTIFY_CLIENT_SECRET 을 먼저 넣어 주세요" }, 400);
        const state = String(await store.spotifyState());
        const q = new URLSearchParams({ response_type: "code", client_id: env.SPOTIFY_CLIENT_ID, scope: "user-read-currently-playing user-read-playback-state", redirect_uri: `${url.origin}/api/spotify/callback`, state });
        return json({ url: `https://accounts.spotify.com/authorize?${q}` });
      }
      if (url.pathname === "/api/lights") {
        const b = (await req.json().catch(() => null)) as { on?: unknown } | null;
        if (typeof b?.on !== "boolean") return json({ error: "bad lights" }, 400);
        return json(await store.setLights(b.on));
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

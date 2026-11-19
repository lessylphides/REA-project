// Cloudflare Worker 엔트리
//  - scheduled(cron): 주기적으로 센서 읽고 에어컨 자동 제어
//  - fetch(http):     상태 확인 + on/off + 설정 UI/API
import { Config, DEFAULT_CONFIG, Env, DesiredAcState, MODE_CODES, FAN_CODES } from './config';
import * as hej from './hej';
import { getWeather, Weather } from './weather';
import { decide, scheduleState, Reading } from './engine';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- KV 설정/상태 ----------
async function loadConfig(env: Env): Promise<Config> {
  const raw = await env.KV.get('config', 'json');
  return { ...DEFAULT_CONFIG, ...(raw as Partial<Config> | null) };
}
async function saveConfig(env: Env, cfg: Config): Promise<void> {
  await env.KV.put('config', JSON.stringify(cfg));
}

// ---------- 헤이홈 로그인 정보 (웹에서 입력 → KV 저장, 없으면 시크릿) ----------
interface Creds { email: string; password: string; }
async function getCreds(env: Env): Promise<Creds> {
  const c = await env.KV.get('creds', 'json') as Creds | null;
  if (c?.email && c?.password) return c;
  if (env.HEJ_EMAIL && env.HEJ_PASSWORD) return { email: env.HEJ_EMAIL, password: env.HEJ_PASSWORD };
  throw new Error('헤이홈 로그인이 설정되지 않았습니다 (웹에서 이메일/비번 입력)');
}
async function hasCreds(env: Env): Promise<boolean> {
  const c = await env.KV.get('creds', 'json') as Creds | null;
  return !!(c?.email && c?.password) || !!(env.HEJ_EMAIL && env.HEJ_PASSWORD);
}

// ---------- 세션 캐시(로그인 재사용) ----------
async function getSession(env: Env): Promise<hej.HejSession> {
  const cached = await env.KV.get('session', 'json') as hej.HejSession | null;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;
  const { email, password } = await getCreds(env);
  const s = await hej.login(email, password);
  await env.KV.put('session', JSON.stringify(s));
  return s;
}

// ---------- 센서값 파싱 ----------
function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return null;
}
/** 온습도계 deviceState 에서 온도/습도 추출 (여러 벤더 키 대응) */
function readSensor(state: Record<string, unknown>): { temp: number | null; humidity: number | null } {
  // 온도: va_temperature/prm_temperature 는 보통 10배 정수
  let temp: number | null = null;
  for (const k of ['va_temperature', 'prm_temperature', 'temp_current', 'temperature', 'current_temperature']) {
    const v = num(state[k]);
    if (v !== null) { temp = (k.startsWith('va_') || k.startsWith('prm_')) ? v / 10 : (v > 60 ? v / 10 : v); break; }
  }
  let humidity: number | null = null;
  for (const k of ['va_humidity', 'humidity', 'humidity_value']) {
    const v = num(state[k]);
    if (v !== null) { humidity = v; break; }
  }
  return { temp, humidity };
}

// ---------- 에어컨에 desired 적용 (변경분만, 하나씩) ----------
async function applyDesired(s: hej.HejSession, acId: string, desired: DesiredAcState, last: DesiredAcState | null): Promise<string[]> {
  const sent: string[] = [];
  const changed = (k: keyof DesiredAcState) => !last || last[k] !== desired[k];

  if (changed('power')) { await hej.control(s, acId, { power: desired.power }); sent.push(`power=${desired.power}`); await sleep(500); }
  if (desired.power) {
    if (changed('mode')) { await hej.control(s, acId, { mode: MODE_CODES[desired.mode] }); sent.push(`mode=${desired.mode}`); await sleep(500); }
    if (changed('temperature')) { await hej.control(s, acId, { temperature: desired.temperature }); sent.push(`temp=${desired.temperature}`); await sleep(500); }
    if (changed('fanSpeed')) { await hej.control(s, acId, { fanSpeed: FAN_CODES[desired.fanSpeed] }); sent.push(`fan=${desired.fanSpeed}`); }
  }
  return sent;
}

interface RunStatus {
  ts: string;
  ok: boolean;
  enabled: boolean;
  indoorTemp?: number | null;
  indoorHumidity?: number | null;
  outdoorTemp?: number | null;
  seasonMode?: string;
  action?: string;
  reason?: string;
  sent?: string[];
  alert?: { type: 'hot' | 'cold'; temp: number; threshold: number } | null;
  scheduleState?: string;
  targetTemp?: number | null;
  weather?: Weather | null;
  error?: string;
}

// ---------- 온도 기록(히스토리) ----------
async function appendHistory(env: Env, point: { t: number; temp: number; hum: number | null; out: number | null }): Promise<void> {
  const arr = (await env.KV.get('history', 'json') as any[]) || [];
  arr.push(point);
  await env.KV.put('history', JSON.stringify(arr.slice(-1008))); // 최근 ~7일(10분 간격)
}

// ---------- 자동화 1회 실행 ----------
async function runOnce(env: Env, opts: { force?: boolean; preview?: boolean; log?: boolean } = {}): Promise<RunStatus> {
  const status: RunStatus = { ts: new Date().toISOString(), ok: false, enabled: false };
  try {
    const cfg = await loadConfig(env);
    status.enabled = cfg.enabled;
    if (!cfg.sensorDeviceId || !cfg.acDeviceId) { status.reason = '센서/에어컨 기기 ID 미설정 (설정에서 지정하세요)'; if (!opts.preview) await env.KV.put('status', JSON.stringify(status)); return status; }

    const s = await getSession(env);
    const families = await hej.getFamilies(s);
    if (!families.length) throw new Error('집(family) 목록이 비어 있음');
    const devices = await hej.getDevices(s, families[0].familyId);

    const sensor = devices.find((d) => d.id === cfg.sensorDeviceId);
    if (!sensor) throw new Error('온습도계 기기를 찾지 못함');
    const { temp, humidity } = readSensor(sensor.deviceState ?? {});
    if (temp === null) throw new Error('센서에서 온도를 읽지 못함 (deviceState 키 확인 필요)');
    status.indoorTemp = temp; status.indoorHumidity = humidity;
    status.alert = temp >= cfg.alertHot ? { type: 'hot', temp, threshold: cfg.alertHot }
                 : temp <= cfg.alertCold ? { type: 'cold', temp, threshold: cfg.alertCold }
                 : null;

    const weather = await getWeather(cfg.lat, cfg.lon, cfg.owmKey || env.OWM_API_KEY);
    status.outdoorTemp = weather?.outdoorTemp ?? null;
    status.weather = weather;

    const reading: Reading = { indoorTemp: temp, indoorHumidity: humidity ?? undefined, outdoorTemp: weather?.outdoorTemp ?? null };
    // 영업시간: 쾌적 목표(22/25) / 비영업: 최저기준(12)~여름경고(30)로 세트백해 절전
    const sched = scheduleState(new Date(), cfg);
    status.scheduleState = sched.state;
    const effCfg = sched.comfort ? cfg : { ...cfg, winterTarget: cfg.alertCold, summerTarget: cfg.alertHot };
    const decision = decide(reading, effCfg);
    status.seasonMode = decision.seasonMode;
    status.action = decision.action;
    status.reason = decision.reason;
    status.targetTemp = decision.seasonMode === 'cooling' ? effCfg.summerTarget
                      : decision.seasonMode === 'heating' ? effCfg.winterTarget : null;

    if (opts.log && temp !== null) await appendHistory(env, { t: Date.now(), temp, hum: humidity, out: weather?.outdoorTemp ?? null });

    if (opts.preview) { status.sent = []; status.ok = true; return status; } // 미리보기: 전송/저장 없음
    if (!cfg.enabled && !opts.force) { status.sent = []; status.ok = true; status.reason = '자동 꺼짐 — 온도 기록만 함'; await env.KV.put('status', JSON.stringify(status)); return status; } // 꺼짐: 기록만

    const last = await env.KV.get('lastCommand', 'json') as DesiredAcState | null;
    if (decision.action === 'set' && decision.desired) {
      status.sent = await applyDesired(s, cfg.acDeviceId, decision.desired, last);
      await env.KV.put('lastCommand', JSON.stringify(decision.desired));
    } else if (decision.action === 'off') {
      const offState: DesiredAcState = { power: false, mode: last?.mode ?? 'cool', temperature: last?.temperature ?? 25, fanSpeed: last?.fanSpeed ?? 'auto' };
      status.sent = await applyDesired(s, cfg.acDeviceId, offState, last);
      await env.KV.put('lastCommand', JSON.stringify(offState));
    } else {
      status.sent = []; // hold: 아무것도 안 보냄
    }
    status.ok = true;
    await env.KV.put('status', JSON.stringify(status));
    return status;
  } catch (e: any) {
    status.error = String(e?.message ?? e);
    if (!opts.preview) await env.KV.put('status', JSON.stringify(status));
    return status;
  }
}

// ---------- 간단 인증 ----------
function authed(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return true; // 토큰 미설정 시 공개(테스트용)
  const url = new URL(req.url);
  return url.searchParams.get('t') === env.ADMIN_TOKEN || req.headers.get('x-admin-token') === env.ADMIN_TOKEN;
}

// ---------- HTTP 핸들러 ----------
export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runOnce(env, { log: true }));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const json = (o: unknown, code = 200) => new Response(JSON.stringify(o, null, 2), { status: code, headers: { 'content-type': 'application/json; charset=utf-8' } });

    if (!authed(req, env)) return json({ error: '인증 필요 (?t=관리자토큰)' }, 401);

    // 상태
    if (url.pathname === '/api/status') {
      const [cfg, st, creds] = await Promise.all([loadConfig(env), env.KV.get('status', 'json'), hasCreds(env)]);
      const hasOwmKey = !!(cfg.owmKey || env.OWM_API_KEY);
      return json({ config: { ...cfg, owmKey: undefined }, hasOwmKey, hasCreds: creds, lastRun: st });
    }
    // 헤이홈 로그인 저장 + 즉시 검증 (비번은 저장만, 응답에 안 돌려줌)
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const b = await req.json<{ email?: string; password?: string }>();
      if (!b.email || !b.password) return json({ ok: false, error: '이메일과 비번을 입력하세요' }, 400);
      await env.KV.put('creds', JSON.stringify({ email: b.email, password: b.password }));
      await env.KV.delete('session'); // 새 로그인으로 교체
      try { await getSession(env); return json({ ok: true }); }
      catch (e: any) { return json({ ok: false, error: String(e?.message ?? e) }, 500); }
    }
    // 수동 실행
    if (url.pathname === '/api/run' && req.method === 'POST') {
      return json(await runOnce(env, { force: true, log: true }));
    }
    // 온도 기록(그래프용)
    if (url.pathname === '/api/history') {
      return json((await env.KV.get('history', 'json')) || []);
    }
    // 미리보기(현재 온도/판단만, 에어컨에 전송 안 함) — 화면 표시용
    if (url.pathname === '/api/preview') {
      return json(await runOnce(env, { preview: true }));
    }
    // 주소 → 좌표 (OpenStreetMap Nominatim)
    if (url.pathname === '/api/geocode') {
      const query = url.searchParams.get('q');
      if (!query) return json({ ok: false, error: '주소를 입력하세요' }, 400);
      try {
        const u = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', 'accept-language': 'ko' });
        const r = await fetch(u, { headers: { 'User-Agent': 'heyhome-smart-ac/1.0 (store climate control)' } });
        const arr = await r.json() as Array<{ lat: string; lon: string; display_name: string }>;
        if (!Array.isArray(arr) || !arr.length) return json({ ok: false, error: '주소를 찾지 못했어요' }, 404);
        return json({ ok: true, lat: Number(arr[0].lat), lon: Number(arr[0].lon), name: arr[0].display_name });
      } catch (e: any) { return json({ ok: false, error: String(e?.message ?? e) }, 500); }
    }
    // on/off 토글
    if (url.pathname === '/api/toggle' && req.method === 'POST') {
      const cfg = await loadConfig(env);
      cfg.enabled = !cfg.enabled;
      await saveConfig(env, cfg);
      return json({ enabled: cfg.enabled });
    }
    // 설정 저장
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = await req.json<Partial<Config>>();
      if ('owmKey' in body && !body.owmKey) delete body.owmKey; // 빈 값이면 기존 키 유지
      const cfg = { ...(await loadConfig(env)), ...body };
      await saveConfig(env, cfg);
      return json({ ...cfg, owmKey: undefined });
    }
    // 기기 목록(센서/에어컨 ID 찾기 + deviceState 확인용)
    if (url.pathname === '/api/devices') {
      try {
        const s = await getSession(env);
        const fams = await hej.getFamilies(s);
        const devs = await hej.getDevices(s, fams[0].familyId);
        return json(devs.map((d) => ({ id: d.id, name: d.name, deviceType: d.deviceType, deviceState: d.deviceState })));
      } catch (e: any) { return json({ error: String(e?.message ?? e) }, 500); }
    }

    // 기본: 간단 UI
    return new Response(renderUI(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
};


// ---------- 웹 UI (iOS 스타일) ----------
function renderUI(): string {
  return `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<title>매장 에어컨</title>
<style>
  :root{
    --bg:#f2f2f7; --card:#fff; --label:#1c1c1e; --sec:#8e8e93; --sep:rgba(60,60,67,.18);
    --blue:#007aff; --green:#34c759; --orange:#ff9500; --red:#ff3b30; --field:#f2f2f7;
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#000; --card:#1c1c1e; --label:#fff; --sec:#8e8e93; --sep:rgba(84,84,88,.55);
    --blue:#0a84ff; --green:#30d158; --orange:#ff9f0a; --red:#ff453a; --field:#2c2c2e;
  }}
  html{touch-action:manipulation;-webkit-text-size-adjust:100%}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:var(--bg);color:var(--label);
    font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text',system-ui,sans-serif;
    padding:max(16px,env(safe-area-inset-top)) 16px calc(32px + env(safe-area-inset-bottom));
    max-width:480px;margin:0 auto;-webkit-font-smoothing:antialiased}
  h1{font-size:28px;font-weight:700;letter-spacing:-.02em;margin:8px 2px 16px}
  .hero{background:var(--card);border-radius:22px;padding:28px 20px 22px;text-align:center;margin-bottom:16px;
    box-shadow:0 1px 3px rgba(0,0,0,.04)}
  .temp{font-size:72px;font-weight:600;letter-spacing:-.04em;line-height:1;margin:2px 0}
  .temp span{font-size:32px;font-weight:500;color:var(--sec)}
  .humid{color:var(--sec);font-size:17px;margin-top:2px}
  .chip{display:inline-flex;align-items:center;gap:7px;margin-top:18px;padding:11px 18px;border-radius:999px;
    font-size:16px;font-weight:600;background:var(--field)}
  .chip .em{font-size:19px}
  .chip.blue{color:var(--blue)} .chip.orange{color:var(--orange)} .chip.green{color:var(--green)} .chip.gray{color:var(--sec)} .chip.red{color:var(--red)}
  .chipsub{color:var(--sec);font-size:13px;margin-top:10px;min-height:16px}
  .schedpill{font-size:12px;padding:3px 10px;border-radius:999px;background:var(--field);font-weight:600;white-space:nowrap}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;z-index:50}
  .modal2{position:fixed;inset:0;background:var(--bg);z-index:60;overflow:auto}
  .modal2 .inner{max-width:480px;margin:0 auto;padding:max(16px,env(safe-area-inset-top)) 16px calc(32px + env(safe-area-inset-bottom))}
  .topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
  .gearbtn{flex:0 0 auto;border:0;background:var(--card);width:42px;height:42px;border-radius:50%;font-size:20px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.06);margin-top:10px}
  .gearbtn:active{opacity:.6}
  .sheet{background:var(--bg);width:100%;max-width:480px;margin:0 auto;border-radius:20px 20px 0 0;padding:16px 16px calc(20px + env(safe-area-inset-bottom));max-height:86vh;overflow:auto}
  .sheet-h{display:flex;justify-content:space-between;align-items:center;font-size:18px;margin-bottom:14px}
  .x{border:0;background:var(--field);color:var(--label);width:30px;height:30px;border-radius:50%;font-size:14px;cursor:pointer}
  .seg{display:flex;gap:6px;margin-bottom:14px}
  .seg button{flex:1;border:0;background:var(--field);color:var(--sec);padding:9px;border-radius:9px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  .seg button.on{background:var(--blue);color:#fff}
  #chartBox svg{width:100%;height:auto;display:block}
  .dayrow{display:flex;align-items:center;gap:5px;padding:7px 0;border-top:1px solid var(--sep)}
  .dayrow:first-child{border-top:0}
  .dname{width:16px;font-weight:600;font-size:15px;flex:0 0 auto}
  .dayrow input[type=time]{flex:1 1 0;min-width:0;background:var(--field);border:0;border-radius:8px;padding:7px 4px;color:var(--label);font-family:inherit;font-size:13px}
  .dayrow .tilde{color:var(--sec);flex:0 0 auto}
  .offbox{flex:0 0 auto;font-size:12px;color:var(--sec);display:flex;align-items:center;gap:3px;white-space:nowrap}
  .dayrow.off input[type=time]{opacity:.35}
  .wxrow{display:flex;justify-content:space-between;align-items:center;padding:13px 2px;border-top:1px solid var(--sep);font-size:15px}
  .wxrow span{color:var(--sec)}
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}
  .tile{background:var(--card);border-radius:16px;padding:12px 6px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04)}
  .tile .v{font-size:19px;font-weight:600;letter-spacing:-.01em} .tile .k{font-size:11px;color:var(--sec);margin-top:3px}
  .switch{display:flex;align-items:center;justify-content:space-between;background:var(--card);
    border-radius:16px;padding:16px 18px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
  .switch .t{font-size:17px;font-weight:600} .switch .d{font-size:13px;color:var(--sec);margin-top:2px}
  .tg{position:relative;width:52px;height:32px;flex:0 0 auto}
  .tg input{opacity:0;width:0;height:0;position:absolute}
  .tg .sl{position:absolute;inset:0;background:#e9e9ea;border-radius:999px;transition:.25s}
  @media (prefers-color-scheme:dark){.tg .sl{background:#39393d}}
  .tg .sl:before{content:"";position:absolute;width:28px;height:28px;left:2px;top:2px;background:#fff;border-radius:50%;
    transition:.25s;box-shadow:0 2px 4px rgba(0,0,0,.25)}
  .tg input:checked+.sl{background:var(--green)} .tg input:checked+.sl:before{transform:translateX(20px)}
  .btn{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:17px;font-weight:600;
    background:var(--field);color:var(--blue);cursor:pointer;margin-bottom:10px;font-family:inherit}
  .btn:active{opacity:.6}
  .sec-h{font-size:13px;color:var(--sec);text-transform:none;margin:22px 4px 8px;font-weight:400}
  details{background:var(--card);border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.04)}
  summary{list-style:none;padding:16px 18px;font-size:17px;font-weight:500;cursor:pointer;display:flex;justify-content:space-between;align-items:center}
  summary::-webkit-details-marker{display:none}
  summary::after{content:"›";color:var(--sec);font-size:22px;transition:.2s}
  details[open] summary::after{transform:rotate(90deg)}
  .grp{padding:0 18px 10px}
  .fld{padding:12px 0;border-top:1px solid var(--sep)}
  .fld label{display:block;font-size:13px;color:var(--sec);margin-bottom:6px}
  .fld input{width:100%;border:0;background:var(--field);border-radius:10px;padding:11px 12px;font-size:16px;color:var(--label);font-family:inherit}
  .sel{width:100%;border:0;background:var(--field);border-radius:10px;padding:11px 12px;font-size:16px;color:var(--label);font-family:inherit;-webkit-appearance:none;appearance:none}
  .row2{display:flex;gap:10px}.row2>div{flex:1}
  .save{color:#fff;background:var(--blue);margin-top:12px}
  .mini{font-size:12px;color:var(--sec);margin-top:6px;padding:0 2px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:1px}
  pre{white-space:pre-wrap;word-break:break-all;font-size:11px;color:var(--sec);background:var(--field);border-radius:12px;padding:12px;margin:8px 0 0}
</style></head><body>
<div class="topbar">
  <div><h1 id="title" style="margin:8px 0 2px">우리 매장</h1><div style="color:var(--sec);font-size:14px">실내 환경 자동관리 <span id="sched" class="schedpill"></span></div></div>
  <button id="gear" class="gearbtn" aria-label="설정">⚙️</button>
</div>
<div style="height:16px"></div>

<div class="hero">
  <div style="color:var(--sec);font-size:13px;font-weight:500;margin-bottom:2px">실내 온도 <span style="opacity:.6">· 탭하면 그래프 📈</span></div>
  <div class="temp" id="temp" style="cursor:pointer">–<span>℃</span></div>
  <div class="humid" id="humid">습도 –</div>
  <div class="chip gray" id="chip"><span class="em">⏳</span><span id="chipt">불러오는 중…</span></div>
  <div class="chipsub" id="chipsub"></div>
</div>

<div class="tiles">
  <div class="tile"><div class="v" id="t_season">–</div><div class="k">계절</div></div>
  <div class="tile"><div class="v" id="t_target">–</div><div class="k">목표</div></div>
  <div class="tile" id="outTile" style="cursor:pointer"><div class="v" id="t_out">–</div><div class="k">바깥 ›</div></div>
  <div class="tile"><div class="v" id="t_ac">–</div><div class="k">에어컨</div></div>
</div>

<div class="switch">
  <div><div class="t">자동 제어</div><div class="d" id="swd">끄면 손으로만 관리</div></div>
  <label class="tg"><input type="checkbox" id="auto"><span class="sl"></span></label>
</div>
<button class="btn" id="run">지금 한 번 실행</button>
<div class="mini" style="text-align:center;margin:-4px 2px 2px">자동을 기다리지 않고, 지금 상태를 바로 확인해 필요하면 에어컨을 한 번 맞춰요</div>

<div id="settingsModal" class="modal2" style="display:none"><div class="inner">
  <div class="sheet-h" style="margin-bottom:14px"><b>⚙️ 설정</b><button id="setClose" class="x">✕</button></div>
<details id="dLogin"><summary><span><span class="dot" id="cDot" style="background:var(--sec)"></span>헤이홈 로그인</span></summary>
  <div class="grp">
    <div class="fld"><label>이메일</label><input id="email" type="email" autocomplete="username"></div>
    <div class="fld"><label>비밀번호</label><input id="password" type="password" autocomplete="current-password"></div>
    <button class="btn save" id="login">로그인 저장</button>
    <div class="mini">비번은 사장님 Cloudflare에만 저장되고 화면에 다시 안 보여요.</div>
  </div></details>

<div style="height:10px"></div>
<details id="dCfg"><summary>자동제어 설정</summary>
  <div class="grp">
    <div class="fld"><label>매장 이름</label><input id="storeName" placeholder="예: 동작동 카페"></div>
    <div class="fld"><div class="row2">
      <div><label>여름 목표℃</label><input id="summerTarget" type="number" inputmode="decimal"></div>
      <div><label>겨울 목표℃</label><input id="winterTarget" type="number" inputmode="decimal"></div>
      <div><label>여유℃</label><input id="deadband" type="number" inputmode="decimal" step="0.5"></div>
    </div></div>
    <div class="fld"><div class="row2">
      <div><label>여름 경고 ℃이상</label><input id="alertHot" type="number" inputmode="decimal"></div>
      <div><label>최저기준 ℃이하</label><input id="alertCold" type="number" inputmode="decimal"></div>
    </div><div class="mini">실내가 이 온도를 넘으면 상단에 경고가 떠요.</div></div>
    <div class="fld"><label>매장 위치 (주소)</label><input id="address" placeholder="예: 서울 동작구 동작대로3길 44">
      <button class="btn" id="geocode" style="margin:8px 0 0">이 주소로 위치 설정</button>
      <div class="mini" id="loc"></div></div>
    <div class="fld"><label>날씨 API 키 <span id="owm" style="color:var(--sec)"></span></label><input id="owmKey" type="password" placeholder="입력할 때만 변경 (비우면 유지)"></div>
    <button class="btn save" id="save">설정 저장</button>
  </div></details>

<div style="height:10px"></div>
<details id="dSched"><summary>영업시간 · 절전</summary>
  <div class="grp">
    <div class="fld" style="display:flex;align-items:center;justify-content:space-between">
      <div><div style="font-size:16px">영업시간 자동 적용</div><div class="mini">비영업엔 최저기준까지만 유지해 절전</div></div>
      <label class="tg"><input type="checkbox" id="useSchedule"><span class="sl"></span></label>
    </div>
    <div class="fld"><label>영업 시작 몇 분 전부터 미리 데울지</label><input id="preheatMinutes" type="number" inputmode="numeric"></div>
    <div class="fld"><label>요일별 영업시간</label><div id="daysBox"></div>
      <div class="mini" style="margin-top:6px">휴무 체크 시 그 날은 종일 절전. 자정 넘겨 영업하면 종료를 새벽 시간(예: 02:00)으로 넣으세요.</div></div>
    <button class="btn save" id="saveSched">영업시간 설정 저장</button>
  </div></details>

<div style="height:10px"></div>
<details id="dAdv"><summary>기기 선택</summary>
  <div class="grp">
    <div class="fld"><label>온습도계</label><select id="sensorSel" class="sel"></select></div>
    <div class="fld"><label>에어컨</label><select id="acSel" class="sel"></select></div>
    <div style="display:flex;gap:8px"><button class="btn" id="refreshDev" style="flex:1">다시 불러오기</button><button class="btn save" id="saveDev" style="flex:1">기기 저장</button></div>
    <div class="mini" id="devNote">헤이홈 앱에 등록된 기기가 자동으로 여기 나와요. 이름으로 고르기만 하면 돼요.</div>
  </div></details>
</div></div>

<div id="wxModal" class="modal" style="display:none">
  <div class="sheet">
    <div class="sheet-h"><b>🌤️ 바깥 날씨</b><button id="wxClose" class="x">✕</button></div>
    <div id="wxBody"></div>
  </div>
</div>

<div id="chartModal" class="modal" style="display:none">
  <div class="sheet">
    <div class="sheet-h"><b>📈 온도 변화</b><button id="chartClose" class="x">✕</button></div>
    <div class="seg"><button data-h="24" class="on">24시간</button><button data-h="72">3일</button><button data-h="168">7일</button></div>
    <div id="chartBox"></div>
    <div class="mini" id="chartNote" style="margin-top:10px"></div>
  </div>
</div>

<script>
// 핀치 확대/더블탭 확대 막기 (iOS)
document.addEventListener('gesturestart',e=>e.preventDefault());
document.addEventListener('gesturechange',e=>e.preventDefault());
let _lt=0;document.addEventListener('touchend',e=>{const n=Date.now();if(n-_lt<300)e.preventDefault();_lt=n;},{passive:false});
const T=new URLSearchParams(location.search).get('t');const q=p=>p+(T?('?t='+T):'');
let histRange=24;let lastPv=null;let curSensor='',curAc='';
function svgChart(d,col){
  const W=440,H=240,pl=32,pr=30,pt=22,pb=26;
  const temps=d.map(p=>p.temp);const outs=d.filter(p=>p.out!=null).map(p=>p.out);const hums=d.filter(p=>p.hum!=null).map(p=>p.hum);
  let lo=Math.min.apply(null,temps.concat(outs));let hi=Math.max.apply(null,temps.concat(outs));
  lo=Math.floor(lo-1);hi=Math.ceil(hi+1);if(hi-lo<4)hi=lo+4;
  let hlo=hums.length?Math.min.apply(null,hums):0,hhi=hums.length?Math.max.apply(null,hums):100;
  hlo=Math.floor(hlo-2);hhi=Math.ceil(hhi+2);if(hlo<0)hlo=0;if(hhi-hlo<8)hhi=hlo+8;
  const t0=d[0].t,t1=d[d.length-1].t;
  const X=t=>pl+(t1===t0?0:(t-t0)/(t1-t0))*(W-pl-pr);
  const Y=v=>pt+(1-(v-lo)/(hi-lo))*(H-pt-pb);
  const YH=v=>pt+(1-(v-hlo)/(hhi-hlo))*(H-pt-pb);
  const line=(arr,key,yf)=>arr.filter(p=>p[key]!=null).map((p,i)=>(i?'L':'M')+X(p.t).toFixed(1)+' '+yf(p[key]).toFixed(1)).join(' ');
  let grid='';for(let i=0;i<=4;i++){const y=Y(lo+(hi-lo)*i/4);const tv=lo+(hi-lo)*i/4,hv=hlo+(hhi-hlo)*i/4;grid+='<line x1="'+pl+'" y1="'+y.toFixed(1)+'" x2="'+(W-pr)+'" y2="'+y.toFixed(1)+'" stroke="'+col.sep+'"/><text x="'+(pl-5)+'" y="'+(y+4).toFixed(1)+'" font-size="11" fill="'+col.blue+'" text-anchor="end">'+tv.toFixed(0)+'</text>'+(hums.length?'<text x="'+(W-pr+5)+'" y="'+(y+4).toFixed(1)+'" font-size="11" fill="'+col.green+'" text-anchor="start">'+hv.toFixed(0)+'</text>':'');}
  const fmt=t=>{const dt=new Date(t);return (dt.getMonth()+1)+'/'+dt.getDate()+' '+String(dt.getHours()).padStart(2,'0')+'시'};
  let xl='';[0,Math.floor(d.length/2),d.length-1].forEach((idx,i)=>{const p=d[idx];xl+='<text x="'+X(p.t).toFixed(1)+'" y="'+(H-8)+'" font-size="10" fill="'+col.sec+'" text-anchor="'+(i===0?'start':i===2?'end':'middle')+'">'+fmt(p.t)+'</text>';});
  const outPath=outs.length?'<path d="'+line(d,'out',Y)+'" fill="none" stroke="'+col.sec+'" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.55"/>':'';
  const humPath=hums.length?'<path d="'+line(d,'hum',YH)+'" fill="none" stroke="'+col.green+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>':'';
  const legend='<text x="'+pl+'" y="12" font-size="10"><tspan fill="'+col.blue+'">■ 실내℃</tspan>  <tspan fill="'+col.sec+'">┈ 바깥℃</tspan>  <tspan fill="'+col.green+'">■ 습도%</tspan></text>';
  return '<svg viewBox="0 0 '+W+' '+H+'">'+grid+outPath+humPath+'<path d="'+line(d,'temp',Y)+'" fill="none" stroke="'+col.blue+'" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>'+xl+legend+'</svg>';
}
async function drawChart(){
  const box=document.getElementById('chartBox');box.textContent='불러오는 중…';
  const all=await(await fetch(q('/api/history'))).json();
  const cut=Date.now()-histRange*3600*1000;const d=(all||[]).filter(p=>p.t>=cut);
  if(d.length<2){box.innerHTML='';document.getElementById('chartNote').textContent='아직 기록이 부족해요. 10분마다 쌓여서 곧 보여요.';return}
  const cs=getComputedStyle(document.documentElement);
  const col={blue:cs.getPropertyValue('--blue').trim()||'#0a84ff',green:cs.getPropertyValue('--green').trim()||'#34c759',sec:cs.getPropertyValue('--sec').trim()||'#8e8e93',sep:cs.getPropertyValue('--sep').trim()||'#555'};
  box.innerHTML=svgChart(d,col);
  const last=d[d.length-1];document.getElementById('chartNote').textContent='최근 '+histRange+'시간 · '+d.length+'개 기록 · 지금 '+last.temp.toFixed(1)+'℃'+(last.hum!=null?' · 습도 '+last.hum+'%':'');
}
function openChart(){document.getElementById('chartModal').style.display='flex';drawChart()}
document.getElementById('temp').onclick=openChart;
document.getElementById('gear').onclick=()=>{document.getElementById('settingsModal').style.display='block';document.getElementById('settingsModal').scrollTop=0};
document.getElementById('setClose').onclick=()=>{document.getElementById('settingsModal').style.display='none'};
function openWeather(){const w=lastPv&&lastPv.weather;const b=document.getElementById('wxBody');
  if(!w){b.innerHTML='<div class="mini" style="padding:12px 2px">날씨 정보가 아직 없어요. (키 활성화에 1~2시간, 또는 날씨 키 미설정)</div>';}
  else{const rows=[['체감온도',w.feelsLike!=null?Math.round(w.feelsLike)+'℃':'–'],['오늘 최저 / 최고',(w.tempMin!=null?Math.round(w.tempMin):'–')+' / '+(w.tempMax!=null?Math.round(w.tempMax)+'℃':'–')],['바깥 습도',w.humidity!=null?w.humidity+'%':'–'],['바람',w.windSpeed!=null?w.windSpeed.toFixed(1)+' m/s':'–']];
    b.innerHTML='<div style="text-align:center;padding:6px 0 14px"><div style="font-size:54px;line-height:1">'+w.emoji+'</div><div style="font-size:32px;font-weight:600;margin-top:6px">'+Math.round(w.outdoorTemp)+'℃</div><div style="color:var(--sec);margin-top:2px">'+(w.description||'')+'</div></div>'+rows.map(r=>'<div class="wxrow"><span>'+r[0]+'</span><b>'+r[1]+'</b></div>').join('');}
  document.getElementById('wxModal').style.display='flex';}
document.getElementById('outTile').onclick=openWeather;
document.getElementById('wxClose').onclick=()=>document.getElementById('wxModal').style.display='none';
document.getElementById('wxModal').onclick=e=>{if(e.target.id==='wxModal')e.target.style.display='none'};
document.getElementById('chartClose').onclick=()=>document.getElementById('chartModal').style.display='none';
document.getElementById('chartModal').onclick=e=>{if(e.target.id==='chartModal')e.target.style.display='none'};
document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.seg button').forEach(x=>x.className='');b.className='on';histRange=+b.dataset.h;drawChart()});
function friendly(p,enabled){
  if(!p||p.error)return{em:'⚠️',t:'문제가 있어요',sub:(p&&p.error)||'',c:'red',ac:'—'};
  // 경고: 기준 온도 넘으면 문구 자체를 경고로
  if(p.alert&&p.alert.type==='hot')return{em:'🥵',t:'너무 더워요! '+p.alert.temp.toFixed(1)+'℃',sub:(enabled?'시원하게 트는 중':'자동을 켜면 시원하게 맞춰줘요'),c:'red',ac:enabled?'냉방':'수동'};
  if(p.alert&&p.alert.type==='cold')return{em:'🥶',t:'너무 추워요! '+p.alert.temp.toFixed(1)+'℃',sub:'최저기준 '+p.alert.threshold+'℃ 아래 · '+(enabled?'따뜻하게 트는 중':'자동 켜면 따뜻하게'),c:'blue',ac:enabled?'난방':'수동'};
  const heating=p.action==='set'&&p.seasonMode==='heating';
  const cooling=p.action==='set'&&p.seasonMode==='cooling';
  if(!enabled){ // 자동 꺼짐: 지금 상황 "제안"만 표시 (에어컨엔 아무것도 안 보냄)
    if(heating)return{em:'🔥',t:'난방이 필요해요',sub:'자동을 켜면 따뜻하게 맞춰줘요',c:'orange',ac:'수동'};
    if(cooling)return{em:'❄️',t:'냉방이 필요해요',sub:'자동을 켜면 시원하게 맞춰줘요',c:'blue',ac:'수동'};
    return{em:'😌',t:'지금 알맞아요',sub:'냉난방 필요 없는 상태',c:'green',ac:'수동'};
  }
  if(cooling)return{em:'❄️',t:'시원하게 트는 중',sub:p.reason,c:'blue',ac:'냉방'};
  if(heating)return{em:'🔥',t:'따뜻하게 트는 중',sub:p.reason,c:'orange',ac:'난방'};
  if(p.action==='off')return{em:'⏹️',t:'에어컨 끄는 중',sub:p.reason,c:'gray',ac:'끄기'};
  return{em:'😌',t:'지금 알맞아요',sub:'에어컨 대기 중',c:'green',ac:'대기'};
}
async function load(){
  const [s,pv]=await Promise.all([fetch(q('/api/status')).then(r=>r.json()),fetch(q('/api/preview')).then(r=>r.json()).catch(()=>null)]);
  lastPv=pv;
  const c=s.config;
  // 설정값 채우기
  document.getElementById('title').textContent=c.storeName||'우리 매장';
  document.getElementById('storeName').value=c.storeName||'';
  for(const k of ['summerTarget','winterTarget','deadband','alertHot','alertCold'])document.getElementById(k).value=c[k];
  curSensor=c.sensorDeviceId||'';curAc=c.acDeviceId||'';
  document.getElementById('address').value=c.address||'';
  document.getElementById('loc').textContent=c.address?('현재 위치: '+c.address):('좌표 '+(c.lat||'-')+', '+(c.lon||'-'));
  document.getElementById('auto').checked=!!c.enabled;
  document.getElementById('swd').textContent=c.enabled?'10분마다 자동으로 맞춰요':'끄면 손으로만 관리';
  // 로그인 상태
  document.getElementById('cDot').style.background=s.hasCreds?'var(--green)':'var(--orange)';
  if(!s.hasCreds)document.getElementById('dLogin').open=true;
  document.getElementById('owm').textContent=s.hasOwmKey?'(연결됨)':'(미설정)';
  document.getElementById('owm').style.color=s.hasOwmKey?'var(--green)':'var(--sec)';
  // 히어로/타일
  const f=friendly(pv,c.enabled);
  if(pv&&typeof pv.indoorTemp==='number'){
    document.getElementById('temp').innerHTML=pv.indoorTemp.toFixed(1)+'<span>℃</span>';
    document.getElementById('humid').textContent='습도 '+(pv.indoorHumidity!=null?pv.indoorHumidity+'%':'–');
    document.getElementById('t_season').textContent=pv.seasonMode==='cooling'?'냉방철':pv.seasonMode==='heating'?'난방철':'간절기';
    document.getElementById('t_out').textContent=pv.outdoorTemp!=null?((pv.weather&&pv.weather.emoji?pv.weather.emoji+' ':'')+Math.round(pv.outdoorTemp)+'℃'):'–';
    document.getElementById('t_target').textContent=pv.targetTemp!=null?pv.targetTemp+'℃':'–';
  }
  const chip=document.getElementById('chip');chip.className='chip '+f.c;
  chip.querySelector('.em').textContent=f.em;document.getElementById('chipt').textContent=f.t;
  const SM={open:'🟢 영업중',preheat:'🟡 예열중',closed:'⚪ 비영업'};
  document.getElementById('sched').textContent=pv&&pv.scheduleState?SM[pv.scheduleState]||'':'';
  document.getElementById('useSchedule').checked=c.useSchedule!==false;
  document.getElementById('preheatMinutes').value=c.preheatMinutes!=null?c.preheatMinutes:60;
  const DAYS=[['월',1],['화',2],['수',3],['목',4],['금',5],['토',6],['일',0]];
  document.getElementById('daysBox').innerHTML=DAYS.map(function(e){var nm=e[0],ix=e[1];var h=(c.hours&&c.hours[ix])||{closed:false,open:'09:00',close:'00:00'};return '<div class="dayrow'+(h.closed?' off':'')+'" data-d="'+ix+'"><span class="dname">'+nm+'</span><label class="offbox"><input type="checkbox" class="dClosed"'+(h.closed?' checked':'')+'>휴무</label><input type="time" class="dOpen" value="'+(h.open||'09:00')+'"><span class="tilde">~</span><input type="time" class="dClose" value="'+(h.close||'00:00')+'"></div>';}).join('');
  document.querySelectorAll('#daysBox .dClosed').forEach(function(cb){cb.onchange=function(){cb.closest('.dayrow').classList.toggle('off',cb.checked)};});
  let sub=f.sub||'';
  if(pv&&!pv.alert){if(pv.scheduleState==='closed')sub='비영업 · 최저 '+c.alertCold+'℃만 유지 (절전)';else if(pv.scheduleState==='preheat')sub='영업 준비 — 미리 데우는 중';}
  document.getElementById('chipsub').textContent=sub;
  document.getElementById('t_ac').textContent=f.ac;
  const warn=!!(pv&&pv.alert);
  const tc=getComputedStyle(document.documentElement).getPropertyValue(f.c==='blue'?'--blue':f.c==='orange'?'--orange':f.c==='red'?'--red':'--label');
  document.getElementById('temp').style.color=((c.enabled||warn)&&['blue','orange','red'].includes(f.c))?tc:'';
}
document.getElementById('auto').onchange=async()=>{await fetch(q('/api/toggle'),{method:'POST'});load()};
document.getElementById('run').onclick=async(e)=>{e.target.textContent='실행 중…';await fetch(q('/api/run'),{method:'POST'});e.target.textContent='지금 한 번 실행';load()};
document.getElementById('login').onclick=async()=>{const email=document.getElementById('email').value,password=document.getElementById('password').value;if(!email||!password){alert('이메일/비번을 입력하세요');return}const r=await fetch(q('/api/login'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});const j=await r.json();if(j.ok){document.getElementById('password').value='';document.getElementById('dLogin').open=false;alert('로그인 성공!')}else alert('로그인 실패: '+(j.error||''));load()};
document.getElementById('save').onclick=async()=>{const b={};for(const k of ['summerTarget','winterTarget','deadband','alertHot','alertCold']){b[k]=Number(document.getElementById(k).value)}b.storeName=document.getElementById('storeName').value||'우리 매장';const ow=document.getElementById('owmKey').value;if(ow)b.owmKey=ow;await fetch(q('/api/config'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});document.getElementById('owmKey').value='';alert('저장됨');load()};
document.getElementById('geocode').onclick=async()=>{const a=document.getElementById('address').value.trim();if(!a){alert('주소를 입력하세요');return}const loc=document.getElementById('loc');loc.textContent='위치 찾는 중…';const url='/api/geocode?q='+encodeURIComponent(a)+(T?'&t='+T:'');const j=await(await fetch(url)).json();if(j.ok){await fetch(q('/api/config'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:a,lat:j.lat,lon:j.lon})});loc.textContent='✓ 설정됨: '+j.name;load()}else{loc.textContent='✗ '+(j.error||'주소를 못 찾음')}};
document.getElementById('saveSched').onclick=async()=>{const hours=[];document.querySelectorAll('#daysBox .dayrow').forEach(function(row){var d=+row.dataset.d;hours[d]={closed:row.querySelector('.dClosed').checked,open:row.querySelector('.dOpen').value||'09:00',close:row.querySelector('.dClose').value||'00:00'};});const b={useSchedule:document.getElementById('useSchedule').checked,preheatMinutes:Number(document.getElementById('preheatMinutes').value)||60,hours:hours};await fetch(q('/api/config'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});alert('영업시간 저장됨');load()};
function typeLabel(t){const m={SensorTh:'온습도계',SensorTh2:'온습도계',IrAirconditioner:'에어컨(IR)',IrFan:'선풍기(IR)',IrTv:'TV(IR)',Plug:'플러그',SmartPlug:'플러그',Curtain:'커튼',Lightbulb:'전구',IrDIY:'IR리모컨'};return t?(' · '+(m[t]||t)):'';}
async function loadDevices(){
  const n=document.getElementById('devNote');n.textContent='불러오는 중…';
  let devs;try{devs=await (await fetch(q('/api/devices'))).json();}catch(e){n.textContent='불러오기 실패';return}
  if(!Array.isArray(devs)){n.textContent='오류: '+((devs&&devs.error)||'기기 목록을 못 읽음');return}
  const opt=d=>'<option value="'+d.id+'">'+(d.name||'(이름없음)')+typeLabel(d.deviceType)+'</option>';
  const s1=document.getElementById('sensorSel'),s2=document.getElementById('acSel');
  s1.innerHTML=devs.map(opt).join('');s2.innerHTML=devs.map(opt).join('');
  if(curSensor)s1.value=curSensor;if(curAc)s2.value=curAc;
  n.textContent='총 '+devs.length+'개 · 이름으로 고르고 [기기 저장]';
}
document.getElementById('refreshDev').onclick=loadDevices;
document.getElementById('dAdv').addEventListener('toggle',function(){if(this.open&&!document.getElementById('sensorSel').options.length)loadDevices();});
document.getElementById('saveDev').onclick=async()=>{const b={sensorDeviceId:document.getElementById('sensorSel').value,acDeviceId:document.getElementById('acSel').value};if(!b.sensorDeviceId||!b.acDeviceId){alert('먼저 기기를 불러와 선택하세요');return}await fetch(q('/api/config'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});alert('기기 저장됨');load()};
load();
</script></body></html>`;
}

// Cloudflare Worker 엔트리
//  - scheduled(cron): 주기적으로 센서 읽고 에어컨 자동 제어
//  - fetch(http):     상태 확인 + on/off + 설정 UI/API
import { Config, DEFAULT_CONFIG, Env, DesiredAcState, MODE_CODES, FAN_CODES } from './config';
import * as hej from './hej';
import { getWeather } from './weather';
import { decide, Reading } from './engine';

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
  error?: string;
}

// ---------- 자동화 1회 실행 ----------
async function runOnce(env: Env, opts: { force?: boolean } = {}): Promise<RunStatus> {
  const status: RunStatus = { ts: new Date().toISOString(), ok: false, enabled: false };
  try {
    const cfg = await loadConfig(env);
    status.enabled = cfg.enabled;
    if (!cfg.enabled && !opts.force) { status.ok = true; status.reason = '자동화 OFF 상태'; await env.KV.put('status', JSON.stringify(status)); return status; }
    if (!cfg.sensorDeviceId || !cfg.acDeviceId) { status.reason = '센서/에어컨 기기 ID 미설정 (설정에서 지정하세요)'; await env.KV.put('status', JSON.stringify(status)); return status; }

    const s = await getSession(env);
    const families = await hej.getFamilies(s);
    if (!families.length) throw new Error('집(family) 목록이 비어 있음');
    const devices = await hej.getDevices(s, families[0].familyId);

    const sensor = devices.find((d) => d.id === cfg.sensorDeviceId);
    if (!sensor) throw new Error('온습도계 기기를 찾지 못함');
    const { temp, humidity } = readSensor(sensor.deviceState ?? {});
    if (temp === null) throw new Error('센서에서 온도를 읽지 못함 (deviceState 키 확인 필요)');
    status.indoorTemp = temp; status.indoorHumidity = humidity;

    const weather = await getWeather(cfg.lat, cfg.lon, env.OWM_API_KEY);
    status.outdoorTemp = weather?.outdoorTemp ?? null;

    const reading: Reading = { indoorTemp: temp, indoorHumidity: humidity ?? undefined, outdoorTemp: weather?.outdoorTemp ?? null };
    const decision = decide(reading, cfg);
    status.seasonMode = decision.seasonMode;
    status.action = decision.action;
    status.reason = decision.reason;

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
    await env.KV.put('status', JSON.stringify(status));
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
    ctx.waitUntil(runOnce(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const json = (o: unknown, code = 200) => new Response(JSON.stringify(o, null, 2), { status: code, headers: { 'content-type': 'application/json; charset=utf-8' } });

    if (!authed(req, env)) return json({ error: '인증 필요 (?t=관리자토큰)' }, 401);

    // 상태
    if (url.pathname === '/api/status') {
      const [cfg, st, creds] = await Promise.all([loadConfig(env), env.KV.get('status', 'json'), hasCreds(env)]);
      return json({ config: { ...cfg }, lastRun: st, hasCreds: creds });
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
      return json(await runOnce(env, { force: true }));
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
      const cfg = { ...(await loadConfig(env)), ...body };
      await saveConfig(env, cfg);
      return json(cfg);
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

// ---------- 최소 웹 UI ----------
function renderUI(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>헤이홈 에어컨 자동제어</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:0 auto;padding:16px;background:#0f1419;color:#e6e6e6}
  h1{font-size:1.2rem} .card{background:#1a2029;border:1px solid #2a323d;border-radius:12px;padding:16px;margin:12px 0}
  button{font-size:1rem;padding:10px 16px;border-radius:10px;border:0;cursor:pointer}
  .on{background:#2ea043;color:#fff}.off{background:#555;color:#fff}.run{background:#1f6feb;color:#fff}
  label{display:block;margin:8px 0 2px;font-size:.85rem;color:#9aa4b2}
  input{width:100%;padding:8px;border-radius:8px;border:1px solid #2a323d;background:#0f1419;color:#e6e6e6;box-sizing:border-box}
  pre{white-space:pre-wrap;word-break:break-all;font-size:.8rem;color:#9aa4b2}
  .row{display:flex;gap:8px} .row>div{flex:1}
</style></head><body>
<h1>🌡️ 헤이홈 에어컨 자동제어</h1>
<div class="card"><b>1) 헤이홈 로그인</b> <span id="conn"></span>
  <label>헤이홈 이메일</label><input id="email" type="email" autocomplete="username">
  <label>헤이홈 비밀번호</label><input id="password" type="password" autocomplete="current-password">
  <div style="margin-top:10px"><button id="login" class="run">로그인 저장</button></div>
  <div style="font-size:.75rem;color:#9aa4b2;margin-top:6px">비번은 사장님 Cloudflare에만 저장되고 화면에 다시 안 보입니다.</div></div>
<div class="card"><div id="state">불러오는 중…</div>
  <div style="margin-top:12px"><button id="toggle" class="on">on/off</button>
  <button id="run" class="run">지금 실행</button></div></div>
<div class="card"><b>설정</b>
  <div class="row"><div><label>여름 목표℃</label><input id="summerTarget" type="number"></div>
  <div><label>겨울 목표℃</label><input id="winterTarget" type="number"></div>
  <div><label>이력폭℃</label><input id="deadband" type="number" step="0.5"></div></div>
  <label>온습도계 기기ID</label><input id="sensorDeviceId">
  <label>에어컨 기기ID</label><input id="acDeviceId">
  <div class="row"><div><label>위도</label><input id="lat" type="number" step="0.0001"></div>
  <div><label>경도</label><input id="lon" type="number" step="0.0001"></div></div>
  <div style="margin-top:10px"><button id="save" class="run">설정 저장</button>
  <button id="list" class="off">기기 목록 보기</button></div></div>
<div class="card"><b>마지막 실행</b><pre id="last"></pre></div>
<script>
const T=new URLSearchParams(location.search).get('t');const q=p=>p+(T?('?t='+T):'');
async function load(){const r=await fetch(q('/api/status'));const d=await r.json();const c=d.config;
  for(const k of ['summerTarget','winterTarget','deadband','sensorDeviceId','acDeviceId','lat','lon'])document.getElementById(k).value=c[k];
  document.getElementById('toggle').className=c.enabled?'on':'off';
  document.getElementById('toggle').textContent=c.enabled?'자동 ON (끄기)':'자동 OFF (켜기)';
  document.getElementById('state').innerHTML='자동화: <b>'+(c.enabled?'켜짐':'꺼짐')+'</b>';
  document.getElementById('conn').innerHTML=d.hasCreds?'<span style="color:#2ea043">● 로그인됨</span>':'<span style="color:#d29922">● 로그인 필요</span>';
  document.getElementById('last').textContent=JSON.stringify(d.lastRun,null,2);}
document.getElementById('login').onclick=async()=>{const email=document.getElementById('email').value,password=document.getElementById('password').value;if(!email||!password){alert('이메일/비번을 입력하세요');return}document.getElementById('conn').textContent='확인 중…';const r=await fetch(q('/api/login'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});const j=await r.json();if(j.ok){alert('로그인 성공! 이제 아래 [기기 목록 보기]로 기기ID를 넣으세요.');document.getElementById('password').value=''}else{alert('로그인 실패: '+(j.error||''))}load()};
document.getElementById('toggle').onclick=async()=>{await fetch(q('/api/toggle'),{method:'POST'});load()};
document.getElementById('run').onclick=async()=>{document.getElementById('last').textContent='실행 중…';await fetch(q('/api/run'),{method:'POST'});load()};
document.getElementById('save').onclick=async()=>{const b={};for(const k of ['summerTarget','winterTarget','deadband','sensorDeviceId','acDeviceId','lat','lon']){const v=document.getElementById(k).value;b[k]=['sensorDeviceId','acDeviceId'].includes(k)?v:Number(v)}await fetch(q('/api/config'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});alert('저장됨');load()};
document.getElementById('list').onclick=async()=>{document.getElementById('last').textContent='불러오는 중…';const r=await fetch(q('/api/devices'));document.getElementById('last').textContent=JSON.stringify(await r.json(),null,2)};
load();
</script></body></html>`;
}

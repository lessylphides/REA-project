// 헤이홈(square.hej.so) 클라우드 API 클라이언트
// 계약 출처: 오픈소스 chazepps/homebridge-hejhome (src/hej/auth.ts, rest.ts) 에서 확인.
//  - 로그인: 이메일+비번 Basic → JSESSIONID → /oauth/authorize(code) → /oauth/token(Bearer)
//  - 기기목록: GET dashboard/{familyId}[/room/{roomId}]/devices-state?scope=shop
//  - 제어:   POST dashboard/control/{deviceId}  body {"requirments": {...}}
//
// ※ 참고: 여기 client_id/secret 은 헤이홈 "웹 대시보드"의 공개 클라이언트 값(웹앱에 내장되어 사실상 공개).
//   개인 매장용 도구엔 충분하지만, 정식 운영 시 goqual 공식 OpenAPI(goqual.io) 자격증명으로 교체 권장.

const SQUARE_ORIGIN = 'https://square.hej.so';
const TWO_FACTOR_ORIGIN = 'https://2factor.goqual.com';
const HEJ_CLIENT_ID = '62f4020744ca4510827d3b4a4d2c7e7f';
const HEJ_CLIENT_SECRET = 'fcd4302cece447a9ab009296f649d2c0';

export interface HejSession {
  accessToken: string;
  jsessionId: string;
  usernameCookie: string;
  expiresAt: number;
}

export interface HejDevice {
  id: string;
  name?: string;
  deviceType?: string;
  deviceState?: Record<string, unknown>;
  [k: string]: unknown;
}

function basic(user: string, pass: string): string {
  return 'Basic ' + btoa(`${user}:${pass}`);
}

function parseJSessionId(headers: Headers): string | null {
  // Workers 런타임: getSetCookie() 지원(배열). 구버전/타입 미지원 대비 fallback.
  const list: string[] = typeof (headers as any).getSetCookie === 'function'
    ? (headers as any).getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
  for (const c of list) {
    const m = /JSESSIONID=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

/** 이메일+비번으로 로그인하여 세션(accessToken 등) 발급 */
export async function login(email: string, password: string): Promise<HejSession> {
  // 1) 로그인 → JSESSIONID
  const loginRes = await fetch(`${SQUARE_ORIGIN}/oauth/login?vendor=shop`, {
    method: 'POST',
    headers: {
      accept: 'text/plain, */*; q=0.01',
      'accept-language': 'ko-kr',
      authorization: basic(email, password),
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  if (!loginRes.ok) throw new Error(`헤이홈 로그인 실패 (${loginRes.status})`);
  const jsessionId = parseJSessionId(loginRes.headers);
  if (!jsessionId) throw new Error('로그인 세션 쿠키(JSESSIONID)를 받지 못했습니다');

  const usernameCookie = encodeURIComponent(email);
  const cookie = `username=${usernameCookie}; JSESSIONID=${jsessionId}; autoLogin=true`;

  // 2) authorize → code
  const authorizeUrl = `${SQUARE_ORIGIN}/oauth/authorize?` + new URLSearchParams({
    client_id: HEJ_CLIENT_ID,
    redirect_uri: `${SQUARE_ORIGIN}/list`,
    response_type: 'code',
    scope: 'shop',
  });
  const authRes = await fetch(authorizeUrl, { method: 'GET', redirect: 'manual', headers: { cookie } });
  const location = authRes.headers.get('location') ?? authRes.url;
  const code = location ? new URL(location, SQUARE_ORIGIN).searchParams.get('code') : null;
  if (!code) throw new Error('OAuth code를 받지 못했습니다');

  // 3) token
  const tokenRes = await fetch(`${SQUARE_ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/javascript, */*; q=0.01',
      authorization: basic(HEJ_CLIENT_ID, HEJ_CLIENT_SECRET),
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: HEJ_CLIENT_ID,
      redirect_uri: `${SQUARE_ORIGIN}/list`,
    }),
  });
  if (!tokenRes.ok) throw new Error(`토큰 교환 실패 (${tokenRes.status})`);
  const body = await tokenRes.json<{ access_token?: string; expires_in?: number }>();
  if (!body.access_token) throw new Error('access_token이 응답에 없습니다');

  return {
    accessToken: body.access_token,
    jsessionId,
    usernameCookie,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

function authHeaders(s: HejSession): Record<string, string> {
  return {
    accept: 'application/json, text/javascript, */*; q=0.01',
    authorization: `Bearer ${s.accessToken}`,
    'content-type': 'application/json;charset=UTF-8',
    cookie: `username=${s.usernameCookie}; autoLogin=true; JSESSIONID=${s.jsessionId}; accessToken=${s.accessToken}`,
    Referer: `${SQUARE_ORIGIN}/list`,
    'x-requested-with': 'XMLHttpRequest',
  };
}

async function get<T>(s: HejSession, path: string): Promise<T> {
  const res = await fetch(`${SQUARE_ORIGIN}/${path}`, { method: 'GET', headers: authHeaders(s) });
  if (!res.ok) throw new Error(`GET ${path} 실패 (${res.status})`);
  const text = await res.text();
  return JSON.parse(text || 'null') as T;
}

export interface HejFamily { familyId: number; [k: string]: unknown; }

export async function getFamilies(s: HejSession): Promise<HejFamily[]> {
  const r = await get<{ result: HejFamily[] }>(s, 'dashboard/family');
  return r.result ?? [];
}

/** 집(family)의 모든 기기 + 현재 상태 */
export async function getDevices(s: HejSession, familyId: number): Promise<HejDevice[]> {
  return get<HejDevice[]>(s, `dashboard/${familyId}/devices-state?scope=shop`);
}

/** 임의 경로 GET (진단용) */
export async function rawGet<T>(s: HejSession, path: string): Promise<T> {
  return get<T>(s, path);
}

/** 임의 경로 GET — 실패해도 status/본문을 돌려줌(진단용, DIY 기기 탐색) */
export async function rawProbe(s: HejSession, path: string): Promise<{ path: string; status: number; body: unknown }> {
  try {
    const res = await fetch(`${SQUARE_ORIGIN}/${path}`, { method: 'GET', headers: authHeaders(s) });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text || 'null'); } catch { body = text.slice(0, 500); }
    return { path, status: res.status, body };
  } catch (e: any) {
    return { path, status: -1, body: String(e?.message ?? e) };
  }
}

export interface HejScene { sceneId: string; name: string; }

/** 레시피(장면) 목록 — 헤이홈 앱에서 만든 레시피. DIY 버튼을 담아 실행하는 용도 */
export async function getScenes(s: HejSession, familyId: number): Promise<HejScene[]> {
  const r = await get<{ result?: HejScene[] }>(s, `dashboard/scene?family-id=${familyId}`);
  return (r?.result ?? []).filter((x) => x && typeof x.sceneId === 'string' && typeof x.name === 'string');
}

/** 레시피 실행 (본문 없는 POST, 쿼리로 식별) */
export async function runScene(s: HejSession, familyId: number, sceneId: string): Promise<void> {
  const res = await fetch(`${SQUARE_ORIGIN}/dashboard/scene/?family-id=${familyId}&scene-id=${encodeURIComponent(sceneId)}`, {
    method: 'POST', headers: authHeaders(s),
  });
  if (!res.ok) throw new Error(`레시피 실행 실패 (${res.status})`);
}

/** 기기 제어. requirments 는 한 번에 하나의 키만 권장(IR은 명령 1개/요청) */
export async function control(s: HejSession, deviceId: string, requirments: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SQUARE_ORIGIN}/dashboard/control/${deviceId}`, {
    method: 'POST',
    headers: authHeaders(s),
    body: JSON.stringify({ requirments }),
  });
  if (!res.ok) throw new Error(`control ${deviceId} 실패 (${res.status})`);
}

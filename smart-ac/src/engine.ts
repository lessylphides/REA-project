// 자동화 결정 로직: 실내온도 + 계절/바깥날씨 → 에어컨을 어떻게 할지 결정
import { Config, DesiredAcState, HvacFanSpeed, DEFAULT_HOURS, AC_TEMP_MIN, AC_TEMP_MAX } from './config';

export interface Reading {
  indoorTemp: number;        // ℃ (온습도계)
  indoorHumidity?: number;   // %
  outdoorTemp?: number | null; // ℃ (OpenWeatherMap, 없으면 null)
  now?: Date;
}

/** 영업 중 3단계: 가동(boost) → 완만 유지(soft) → 쉬기(rest) */
export type Stage = 'boost' | 'soft' | 'rest';
/** 단계 상태(실행 사이에 KV에 저장) */
export interface Ctl { stage: Stage; since: number; season: 'cooling' | 'heating'; setback?: boolean; }

export interface Decision {
  action: 'set' | 'off' | 'hold';
  desired?: DesiredAcState;
  seasonMode: 'cooling' | 'heating' | 'neutral';
  reason: string;
  /** 목표 도달 후 유지 중(완만 유지/쉬기) */
  maintaining?: boolean;
  /** 영업 중 단계 */
  stage?: Stage;
  /** 다음 실행에 넘길 단계 상태 (null = 초기화) */
  ctl?: Ctl | null;
}

/**
 * 계절 판단: 바깥 날씨(있으면 우선) + 날짜(월)로 냉방철/난방철 결정.
 *  - 바깥기온 >= 24 → 냉방철,  <= 12 → 난방철, 그 사이는 월로 보조 판단
 */
function decideSeason(outdoorTemp: number | null | undefined, month: number): 'cooling' | 'heating' | 'neutral' {
  if (typeof outdoorTemp === 'number') {
    if (outdoorTemp >= 24) return 'cooling';
    if (outdoorTemp <= 12) return 'heating';
    // 간절기: 월로 기울기 판단 (5~9월은 냉방 쪽, 11~3월은 난방 쪽)
    if (month >= 5 && month <= 9) return 'cooling';
    if (month === 11 || month === 12 || month <= 3) return 'heating';
    return 'neutral';
  }
  // 바깥 날씨 없을 때: 월 기준 (한국 기후 기준, 11~3월 난방 / 6~9월 냉방)
  if (month >= 6 && month <= 9) return 'cooling';
  if (month >= 11 || month <= 3) return 'heating';
  return 'neutral';
}

/** "HH:MM" → 분. "24:00"=1440 */
function hm(s: string): number { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); }

/** 요일(day 0=일)·분(minutes)이 영업시간 안인가 (자정 넘김 처리 포함) */
function isOpenAt(hours: Config['hours'], day: number, minutes: number): boolean {
  const H = hours && hours.length === 7 ? hours : DEFAULT_HOURS;
  const today = H[day];
  if (today && !today.closed) {
    const o = hm(today.open), c = hm(today.close);
    if (c > o) { if (minutes >= o && minutes < c) return true; }        // 같은 날 영업
    else { if (minutes >= o) return true; }                            // 자정 넘김: 당일 open~24시
  }
  const prev = H[(day + 6) % 7]; // 전날
  if (prev && !prev.closed) {
    const o = hm(prev.open), c = hm(prev.close);
    if (c <= o && minutes < c) return true;                            // 전날이 자정 넘겨 오늘 0~c시까지
  }
  return false;
}

/**
 * 영업시간 판단 (한국시간 기준, cfg.hours 사용).
 * comfort=true면 쾌적 목표(22/25), false면 비영업 세트백.
 */
export function scheduleState(now: Date, cfg: Config): { state: 'open' | 'preheat' | 'closed'; comfort: boolean } {
  if (cfg.useSchedule === false) return { state: 'open', comfort: true };
  const kst = (d: Date) => new Date(d.getTime() + 9 * 3600 * 1000); // UTC→KST(+9), getUTC*로 읽음
  const at = (d: Date) => { const k = kst(d); return isOpenAt(cfg.hours, k.getUTCDay(), k.getUTCHours() * 60 + k.getUTCMinutes()); };
  if (at(now)) return { state: 'open', comfort: true };
  if (at(new Date(now.getTime() + (cfg.preheatMinutes ?? 60) * 60000))) return { state: 'preheat', comfort: true };
  return { state: 'closed', comfort: false };
}

/** 다음 영업상태 전환(열림↔닫힘) 시각 (한국시간). 최대 8일 탐색. */
export function nextTransition(now: Date, cfg: Config): { opensNext: boolean; at: number } | null {
  if (cfg.useSchedule === false) return null;
  const dm = (d: Date) => { const k = new Date(d.getTime() + 9 * 3600 * 1000); return { day: k.getUTCDay(), min: k.getUTCHours() * 60 + k.getUTCMinutes() }; };
  const cur = dm(now);
  const openNow = isOpenAt(cfg.hours, cur.day, cur.min);
  const base = Math.floor(now.getTime() / (5 * 60000)) * 5 * 60000; // 5분 눈금에 맞춰 '13:01' 같은 어긋남 방지
  for (let step = 1; step <= 8 * 24 * 12; step++) { // 5분 간격
    const t = new Date(base + step * 5 * 60000);
    const x = dm(t);
    if (isOpenAt(cfg.hours, x.day, x.min) !== openNow) return { opensNext: !openNow, at: t.getTime() };
  }
  return null;
}

export function decide(reading: Reading, cfg: Config, comfort = true, prevCtl: Ctl | null = null): Decision {
  const now = reading.now ?? new Date();
  const month = now.getMonth() + 1;
  const season = decideSeason(reading.outdoorTemp, month);
  const indoor = reading.indoorTemp;
  const bias = cfg.acBias ?? 5;
  const fanBoost: HvacFanSpeed = cfg.fanSpeed ?? 'medium';
  const clamp = (v: number) => Math.max(AC_TEMP_MIN, Math.min(AC_TEMP_MAX, Math.round(v)));
  const t1 = (v: number) => v.toFixed(1);

  // 간절기: 적극 제어 안 함
  if (season === 'neutral') return { action: 'hold', seasonMode: 'neutral', ctl: null,
    reason: `간절기(냉난방 불필요 판단) · 실내 ${t1(indoor)}℃ → 유지` };

  const heating = season === 'heating';
  const mode = heating ? 'heat' : 'cool';
  const target = heating ? cfg.winterTarget : cfg.summerTarget;
  const label = heating ? '난방' : '냉방';
  // over: 목표를 '넘어선' 정도 (난방은 더 따뜻할수록 +, 냉방은 더 시원할수록 +)
  const over = heating ? indoor - target : target - indoor;

  // 비영업(세트백): 최저 기준(여름은 상한) '이하'가 되면 바로 켜서, 기준 ± 여유폭까지 한 번에 맞춘 뒤 OFF.
  // 여유폭을 기준 '바깥'이 아닌 '안쪽'에 둬서 기준 온도 자체는 지키고, 껐다 켰다는 줄인다.
  if (!comfort) {
    const band = cfg.setbackBand ?? 3;
    const stopAt = heating ? target + band : target - band;
    const running = !!prevCtl?.setback && prevCtl.season === season;   // 지난번부터 세트백 운전 중인지
    if (over <= 0 || (running && over < band)) {
      const ctl: Ctl = { stage: 'boost', since: running && prevCtl ? prevCtl.since : now.getTime(), season, setback: true };
      return { action: 'set', seasonMode: season, ctl,
        desired: { power: true, mode, temperature: clamp(heating ? target + bias : target - bias), fanSpeed: fanBoost },
        reason: `비영업 · 실내 ${t1(indoor)}℃ → 기준 ${target}℃ 지키려고 ${label} (${stopAt}℃까지)` };
    }
    return { action: 'off', seasonMode: season, ctl: null,
      reason: running ? `비영업 · 실내 ${t1(indoor)}℃ ${stopAt}℃ 도달 → 에어컨 OFF(절전)` : `비영업 · 실내 ${t1(indoor)}℃ → 에어컨 OFF(절전, ${target}℃ ${heating ? '이하' : '이상'}이면 ${label})` };
  }

  // 영업 중: 모드는 그대로 두고 설정온도·바람세기만 바꿔 부드럽게 (풍향 유지)
  const prev = prevCtl && prevCtl.season === season ? prevCtl.stage : null;
  const observeMs = (cfg.observeMinutes ?? 30) * 60000;
  const restAbove = cfg.restAbove ?? 1;
  const elapsed = prevCtl && prev ? now.getTime() - prevCtl.since : 0;

  let stage: Stage;
  if (over <= -cfg.deadband) stage = 'boost';                       // 목표보다 확실히 춥/덥다
  else if (prev === 'rest') stage = over < 0 ? 'soft' : 'rest';     // 쉬다가 목표 아래로 → 살살 다시
  else if (prev === 'soft') {
    if (over >= restAbove + 1) stage = 'rest';                      // 많이 넘침 → 바로 쉬기(안전)
    else if (over >= restAbove && elapsed >= observeMs) stage = 'rest'; // 지켜봤는데도 계속 넘침
    else stage = 'soft';
  } else if (prev === 'boost') stage = over >= 0 ? 'soft' : 'boost'; // 목표 도달 → 완만 유지
  else stage = 'soft';                                               // 상태 없음 + 목표 근처 → 부드럽게 시작

  const since = prevCtl && prev === stage ? prevCtl.since : now.getTime();
  const ctl: Ctl = { stage, since, season };

  if (stage === 'boost') {
    const acSet = clamp(heating ? target + bias : target - bias);
    return { action: 'set', seasonMode: season, stage, ctl,
      desired: { power: true, mode, temperature: acSet, fanSpeed: fanBoost },
      reason: `${label} 가동 · 실내 ${t1(indoor)}℃ → 에어컨 ${acSet}℃로 세게 (목표 ${target}℃)` };
  }
  if (stage === 'soft') {
    const mins = Math.max(0, Math.round((observeMs - (now.getTime() - since)) / 60000));
    return { action: 'set', seasonMode: season, stage, ctl, maintaining: true,
      desired: { power: true, mode, temperature: clamp(target), fanSpeed: 'low' },
      reason: `완만 유지 · 실내 ${t1(indoor)}℃ → 설정 ${clamp(target)}℃·바람 약으로 살살` + (mins > 0 ? ` (추이 관찰 ${mins}분 남음)` : '') };
  }
  const restSet = heating ? AC_TEMP_MIN : AC_TEMP_MAX;
  return { action: 'set', seasonMode: season, stage, ctl, maintaining: true,
    desired: { power: true, mode, temperature: restSet, fanSpeed: 'low' },
    reason: `쉬기 · 실내 ${t1(indoor)}℃ (목표 ${target}℃보다 ${heating ? '따뜻함' : '시원함'}) → 설정 ${restSet}℃·바람 약으로 쉬며 관찰, 목표 ${heating ? '아래로 내려가면' : '위로 올라가면'} 다시 살살` };
}

// ---------- 그날만 영업 연장 / 일찍 마감 ----------
/** 사장님이 직접 정한 그날의 예외: extend=until까지 영업 중, close=until(원래 마감)까지 비영업 */
export interface BizOverride { type: 'extend' | 'close'; until: number; from?: number; }

export function activeOverride(ov: BizOverride | null | undefined, now: Date): BizOverride | null {
  return ov && typeof ov.until === 'number' && ov.until > now.getTime() ? ov : null;
}

/** 예외를 반영한 영업 상태 */
export function scheduleWithOverride(now: Date, cfg: Config, ov: BizOverride | null | undefined) {
  const a = cfg.useSchedule === false ? null : activeOverride(ov, now);
  if (!a) return scheduleState(now, cfg);
  return a.type === 'extend' ? { state: 'open' as const, comfort: true } : { state: 'closed' as const, comfort: false };
}

/** 예외를 반영한 다음 영업 전환 시각 */
export function nextTransitionWithOverride(now: Date, cfg: Config, ov: BizOverride | null | undefined) {
  const a = cfg.useSchedule === false ? null : activeOverride(ov, now);
  if (!a) return nextTransition(now, cfg);
  if (a.type === 'extend') return { opensNext: false, at: a.until };
  return nextTransition(new Date(a.until), cfg);
}

/** '+N분 연장'을 눌렀을 때의 새 연장 끝 시각: 이미 연장 중이면 거기서, 영업 중이면 원래 마감에서, 아니면 지금부터 */
export function extendUntil(now: Date, cfg: Config, ov: BizOverride | null | undefined, minutes: number): number {
  const a = activeOverride(ov, now);
  let base = now.getTime();
  if (a?.type === 'extend') base = a.until;
  else if (scheduleState(now, cfg).state === 'open') base = nextTransition(now, cfg)?.at ?? base;
  return base + minutes * 60000;
}

/** '지금 마감'의 끝 시각: 지금(또는 곧 시작할) 영업이 원래 끝나는 시각까지 비영업 */
export function closeUntil(now: Date, cfg: Config): number | null {
  const st = scheduleState(now, cfg).state;
  if (st === 'closed') return null; // 영업 중·예열 중일 때만 (휴무일에 다음 영업을 미리 닫지 않게)
  const nt = nextTransition(now, cfg);
  if (!nt) return null;
  if (st === 'open' && !nt.opensNext) return nt.at;
  const after = nextTransition(new Date(nt.at), cfg); // 예열 중이면: 곧 열리고 → 그 영업이 끝나는 시각
  return after && !after.opensNext ? after.at : null;
}

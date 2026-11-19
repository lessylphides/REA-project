// 자동화 결정 로직: 실내온도 + 계절/바깥날씨 → 에어컨을 어떻게 할지 결정
import { Config, DesiredAcState, HvacFanSpeed, DEFAULT_HOURS, AC_TEMP_MIN, AC_TEMP_MAX } from './config';

export interface Reading {
  indoorTemp: number;        // ℃ (온습도계)
  indoorHumidity?: number;   // %
  outdoorTemp?: number | null; // ℃ (OpenWeatherMap, 없으면 null)
  now?: Date;
}

export interface Decision {
  action: 'set' | 'off' | 'hold';
  desired?: DesiredAcState;
  seasonMode: 'cooling' | 'heating' | 'neutral';
  reason: string;
  /** 목표 도달 후 송풍 순환 유지 중(영업시간) */
  maintaining?: boolean;
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
  for (let step = 1; step <= 8 * 24 * 12; step++) { // 5분 간격
    const t = new Date(now.getTime() + step * 5 * 60000);
    const x = dm(t);
    if (isOpenAt(cfg.hours, x.day, x.min) !== openNow) return { opensNext: !openNow, at: t.getTime() };
  }
  return null;
}

export function decide(reading: Reading, cfg: Config, comfort = true): Decision {
  const now = reading.now ?? new Date();
  const month = now.getMonth() + 1;
  const season = decideSeason(reading.outdoorTemp, month);
  const indoor = reading.indoorTemp;
  const bias = cfg.acBias ?? 5;
  const fan: HvacFanSpeed = cfg.fanSpeed ?? 'medium'; // 고정 — 매 명령마다 바꾸지 않아 풍향 리셋 방지
  const clamp = (v: number) => Math.max(AC_TEMP_MIN, Math.min(AC_TEMP_MAX, Math.round(v)));

  // 핵심: 영업 중엔 '모드'를 절대 바꾸지 않는다(송풍 모드로 전환하면 상/하·좌/우 풍향이 리셋됨).
  //  - 가동: 같은 모드에서 설정온도를 (목표±보정)으로 강하게
  //  - 도달(유지): 모드/바람세기 그대로 두고 설정온도만 끝값으로 → 에어컨이 알아서 공회전(송풍처럼)
  //    → 바뀌는 건 '설정온도'뿐이라 풍향이 안 풀린다.
  //  - 비영업: 절전을 위해 완전 OFF (하루 1회 전원 토글이라 리셋돼도 영향 적음)
  if (season === 'cooling') {
    const target = cfg.summerTarget;
    if (indoor >= target + cfg.deadband) {               // 덥다 → 냉방 가동
      const acSet = clamp(target - bias);
      return {
        action: 'set', seasonMode: 'cooling',
        desired: { power: true, mode: 'cool', temperature: acSet, fanSpeed: fan },
        reason: `냉방철 · 실내 ${indoor.toFixed(1)}℃ → 냉방(에어컨 ${acSet}℃로 강하게, 실내 ${target}℃까지)`,
      };
    }
    if (indoor <= target) {                              // 매장이 목표 도달
      if (comfort) return {
        action: 'set', seasonMode: 'cooling', maintaining: true,
        desired: { power: true, mode: 'cool', temperature: AC_TEMP_MAX, fanSpeed: fan },
        reason: `실내 ${indoor.toFixed(1)}℃ 목표 ${target}℃ 도달 → 냉방 공회전(설정 ${AC_TEMP_MAX}℃·모드/풍향 유지)`,
      };
      return { action: 'off', seasonMode: 'cooling',
        reason: `실내 ${indoor.toFixed(1)}℃ 목표 ${target}℃ 도달 → 에어컨 OFF(절전)` };
    }
    return { action: 'hold', seasonMode: 'cooling',
      reason: `냉방철 · 실내 ${indoor.toFixed(1)}℃ (목표 ${target}℃ 근처) → 유지` };
  }

  if (season === 'heating') {
    const target = cfg.winterTarget;
    if (indoor <= target - cfg.deadband) {               // 춥다 → 난방 가동
      const acSet = clamp(target + bias);
      return {
        action: 'set', seasonMode: 'heating',
        desired: { power: true, mode: 'heat', temperature: acSet, fanSpeed: fan },
        reason: `난방철 · 실내 ${indoor.toFixed(1)}℃ → 난방(에어컨 ${acSet}℃로 강하게, 실내 ${target}℃까지)`,
      };
    }
    if (indoor >= target) {                              // 매장이 목표 도달
      if (comfort) return {
        action: 'set', seasonMode: 'heating', maintaining: true,
        desired: { power: true, mode: 'heat', temperature: AC_TEMP_MIN, fanSpeed: fan },
        reason: `실내 ${indoor.toFixed(1)}℃ 목표 ${target}℃ 도달 → 난방 공회전(설정 ${AC_TEMP_MIN}℃·모드/풍향 유지)`,
      };
      return { action: 'off', seasonMode: 'heating',
        reason: `실내 ${indoor.toFixed(1)}℃ 목표 ${target}℃ 도달 → 에어컨 OFF(절전)` };
    }
    return { action: 'hold', seasonMode: 'heating',
      reason: `난방철 · 실내 ${indoor.toFixed(1)}℃ (목표 ${target}℃ 근처) → 유지` };
  }

  // 간절기: 적극 제어 안 함
  return { action: 'hold', seasonMode: 'neutral',
    reason: `간절기(냉난방 불필요 판단) · 실내 ${indoor.toFixed(1)}℃ → 유지` };
}

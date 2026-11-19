// 자동화 결정 로직: 실내온도 + 계절/바깥날씨 → 에어컨을 어떻게 할지 결정
import { Config, DesiredAcState, HvacFanSpeed, DEFAULT_HOURS } from './config';

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
}

/** 바람세기: 목표와의 온도차가 클수록 강하게 */
function fanByGap(gap: number): HvacFanSpeed {
  if (gap >= 3) return 'high';
  if (gap >= 1.5) return 'medium';
  return 'low';
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

export function decide(reading: Reading, cfg: Config): Decision {
  const now = reading.now ?? new Date();
  const month = now.getMonth() + 1;
  const season = decideSeason(reading.outdoorTemp, month);
  const indoor = reading.indoorTemp;
  const bias = cfg.acBias ?? 5;
  const clamp = (v: number) => Math.max(16, Math.min(30, Math.round(v)));

  // room-follow: 에어컨은 (목표±보정)으로 '강하게' 틀어 송풍 전환을 막고,
  // 켜고 끄는 판단은 우리 온습도계(매장 중앙)가 목표에 닿는 시점으로.
  if (season === 'cooling') {
    const target = cfg.summerTarget;
    if (indoor >= target + cfg.deadband) {               // 덥다 → 냉방 가동
      const fan = fanByGap(indoor - target);
      const acSet = clamp(target - bias);
      return {
        action: 'set', seasonMode: 'cooling',
        desired: { power: true, mode: 'cool', temperature: acSet, fanSpeed: fan },
        reason: `냉방철 · 실내 ${indoor.toFixed(1)}℃ → 냉방(에어컨 ${acSet}℃로 강하게, 실내 ${target}℃까지)/${fan}`,
      };
    }
    if (indoor <= target) {                              // 매장이 목표 도달 → 끔
      return { action: 'off', seasonMode: 'cooling',
        reason: `냉방철 · 실내 ${indoor.toFixed(1)}℃ ≤ 목표 ${target}℃ → 에어컨 OFF` };
    }
    return { action: 'hold', seasonMode: 'cooling',
      reason: `냉방철 · 실내 ${indoor.toFixed(1)}℃ (목표 ${target}℃ 근처) → 유지` };
  }

  if (season === 'heating') {
    const target = cfg.winterTarget;
    if (indoor <= target - cfg.deadband) {               // 춥다 → 난방 가동
      const fan = fanByGap(target - indoor);
      const acSet = clamp(target + bias);
      return {
        action: 'set', seasonMode: 'heating',
        desired: { power: true, mode: 'heat', temperature: acSet, fanSpeed: fan },
        reason: `난방철 · 실내 ${indoor.toFixed(1)}℃ → 난방(에어컨 ${acSet}℃로 강하게, 실내 ${target}℃까지)/${fan}`,
      };
    }
    if (indoor >= target) {                              // 매장이 목표 도달 → 끔
      return { action: 'off', seasonMode: 'heating',
        reason: `난방철 · 실내 ${indoor.toFixed(1)}℃ ≥ 목표 ${target}℃ → 에어컨 OFF` };
    }
    return { action: 'hold', seasonMode: 'heating',
      reason: `난방철 · 실내 ${indoor.toFixed(1)}℃ (목표 ${target}℃ 근처) → 유지` };
  }

  // 간절기: 적극 제어 안 함
  return { action: 'hold', seasonMode: 'neutral',
    reason: `간절기(냉난방 불필요 판단) · 실내 ${indoor.toFixed(1)}℃ → 유지` };
}

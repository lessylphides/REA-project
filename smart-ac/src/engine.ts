// 자동화 결정 로직: 실내온도 + 계절/바깥날씨 → 에어컨을 어떻게 할지 결정
import { Config, DesiredAcState, HvacFanSpeed } from './config';

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
  // 바깥 날씨 없을 때: 월 기준
  if (month >= 6 && month <= 9) return 'cooling';
  if (month === 12 || month <= 2) return 'heating';
  return 'neutral';
}

export function decide(reading: Reading, cfg: Config): Decision {
  const now = reading.now ?? new Date();
  const month = now.getMonth() + 1;
  const season = decideSeason(reading.outdoorTemp, month);
  const indoor = reading.indoorTemp;

  if (season === 'cooling') {
    const target = cfg.summerTarget;
    if (indoor >= target + cfg.deadband) {
      const fan = fanByGap(indoor - target);
      return {
        action: 'set', seasonMode: 'cooling',
        desired: { power: true, mode: 'cool', temperature: target, fanSpeed: fan },
        reason: `냉방철 · 실내 ${indoor.toFixed(1)}℃ ≥ 목표 ${target}℃+${cfg.deadband} → 냉방 ${target}℃/${fan}`,
      };
    }
    if (indoor <= target - cfg.deadband) {
      return { action: 'off', seasonMode: 'cooling',
        reason: `냉방철 · 실내 ${indoor.toFixed(1)}℃ 가 이미 시원함 → 에어컨 OFF` };
    }
    return { action: 'hold', seasonMode: 'cooling',
      reason: `냉방철 · 실내 ${indoor.toFixed(1)}℃ 쾌적 범위 → 유지` };
  }

  if (season === 'heating') {
    const target = cfg.winterTarget;
    if (indoor <= target - cfg.deadband) {
      const fan = fanByGap(target - indoor);
      return {
        action: 'set', seasonMode: 'heating',
        desired: { power: true, mode: 'heat', temperature: target, fanSpeed: fan },
        reason: `난방철 · 실내 ${indoor.toFixed(1)}℃ ≤ 목표 ${target}℃-${cfg.deadband} → 난방 ${target}℃/${fan}`,
      };
    }
    if (indoor >= target + cfg.deadband) {
      return { action: 'off', seasonMode: 'heating',
        reason: `난방철 · 실내 ${indoor.toFixed(1)}℃ 가 이미 따뜻함 → 에어컨 OFF` };
    }
    return { action: 'hold', seasonMode: 'heating',
      reason: `난방철 · 실내 ${indoor.toFixed(1)}℃ 쾌적 범위 → 유지` };
  }

  // 간절기: 적극 제어 안 함
  return { action: 'hold', seasonMode: 'neutral',
    reason: `간절기(냉난방 불필요 판단) · 실내 ${indoor.toFixed(1)}℃ → 유지` };
}

// 가습기 자동 제어 (헤이홈 레시피 = 버튼 하나로 켜고 끄는 토글)
// 가습기는 상태를 알려주지 않으므로 '앱이 기억한 상태'로 판단하고,
// 습도 추이로 반응이 없으면 더 누르지 않고 경고만 한다(헛돌기 방지).
import type { Config } from './config';

export interface HumState {
  on: boolean;            // 앱이 기억하는 켜짐/꺼짐
  since: number;          // 마지막으로 바뀐 시각(ms)
  startHum: number | null; // 켠 순간 습도 (반응 확인용)
  warn?: boolean;         // 켰는데 습도가 안 올라 자동 멈춤
}

export const HUM_DEFAULT: HumState = { on: false, since: 0, startHum: null };
const MIN = 60000;

/** '가습' 레시피 중 전원 버튼 찾기: 이름에 전원/켜/끄/on/off/power, 없으면 '가습' 레시피가 하나뿐일 때 그것 */
export function findHumPowerScene<T extends { name: string }>(scenes: T[]): T | null {
  const hum = scenes.filter((s) => /가습/.test(s.name));
  return hum.find((s) => /전원|켜|끄|on|off|power/i.test(s.name)) ?? (hum.length === 1 ? hum[0] : null);
}

export interface HumDecision { toggle: boolean; next: HumState; reason: string; }

export function humDecide(cfg: Config, hum: number | null, schedState: string | undefined, st: HumState, now: number): HumDecision {
  const low = cfg.humLow ?? 40, high = cfg.humHigh ?? 55;
  if (hum == null) return { toggle: false, next: st, reason: '습도 값을 못 읽어 대기' };
  const active = cfg.humBizOnly === false ? true : schedState !== 'closed';

  let want = st.on;
  if (!active) want = false;
  else if (hum < low) want = true;
  else if (hum >= high) want = false;

  // 반응 없음 경고: 켠 지 1시간 지났는데 습도가 1%p도 안 올랐으면.
  // 경고 중에도 '끄기'(마감/습도 충분)는 그대로 보낸다 — 켜는 쪽만 멈춤(헛돌기 방지)
  const noRise = st.on && st.startHum != null && now - st.since >= 60 * MIN && hum < high && hum - st.startHum < 1;
  if (st.warn || noRise) {
    const warned: HumState = { ...st, warn: true };
    if (st.on && !want && now - st.since >= 20 * MIN) {
      return { toggle: true, next: { on: false, since: now, startHum: null, warn: false },
        reason: active ? `습도 ${hum}% ≥ ${high}% → 가습기 끄기` : '비영업 → 가습기 끄기' };
    }
    return { toggle: false, next: warned,
      reason: `가습기를 켰는데 습도가 안 올라요(${st.startHum ?? '?'}%→${hum}%) — 물/전원 확인, 매장이 넓으면 천천히 오를 수 있어요` };
  }

  if (want === st.on) {
    return { toggle: false, next: st, reason: st.on ? `가습 중 · 습도 ${hum}% (목표 ${high}%까지)` : (active ? `습도 ${hum}% · 가습 필요 없음` : '비영업 · 가습 쉼') };
  }
  if (now - st.since < 20 * MIN) return { toggle: false, next: st, reason: '방금 바꿔서 잠시 대기(20분)' };
  return {
    toggle: true,
    next: { on: want, since: now, startHum: hum, warn: false },
    reason: want ? `습도 ${hum}% < ${low}% → 가습기 켜기` : (active ? `습도 ${hum}% ≥ ${high}% → 가습기 끄기` : '비영업 → 가습기 끄기'),
  };
}

// 날개(상하 풍향) 위로 고정
// 상하 DIY 버튼은 '움직임 켜기/끄기' 토글이고, 움직이는 중에 다시 누르면 그 자리에서 멈춤.
// 에어컨이 켜지면 날개는 항상 가운데에서 시작 → 상하 켜고 N초 뒤 다시 눌러 위에서 멈춤.
// 단, 켜진 직후(실외기·바람이 나오기 전)엔 날개가 반응하지 않으므로
// 다음 자동 실행(8분 이상 지난 뒤)에 온도가 움직이기 시작했는지 확인하고 고정한다.
import * as hej from './hej';

export interface VaneState {
  pendingSince: number;     // 에어컨을 켜거나 모드를 바꾼 시각(ms)
  startTemp: number | null; // 그때 실내 온도
  mode: 'heat' | 'cool';
  done: boolean;            // 이번 가동에서 이미 고정했는지
}

const MIN = 60000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 에어컨 '상하' 레시피 (가습기 레시피 제외) */
export function findUpDownScene<T extends { name: string }>(scenes: T[]): T | null {
  return scenes.find((x) => /상하/.test(x.name) && !/가습/.test(x.name)) ?? null;
}

/** 상하 켜고 sec초 뒤 다시 눌러 그 자리에서 멈춤 */
export async function fixVane(s: hej.HejSession, familyId: number, sceneId: string, sec: number): Promise<void> {
  const ms = Math.round(Math.max(0.5, Math.min(15, sec)) * 1000);
  await hej.runScene(s, familyId, sceneId);
  await sleep(ms);
  await hej.runScene(s, familyId, sceneId);
}

/** 이번 실행에서 날개를 고정해도 되는지: 켠 지 8분 이상 + 온도가 움직이기 시작(0.5℃) 또는 20분 경과 */
export function vaneReady(st: VaneState | null, temp: number | null, now: number): { ready: boolean; reason: string } {
  if (!st || st.done) return { ready: false, reason: '' };
  const el = now - st.pendingSince;
  if (el < 8 * MIN) return { ready: false, reason: '날개 고정 대기 (에어컨이 바람을 낼 때까지)' };
  const moved = st.startTemp != null && temp != null
    && (st.mode === 'heat' ? temp - st.startTemp >= 0.5 : st.startTemp - temp >= 0.5);
  if (moved) return { ready: true, reason: `온도가 ${st.mode === 'heat' ? '오르기' : '내려가기'} 시작 → 날개 위로 고정` };
  if (el >= 20 * MIN) return { ready: true, reason: '가동 20분 경과 → 날개 위로 고정' };
  return { ready: false, reason: '날개 고정 대기 (온도 변화 확인 중)' };
}

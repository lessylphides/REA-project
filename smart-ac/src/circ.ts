// 서큘레이터 (헤이홈 간편 레시피 = 버튼 하나로 켜고 끄는 토글)
// 상태를 알려주지 않으므로 앱이 켜짐/꺼짐을 기억하고, 실제와 다르면 사용자가 바로잡는다.
// 자동: 영업 중이고 에어컨이 켜져 있으면 켜고, 마감·에어컨 꺼짐이면 끈다.

export interface CircState { on: boolean; since: number; }
export const CIRC_DEFAULT: CircState = { on: false, since: 0 };

const isCirc = (n: string) => /서큘|써큘|순환|circul/i.test(n) && !/가습|상하|좌우/.test(n);
const isPower = (n: string) => /전원|켜|끄|on\b|off\b|power/i.test(n);

/** 서큘레이터 '전원' 레시피: 이름에 서큘레이터 + 전원/켜/끄. 서큘레이터 레시피가 하나뿐이면 그것 (여러 개인데 전원이 없으면 null) */
export function findCircScene<T extends { name: string }>(scenes: T[]): T | null {
  const c = scenes.filter((x) => isCirc(x.name));
  return c.find((x) => isPower(x.name)) ?? (c.length === 1 ? c[0] : null);
}

/** 전원 외의 서큘레이터 레시피(풍량 등) — 리모컨에 별도 버튼으로 */
export function circExtraScenes<T extends { name: string; sceneId: string }>(scenes: T[]): T[] {
  const p = findCircScene(scenes);
  return scenes.filter((x) => isCirc(x.name) && (!p || x.sceneId !== p.sceneId));
}

/** 켜야 하는지: 영업 중(연장 포함) + 에어컨 켜짐. 바꾼 지 5분 안엔 다시 안 바꿈 */
export function circDecide(bizOpen: boolean, acOn: boolean, st: CircState, now: number): { toggle: boolean; want: boolean; reason: string } {
  const want = bizOpen && acOn;
  if (want === st.on) return { toggle: false, want, reason: want ? '영업 중 · 에어컨과 함께 서큘레이터 켜둠' : (bizOpen ? '에어컨 꺼짐 → 서큘레이터 꺼둠' : '비영업 → 서큘레이터 꺼둠') };
  if (now - st.since < 5 * 60000) return { toggle: false, want, reason: '방금 바꿔서 잠시 대기(5분)' };
  return { toggle: true, want, reason: want ? '오픈·에어컨 가동 → 서큘레이터 켜기' : (bizOpen ? '에어컨 꺼짐 → 서큘레이터 끄기' : '마감 → 서큘레이터 끄기') };
}

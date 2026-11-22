// 서큘레이터 (헤이홈 간편 레시피 = 버튼 하나로 켜고 끄는 토글)
// 상태를 알려주지 않으므로 앱이 켜짐/꺼짐을 기억하고, 실제와 다르면 사용자가 바로잡는다.
// 자동: 영업 중이고 에어컨이 켜져 있으면 켜고, 마감·에어컨 꺼짐이면 끈다.

export interface CircState { on: boolean; since: number; }
export const CIRC_DEFAULT: CircState = { on: false, since: 0 };

/** 서큘레이터 레시피: 이름에 서큘/써큘/순환/circul (가습·에어컨 버튼 제외) */
export function findCircScene<T extends { name: string }>(scenes: T[]): T | null {
  return scenes.find((x) => /서큘|써큘|순환|circul/i.test(x.name) && !/가습|상하|좌우/.test(x.name)) ?? null;
}

/** 켜야 하는지: 영업 중(연장 포함) + 에어컨 켜짐. 바꾼 지 5분 안엔 다시 안 바꿈 */
export function circDecide(bizOpen: boolean, acOn: boolean, st: CircState, now: number): { toggle: boolean; want: boolean; reason: string } {
  const want = bizOpen && acOn;
  if (want === st.on) return { toggle: false, want, reason: want ? '영업 중 · 에어컨과 함께 서큘레이터 켜둠' : (bizOpen ? '에어컨 꺼짐 → 서큘레이터 꺼둠' : '비영업 → 서큘레이터 꺼둠') };
  if (now - st.since < 5 * 60000) return { toggle: false, want, reason: '방금 바꿔서 잠시 대기(5분)' };
  return { toggle: true, want, reason: want ? '오픈·에어컨 가동 → 서큘레이터 켜기' : (bizOpen ? '에어컨 꺼짐 → 서큘레이터 끄기' : '마감 → 서큘레이터 끄기') };
}

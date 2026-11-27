// 목표 온도 자동 조정 (사람이 느끼는 방식에 맞춰 천천히)
// 1) 계절감: 최근 이틀가량의 바깥 온도 흐름(가중 평균)을 보고, 포근한 날이 이어지면 겨울 목표를
//    조금 낮추고, 선선한 여름 날이 이어지면 여름 목표를 조금 올린다 (적응형 쾌적 개념).
// 2) 매장이 스스로 내는 열: 에어컨이 세게 데우지 않는데도 최근 40분간 온도가 오르면
//    (손님·조명·주방 열) 겨울 목표를 그만큼 살짝 낮춘다.
// 목표는 30분에 0.5℃씩만 움직여 손님이 변화를 느끼지 않게 한다.
import type { Config } from './config';

export interface AdaptState { w: number; s: number; ts: number; c?: number }  // 지금 쓰는 겨울/여름 목표, c=매장 열 효과(기억)
export interface AdaptInfo {
  baseW: number; baseS: number; w: number; s: number;
  climate: number;   // 계절감으로 인한 겨울 목표 변화(℃, 음수=낮춤)
  climateS: number;  // 계절감으로 인한 여름 목표 변화(℃, 양수=올림)
  crowd: number;     // 매장 열로 인한 겨울 목표 변화(℃)
  trm: number | null; // 최근 바깥 온도 흐름(가중 평균)
  note: string;
}
interface Pt { t: number; temp: number; out: number | null; cmd?: string }

const H = 3600 * 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** 최근 바깥 온도의 가중 평균(가까울수록 크게, 반감 약 17시간). 기록이 없으면 지금 값 */
export function outdoorTrend(hist: Pt[], outNow: number | null, now: number): number | null {
  let sw = 0, sv = 0;
  for (const p of hist) {
    if (typeof p.out !== 'number' || now - p.t > 72 * H) continue;
    const w = Math.exp(-(now - p.t) / (24 * H));
    sw += w; sv += w * p.out;
  }
  if (typeof outNow === 'number') { sw += 1; sv += outNow; }
  return sw > 0 ? sv / sw : null;
}

/** 에어컨이 세게 데우지 않는 동안 최근 40분 온도 상승(℃). 매장이 스스로 데워지는 정도 */
export function selfHeating(hist: Pt[], tempNow: number, now: number): number {
  const win = hist.filter((p) => now - p.t <= 45 * 60000 && now - p.t >= 25 * 60000);
  if (!win.length) return 0;
  const recent = hist.filter((p) => now - p.t <= 45 * 60000);
  if (recent.some((p) => p.cmd === 'heat' || p.cmd === 'cool')) return 0; // 세게 트는 중이면 판단 안 함
  return Math.max(0, tempNow - win[0].temp);
}

export function computeAdapt(cfg: Config, hist: Pt[], outNow: number | null, tempNow: number,
  prev: AdaptState | null | undefined, now: number): { state: AdaptState; info: AdaptInfo } {
  const baseW = cfg.winterTarget, baseS = cfg.summerTarget;
  const maxDown = cfg.adaptMaxDown ?? 3, maxUp = 2;
  const trm = outdoorTrend(hist, outNow, now);
  // 1) 계절감: 바깥 흐름 5℃부터 1℃ 오를 때마다 겨울 목표 0.2℃ 낮춤 / 26℃부터 1℃ 내릴 때마다 여름 목표 0.2℃ 올림
  const climate = trm == null ? 0 : -0.2 * clamp(trm - 5, 0, 20);
  const climateS = trm == null ? 0 : 0.2 * clamp(26 - trm, 0, 15);
  // 2) 매장 열: 40분 사이 0.5℃ 이상 스스로 오르면 그만큼(최대 1.5℃) 겨울 목표를 낮춤
  const rise = selfHeating(hist, tempNow, now);
  const crowdNow = rise >= 0.5 ? -Math.min(1.5, rise) : 0;
  // 매장 열은 빨리 반영하고 천천히 풀림: 손님이 있는 동안 유지, 빠지면 30분에 0.25℃씩 원래대로
  const recover = prev ? 0.25 * Math.min(4, Math.max(0, now - prev.ts) / (30 * 60000)) : 0;
  const crowd = Math.min(crowdNow, Math.min(0, (prev?.c ?? 0) + recover));
  const rawW = clamp(baseW + climate + crowd, baseW - maxDown, baseW);
  const rawS = clamp(baseS + climateS, baseS, baseS + maxUp);
  // 부드럽게: 30분에 0.5℃까지만 이동 (처음이거나 설정이 바뀌어 범위를 벗어나면 바로 맞춤)
  const fresh = !prev || prev.w > baseW || prev.w < baseW - maxDown || prev.s < baseS || prev.s > baseS + maxUp;
  const step = fresh ? Infinity : 0.5 * Math.min(2, (now - prev!.ts) / (30 * 60000));
  const move = (cur: number, to: number) => cur + clamp(to - cur, -step, step);
  const w = r1(fresh ? rawW : move(prev!.w, rawW));
  const s = r1(fresh ? rawS : move(prev!.s, rawS));
  const parts: string[] = [];
  if (Math.abs(climate) >= 0.1) parts.push(`최근 바깥 흐름 ${r1(trm!)}℃로 포근해서 ${r1(climate)}℃`);
  if (crowd < 0) parts.push(crowdNow < 0 ? `매장이 스스로 데워지는 중(40분 +${r1(rise)}℃)이라 ${r1(crowd)}℃` : `손님 열 효과가 천천히 풀리는 중 ${r1(crowd)}℃`);
  const note = `겨울 목표 설정 ${baseW}℃ → 지금 ${w}℃` + (parts.length ? '\n· ' + parts.join('\n· ') : '\n· 조정 없음')
    + (Math.abs(w - rawW) >= 0.1 ? `\n(${r1(rawW)}℃를 향해 30분에 0.5℃씩 천천히 움직이는 중)` : '');
  return { state: { w, s, ts: now, c: r1(crowd) }, info: { baseW, baseS, w, s, climate: r1(climate), climateS: r1(climateS), crowd: r1(crowd), trm: trm == null ? null : r1(trm), note } };
}

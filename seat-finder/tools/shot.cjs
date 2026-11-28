// 1인칭 화면 한 장 찍기 (wrangler dev 가 8787 에서 떠 있어야 함)
// 사용: node tools/shot.cjs <저장할.png> <x> <z> <보는곳x> <보는곳z> [pitch=0] [time=21] [tap=x,y,z] [taps=1]
//   - 걸어 갈 수 없는 곳(벽 너머)으로는 순간이동이 막힘 → 입구 앞(8.1, 10.6)에서 출발해 매장 안 경로로 옮겨 감
//   - tap: 찍기 전 그 3D 지점을 taps 번 누름 (예: 문 5번 눌러 열기 → tap=8.475,1.3,0.08 taps=5)
//   - 바텐더는 사진을 가리지 않게 숨김
const { chromium, devices } = require('playwright');
const [out, x, z, tx, tz, pitch = '0', time = '21', tap, taps = '1'] = process.argv.slice(2);
if (!out || tz == null) { console.log('사용: node tools/shot.cjs out.png x z 보는곳x 보는곳z [pitch] [time] [tap=x,y,z] [taps]'); process.exit(1); }
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('seat-hint-shown', '1'));
  await p.goto(`http://localhost:8787/?time=${time}&debug`); await p.waitForTimeout(4500);
  await p.click('#enterBtn'); await p.click('#entryGo'); await p.waitForFunction(() => window.__walk && __walk.on, null, { timeout: 60000 });
  const X = +x, Z = +z, outside = Z > 9.8 || X < -0.2;
  const path = outside ? [[8.49, 10.6], [X, Z]] : [[8.49, 9.0], [7.5, 7.0], [5.5, 5.0], [X, Z]];
  for (const [a, c] of path) { await p.evaluate(([a, c]) => { __walk.pos.x = a; __walk.pos.z = c; }, [a, c]); await p.waitForTimeout(250); }
  const look = async () => p.evaluate(([tx, tz, pt]) => { const cx = __cam.position.x, cz = __cam.position.z; __walk.yaw = Math.atan2(-(tx - cx), -(tz - cz)); __walk.pitch = pt; for (const bt of __bt) bt.visible = false; }, [+tx, +tz, +pitch]);
  await look(); await p.waitForTimeout(800);
  if (tap) {
    const [a, y, c] = tap.split(',').map(Number);
    for (let i = 0; i < +taps; i++) {
      const sc = await p.evaluate(([a, y, c]) => { const v = __cam.position.clone(); v.set(a, y, c); v.project(__cam); return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; }, [a, y, c]);
      await p.touchscreen.tap(sc[0], sc[1]); await p.waitForTimeout(300);
    }
    await p.waitForTimeout(1500);
  }
  await p.waitForTimeout(800); await p.screenshot({ path: out });
  console.log('카메라', await p.evaluate(() => [__cam.position.x.toFixed(2), __cam.position.z.toFixed(2)]).then((v) => v.join(', ')), '오류', errs.length ? errs : '없음');
  await b.close();
})();

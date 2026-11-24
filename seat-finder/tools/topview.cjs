// 매장을 위에서 내려다본 사진 (천장·위층 숨김, 높은 벽은 2.3m 로 잘라 보여줌)
// 사용: node tools/topview.cjs <저장할.png> [time=13]
const { chromium } = require('playwright');
const [out = 'topview.png', time = '13'] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await (await b.newContext({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 2 })).newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(() => localStorage.setItem('seat-hint-shown', '1'));
  await p.goto(`http://localhost:8787/?time=${time}&debug`); await p.waitForTimeout(6000);
  await p.evaluate(() => {
    let root = __seats.values().next().value.group; while (root.parent) root = root.parent;
    root.traverse((o) => { if (o.isGroup && o.visible === false && o.parent === root) o.visible = true; });
    root.traverse((o) => {
      if (!o.isMesh && !o.isSprite && !o.isLine && !o.isLineSegments) return;
      o.updateWorldMatrix(true, false);
      if (!o.geometry) return; o.geometry.computeBoundingBox(); const bb = o.geometry.boundingBox; if (!bb || !isFinite(bb.min.x)) return;
      const m = o.matrixWorld.elements; let yMin = Infinity, yMax = -Infinity;
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) { const wy = m[1] * x + m[5] * y + m[9] * z + m[13]; yMin = Math.min(yMin, wy); yMax = Math.max(yMax, wy); }
      if (yMin > 2.3 || o.isSprite) { o.visible = false; return; }
      if (yMax > 2.4 && yMin < 0.6 && Math.abs(m[5] - 1) < 0.01) {
        const k = (2.3 - yMin) / (yMax - yMin); o.scale.y *= k; o.updateWorldMatrix(true, false);
        const n = o.matrixWorld.elements; let y2 = Infinity;
        for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) y2 = Math.min(y2, n[1] * x + n[5] * y + n[9] * z + n[13]);
        o.position.y += yMin - y2;
      } else if (yMax > 2.4 && yMin < 0.6) o.visible = false;
    });
    const loop = () => { __cam.position.set(4.3, 28, 3.6); __cam.up.set(0, 0, -1); __cam.lookAt(4.3, 0, 3.6); __cam.fov = 34; __cam.aspect = innerWidth / innerHeight; __cam.updateProjectionMatrix(); requestAnimationFrame(loop); }; loop();
  });
  await p.waitForTimeout(2500); await p.screenshot({ path: out });
  console.log('오류', errs.length ? errs : '없음'); await b.close();
})();

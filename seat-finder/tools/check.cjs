const { chromium, devices } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const out = [];
  for (const [q, label] of [['?time=12', '낮'], ['?time=21', '밤'], ['?locked', '문 잠김'], ['?debug&time=19', '매장 안']]) {
    const p = await (await b.newContext({ ...devices['iPhone 13'] })).newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) errs.push(m.text()); });
    await p.goto('http://localhost:8787/' + q); await p.waitForTimeout(4500);
    const boot = await p.evaluate(() => document.body.classList.contains('booting'));
    let extra = '';
    if (label === '문 잠김') { await p.click('#enterBtn'); await p.waitForTimeout(800); extra = '입장막힘=' + (await p.evaluate(() => document.body.classList.contains('intro') && !document.body.classList.contains('entering'))) + ' 안내=' + (await p.textContent('#toast')); }
    if (label === '매장 안') {
      await p.click('#enterBtn'); await p.waitForFunction(() => window.__walk && __walk.on, null, { timeout: 60000 });
      await p.evaluate(() => { const g = __seats.get('BAR-4').group, a = g.rotation.y; __walk.pos.x = g.position.x - Math.sin(a) * 0.45; __walk.pos.z = g.position.z - Math.cos(a) * 0.45; __walk.yaw = a + Math.PI; });
      await p.waitForTimeout(800); await p.tap('#sitBtn'); await p.waitForTimeout(800);
      extra = 'sit=' + (await p.evaluate(() => __walk.sit)); await p.tap('#sitBtn'); await p.tap('#jumpBtn'); await p.waitForTimeout(600);
      extra += ' stood=' + (await p.evaluate(() => !__walk.sit));
    }
    out.push(`${label}: 로딩완료=${!boot} ${extra} 오류=${errs.length ? errs.join(' / ') : '없음'}`);
    await p.close();
  }
  console.log(out.join('\n')); await b.close();
})();

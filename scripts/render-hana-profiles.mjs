import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'out', 'hana-profiles');
mkdirSync(outDir, { recursive: true });
const fontPath = path.join(root, 'templates', 'fonts', 'PretendardVariable.woff2');

const BLUE = '#2456E5';
const NAVY = '#0B1F3A';
const GRAD = 'linear-gradient(150deg,#1E3A8A 0%,#2456E5 55%,#6D28D9 100%)';

// 모든 시안: 1080x1080, 콘텐츠는 중앙 정렬(원형 크롭 안전). 산세리프(Pretendard).
const wrap = (bg, inner) =>
  `<div style="width:1080px;height:1080px;background:${bg};display:flex;align-items:center;justify-content:center;font-family:Pretendard,sans-serif">${inner}</div>`;

const col = (inner, gap = 0) =>
  `<div style="display:flex;flex-direction:column;align-items:center;gap:${gap}px">${inner}</div>`;

const one = (size, color, extra = '') =>
  `<div style="font-size:${size}px;font-weight:900;color:${color};line-height:.9;letter-spacing:-.03em;${extra}">1</div>`;
const label = (size, color) =>
  `<div style="font-size:${size}px;font-weight:800;color:${color};letter-spacing:-.01em">뉴스하나</div>`;

const VARIANTS = {
  '01-stack': wrap(BLUE, col(one(520, '#fff') + label(120, '#fff'), 24)),
  '02-giant': wrap(BLUE, one(860, '#fff')),
  '03-news-one': wrap(BLUE, col(`<div style="font-size:180px;font-weight:850;color:#fff;letter-spacing:.02em;line-height:1">뉴스</div>` + one(420, '#fff'), 8)),
  '04-light': wrap('#fff', col(one(520, BLUE) + label(120, '#111318'), 24)),
  '05-badge': wrap(BLUE, col(`<div style="width:460px;height:460px;border:16px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center"><span style="font-size:300px;font-weight:900;color:#fff;line-height:1">1</span></div>` + label(110, '#fff'), 56)),
  '06-bubble': wrap(BLUE, col(`<div style="background:#fff;border-radius:88px;padding:50px 120px;position:relative"><span style="font-size:340px;font-weight:900;color:${BLUE};line-height:1">1</span><div style="position:absolute;bottom:-34px;left:96px;width:0;height:0;border-left:44px solid transparent;border-right:44px solid transparent;border-top:52px solid #fff"></div></div>` + label(112, '#fff'), 64)),
  '07-gradient': wrap(GRAD, col(one(520, '#fff') + label(120, '#fff'), 24)),
  '08-list': wrap(BLUE, col(`<div style="font-size:440px;font-weight:900;color:#fff;line-height:.9;letter-spacing:-.04em">1.</div>` + `<div style="font-size:104px;font-weight:800;color:#fff;margin-top:6px">오늘의 뉴스하나</div>`, 0)),
  '09-navy': wrap(NAVY, col(one(520, '#fff') + label(120, '#4C8DFF'), 24)),
  '10-outline': wrap(BLUE, col(`<div style="font-size:540px;font-weight:900;color:transparent;-webkit-text-stroke:12px #fff;line-height:.9;letter-spacing:-.03em">1</div>` + label(120, '#fff'), 10)),
};

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });
const style = `<style>@font-face{font-family:Pretendard;src:url(file://${fontPath}) format('woff2-variations');font-weight:45 920;font-display:block}*{margin:0;padding:0;box-sizing:border-box}</style>`;

for (const [name, body] of Object.entries(VARIANTS)) {
  // 정사각 원본
  const p = await context.newPage();
  await p.setViewportSize({ width: 1080, height: 1080 });
  await p.setContent(style + body);
  await p.evaluate(() => document.fonts.ready);
  const sq = path.join(outDir, `${name}.png`);
  await p.screenshot({ path: sq, type: 'png' });
  await p.close();

  // 원형 미리보기 (IG 크롭 시뮬레이션)
  const dataUri = `data:image/png;base64,${readFileSync(sq).toString('base64')}`;
  const cp = await context.newPage();
  await cp.setViewportSize({ width: 600, height: 600 });
  await cp.setContent(`<body style="margin:0;width:600px;height:600px;background:#e9edf2;display:flex;align-items:center;justify-content:center"><img src="${dataUri}" style="width:500px;height:500px;border-radius:50%"></body>`);
  await cp.evaluate(() => new Promise((r) => { const i = document.querySelector('img'); i.complete ? r() : (i.onload = r); }));
  await cp.screenshot({ path: path.join(outDir, `circle-${name}.jpg`), type: 'jpeg', quality: 92 });
  await cp.close();
  console.log('rendered', name);
}

await browser.close();
console.log('done →', path.relative(root, outDir));

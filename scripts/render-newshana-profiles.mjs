import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'out', 'newshana-profiles');
mkdirSync(outDir, { recursive: true });
const fontPath = path.join(root, 'templates', 'fonts', 'PretendardVariable.woff2');

const BLUE = '#2456E5';
const NAVY = '#0B1F3A';
const GRAD = 'linear-gradient(150deg,#1E3A8A 0%,#2456E5 55%,#6D28D9 100%)';

const wrap = (bg, inner) =>
  `<div style="width:1080px;height:1080px;background:${bg};display:flex;align-items:center;justify-content:center;font-family:Pretendard,sans-serif">${inner}</div>`;
const col = (inner, gap = 0) =>
  `<div style="display:flex;flex-direction:column;align-items:center;gap:${gap}px">${inner}</div>`;
const one = (size, color, extra = '') =>
  `<div style="font-size:${size}px;font-weight:900;color:${color};line-height:.9;letter-spacing:-.03em;${extra}">1</div>`;
// "news 하나" 한 줄 (영문+한글)
const newsHana = (size, color) =>
  `<div style="font-size:${size}px;font-weight:800;color:${color};letter-spacing:-.01em">news <span style="margin-left:.05em">하나</span></div>`;

const VARIANTS = {
  '01-stack': wrap(BLUE, col(one(520, '#fff') + newsHana(130, '#fff'), 20)),
  '02-bistack': wrap(BLUE, col(`<div style="font-size:150px;font-weight:800;color:#fff;letter-spacing:.16em;padding-left:.16em">news</div>` + `<div style="font-size:360px;font-weight:900;color:#fff;line-height:.95;letter-spacing:-.02em">하나</div>`, 8)),
  '03-inline': wrap(BLUE, `<div style="font-size:210px;font-weight:850;color:#fff;letter-spacing:-.02em">news <span style="margin-left:.05em">하나</span></div>`),
  '04-light': wrap('#fff', col(one(520, BLUE) + newsHana(130, '#111318'), 20)),
  '05-badge': wrap(BLUE, col(`<div style="width:460px;height:460px;border:16px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center"><span style="font-size:300px;font-weight:900;color:#fff;line-height:1">1</span></div>` + newsHana(118, '#fff'), 52)),
  '06-bubble': wrap(BLUE, col(`<div style="background:#fff;border-radius:88px;padding:50px 120px;position:relative"><span style="font-size:340px;font-weight:900;color:${BLUE};line-height:1">1</span><div style="position:absolute;bottom:-34px;left:96px;width:0;height:0;border-left:44px solid transparent;border-right:44px solid transparent;border-top:52px solid #fff"></div></div>` + newsHana(126, '#fff'), 58)),
  '07-gradient': wrap(GRAD, col(one(520, '#fff') + newsHana(130, '#fff'), 20)),
  '08-hana-hero': wrap(BLUE, col(`<div style="font-size:400px;font-weight:900;color:#fff;line-height:.95;letter-spacing:-.02em">하나</div>` + `<div style="font-size:130px;font-weight:800;color:#fff;letter-spacing:.18em;padding-left:.18em">news</div>`, 20)),
  '09-navy': wrap(NAVY, col(one(520, '#fff') + newsHana(130, '#4C8DFF'), 20)),
  '10-outline': wrap(BLUE, col(`<div style="font-size:540px;font-weight:900;color:transparent;-webkit-text-stroke:12px #fff;line-height:.9;letter-spacing:-.03em">1</div>` + newsHana(130, '#fff'), 10)),
};

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });
const style = `<style>@font-face{font-family:Pretendard;src:url(file://${fontPath}) format('woff2-variations');font-weight:45 920;font-display:block}*{margin:0;padding:0;box-sizing:border-box}</style>`;

for (const [name, body] of Object.entries(VARIANTS)) {
  const p = await context.newPage();
  await p.setViewportSize({ width: 1080, height: 1080 });
  await p.setContent(style + body);
  await p.evaluate(() => document.fonts.ready);
  const sq = path.join(outDir, `${name}.png`);
  await p.screenshot({ path: sq, type: 'png' });
  await p.close();

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

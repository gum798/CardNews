// 촬영지 섭외만 따로 돌린다 — 일정 파일을 보고 Pexels에서 배경 사진을 구해 텔레그램으로 보고.
//
// 사용: node scripts/scout-places.mjs [out/schedule/YYYYMMDD.json] [--force] [--only=cafe,walk] [--no-report]
//   인자가 없으면 오늘 날짜 일정. --force는 기존 scout.json을 버리고 다시 검색.
//   --only=키,키 는 그 정거장만 다시 뽑는다(--force 포함).
// 보통은 vlog-cycle이 일정 파일을 보고 알아서 섭외하므로, 이 스크립트는 미리 보거나
// 마음에 안 드는 사진을 다시 뽑을 때 쓴다(--force).
import path from 'node:path';
import { Bot } from 'grammy';
import { loadSchedule, scoutSchedule, sendScoutReport, SCHEDULE_DIR } from '../src/vlog/scout.js';
import { telegram } from '../src/config.js';

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').filter(Boolean) : null;
const force = args.includes('--force') || Boolean(only);
const report = !args.includes('--no-report');
const file = args.find((a) => !a.startsWith('--')) || (() => {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return path.join(SCHEDULE_DIR, `${stamp}.json`);
})();

const schedule = loadSchedule(file);
console.log(`[scout] ${schedule.stamp} 「${schedule.title || ''}」 정거장 ${schedule.stops.length}곳`);
const scout = await scoutSchedule(schedule, { force, only });
for (const s of scout.stops) {
  console.log(`  ${s.key.padEnd(8)} ${s.file ? `${s.tier} #${s.credit.id} — ${s.credit.alt.slice(0, 70)}` : '(없음)'}`);
}
if (report) {
  await sendScoutReport(new Bot(telegram.botToken), scout);
  console.log('[scout] 텔레그램 보고 완료');
}

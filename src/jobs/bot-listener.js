// 프로세스 B: launchd KeepAlive로 상시 상주. grammY 롱 폴링.
// 승인(pub) 콜백 → 공유 파이프라인 실행. 스킵(skip) → status=skipped.
// (자동 발행이 켜져 있으면 대부분은 hourly-collect가 자동 처리하고, 여기선 한도 초과분의 수동 승인만 받는다.)
import { startListener } from '../bot/index.js';
import { updateCandidateStatus } from '../db/index.js';
import { generateAndPublish } from '../pipeline.js';
import { dryRun } from '../config.js';

async function onApprove(candidateId) {
  await generateAndPublish(candidateId);
}

async function onSkip(candidateId) {
  updateCandidateStatus(candidateId, 'skipped');
  console.log(`[bot] skipped candidate ${candidateId}`);
}

startListener({ onApprove, onSkip });
console.log(`[bot] listener up (dryRun=${dryRun})`);

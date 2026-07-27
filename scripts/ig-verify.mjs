// IG 토큰 검증 + 계정 ID 자동 조회. .env의 IG_ACCESS_TOKEN을 읽어 상태를 점검한다.
// 실행: NODE_EXTRA_CA_CERTS=certs/corp-root.pem node scripts/ig-verify.mjs
//   --write 를 붙이면 조회한 계정 ID를 .env의 IG_USER_ID에 자동 반영.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { instagram } from '../src/config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV = path.join(ROOT, '.env');
const V = instagram.apiVersion;
const token = instagram.accessToken;
const WRITE = process.argv.includes('--write');

if (!token) {
  console.error('❌ IG_ACCESS_TOKEN이 비어있습니다. .env에 토큰을 넣고 다시 실행하세요.');
  process.exit(1);
}

const call = async (url, label) => {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`${label}: ${body.error ? JSON.stringify(body.error) : 'HTTP ' + res.status}`);
  }
  return body;
};

console.log(`토큰 길이: ${token.length}자, API ${V}\n`);

// 1) 내 계정 정보 (= 발행에 쓸 IG_USER_ID)
const me = await call(
  `https://graph.instagram.com/${V}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(token)}`,
  '계정 조회'
);
const userId = me.user_id || me.id;
console.log('✅ 계정 조회 성공');
console.log(`   username     : @${me.username}`);
console.log(`   account_type : ${me.account_type ?? '(미표시)'}`);
console.log(`   IG_USER_ID   : ${userId}`);

// 2) 발행 권한 확인 (content_publishing_limit는 publish 권한이 있어야 응답)
try {
  const lim = await call(
    `https://graph.instagram.com/${V}/${userId}/content_publishing_limit?fields=config,quota_usage&access_token=${encodeURIComponent(token)}`,
    '발행 한도 조회'
  );
  const q = lim.data?.[0] ?? lim;
  console.log(`✅ 발행 권한 OK — 24h 사용 ${q.quota_usage ?? 0}/${q.config?.quota_total ?? '?'}건`);
} catch (e) {
  console.error(`❌ 발행 권한 확인 실패 — instagram_business_content_publish 스코프가 없을 수 있습니다.\n   ${e.message}`);
}

// 3) .env 반영
const env = readFileSync(ENV, 'utf8');
const cur = env.match(/^IG_USER_ID=(.*)$/m)?.[1]?.trim() ?? '';
if (cur === String(userId)) {
  console.log('\n✅ .env의 IG_USER_ID가 이미 올바릅니다.');
} else if (WRITE) {
  const next = /^IG_USER_ID=.*$/m.test(env)
    ? env.replace(/^IG_USER_ID=.*$/m, `IG_USER_ID=${userId}`)
    : env.trimEnd() + `\nIG_USER_ID=${userId}\n`;
  writeFileSync(ENV, next);
  console.log(`\n✅ .env 갱신: IG_USER_ID ${cur || '(비어있음)'} → ${userId}`);
} else {
  console.log(`\n⚠️ .env의 IG_USER_ID가 다릅니다: 현재 '${cur}' → 올바른 값 '${userId}'`);
  console.log('   --write 로 다시 실행하면 자동 반영합니다.');
}

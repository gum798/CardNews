// R2 연결 스모크 테스트: 작은 파일 업로드 → 공개 URL로 읽기 확인
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(
  readFileSync(path.join(root, '.env'), 'utf-8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  },
});

const key = 'connection-test.txt';
await s3.send(new PutObjectCommand({
  Bucket: env.R2_BUCKET,
  Key: key,
  Body: `CardNews R2 connection test`,
  ContentType: 'text/plain',
}));
console.log('upload ok');

const url = `${env.R2_PUBLIC_URL}/${key}`;
const res = await fetch(url);
console.log('public read:', res.status, res.ok ? await res.text() : '(failed)');
console.log(url);

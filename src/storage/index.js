// R2 업로드 → 공개 URL 반환. scripts/test-r2.mjs의 연결 방식을 그대로 사용.
// 발행 완료 후에도 파일은 유지 (정리는 수동/추후).
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { r2 } from '../config.js';

// import만으로 연결하지 않도록 클라이언트는 최초 업로드 시 지연 생성.
let s3;
function client() {
  if (!s3) {
    s3 = new S3Client({
      region: 'auto',
      endpoint: r2.endpoint,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });
  }
  return s3;
}

// 프로필 접두사를 붙인 실제 객체 키. 계정별 파일이 한 버킷에서 섞이지 않게 한다.
// (기존 프로필은 keyPrefix가 ''이라 예전 키를 그대로 유지)
export function objectKey(key) {
  return r2.keyPrefix ? `${r2.keyPrefix}/${key}` : key;
}

// 업로드 없이 공개 URL만 계산 (이미 올라간 파일을 재발행할 때 사용).
export function publicUrlFor(key) {
  return `${r2.publicUrl}/${objectKey(key)}`;
}

// 로컬 파일을 key로 업로드하고 공개 URL 반환.
export async function uploadFile(key, localPath, contentType) {
  await client().send(new PutObjectCommand({
    Bucket: r2.bucket,
    Key: objectKey(key),
    Body: readFileSync(localPath),
    ContentType: contentType,
  }));
  return publicUrlFor(key);
}

// 후보의 카드 JPEG들과 릴스를 업로드. cardUrls는 입력 순서 유지.
export async function uploadCandidate(candidateId, { cardPaths, reelPath }) {
  const cardUrls = [];
  for (let i = 0; i < cardPaths.length; i++) {
    const url = await uploadFile(`${candidateId}/card-${i + 1}.jpg`, cardPaths[i], 'image/jpeg');
    cardUrls.push(url);
  }
  const reelUrl = await uploadFile(`${candidateId}/reel.mp4`, reelPath, 'video/mp4');
  return { cardUrls, reelUrl };
}

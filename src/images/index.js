// 표지 배경 사진: Pixabay에서 키워드로 세로형 사진 1장을 받아 저장.
// 저작권 안전(무료·출처표기 불필요), 원문 사진 미사용. 실패/키없음이면 null → 사진 없이 진행(베스트에포트).
import { writeFile } from 'node:fs/promises';
import { pixabay } from '../config.js';

export async function fetchTopicImage(keywords, destPath) {
  if (!pixabay.key) return null;
  const q = encodeURIComponent(String(keywords || '').trim());
  if (!q) return null;

  try {
    const url =
      `https://pixabay.com/api/?key=${pixabay.key}&q=${q}` +
      `&image_type=photo&orientation=vertical&safesearch=true&per_page=12&order=popular&min_width=1080`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`pixabay HTTP ${res.status}`);
    const data = await res.json();

    const hit = (data.hits || []).find((h) => h.largeImageURL);
    if (!hit) {
      console.log(`[images] "${keywords}" 검색 결과 없음 → 사진 없이 진행`);
      return null;
    }

    const img = await fetch(hit.largeImageURL);
    if (!img.ok) throw new Error(`image HTTP ${img.status}`);
    await writeFile(destPath, Buffer.from(await img.arrayBuffer()));
    return destPath;
  } catch (err) {
    console.error('[images] fetch 실패(사진 없이 진행):', err.message);
    return null;
  }
}

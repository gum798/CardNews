// 표지 배경 사진: Pixabay 검색 (무료·출처표기 불필요, 원문 사진 미사용).
// 후보 여러 장을 태그와 함께 받아 curator가 관련성으로 1장 선택 → 그 1장만 다운로드.
import { writeFile } from 'node:fs/promises';
import { pixabay } from '../config.js';

// 키워드로 세로 사진 후보 목록 반환 (URL + 태그). 다운로드는 안 함. 키 없으면 [].
export async function searchTopicImages(keywords, count = 10) {
  if (!pixabay.key) return [];
  const q = encodeURIComponent(String(keywords || '').trim());
  if (!q) return [];
  try {
    const url =
      `https://pixabay.com/api/?key=${pixabay.key}&q=${q}` +
      `&image_type=photo&orientation=vertical&safesearch=true&per_page=${count}&order=popular&min_width=1080`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`pixabay HTTP ${res.status}`);
    const data = await res.json();
    return (data.hits || [])
      .filter((h) => h.largeImageURL)
      .map((h) => ({ url: h.largeImageURL, tags: h.tags || '' }));
  } catch (err) {
    console.error('[images] search 실패:', err.message);
    return [];
  }
}

// 단일 이미지 다운로드 → destPath. 실패 시 null.
export async function downloadImage(url, destPath) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return destPath;
  } catch (err) {
    console.error('[images] download 실패:', err.message);
    return null;
  }
}

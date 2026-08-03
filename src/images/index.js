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

// 실사 영상 후보 검색 (Pixabay 동영상). 배경이 실제로 움직이면 정지 사진보다 이탈이 적다.
// 세로 소재는 거의 없으므로 가로(16:9)를 받아 중앙을 세로로 크롭해 쓴다.
// 반환: [{ url, tags, duration, width, height }] — 다운로드는 안 함. 키 없으면 [].
export async function searchTopicVideos(keywords, count = 8) {
  if (!pixabay.key) return [];
  const q = encodeURIComponent(String(keywords || '').trim());
  if (!q) return [];
  try {
    const url =
      `https://pixabay.com/api/videos/?key=${pixabay.key}&q=${q}` +
      `&safesearch=true&per_page=${count}&order=popular`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`pixabay video HTTP ${res.status}`);
    const data = await res.json();
    return (data.hits || [])
      .map((h) => {
        // 세로로 크롭해도 1080폭이 나오도록 높이 1080 이상을 우선. 용량이 과한 4K는 피한다.
        const v = h.videos || {};
        const pick =
          [v.large, v.medium, v.small].find((x) => x?.url && x.height >= 1080 && x.height <= 1440) ||
          v.large ||
          v.medium;
        if (!pick?.url) return null;
        return {
          url: pick.url,
          tags: h.tags || '',
          duration: Number(h.duration) || 0,
          width: pick.width,
          height: pick.height,
        };
      })
      .filter(Boolean)
      .filter((v) => v.duration >= 4); // 너무 짧으면 루프 티가 난다
  } catch (err) {
    console.error('[images] video search 실패:', err.message);
    return [];
  }
}

// 영상 파일 다운로드 → destPath. 실패 시 null.
export async function downloadVideo(url, destPath) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`video HTTP ${res.status}`);
    await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
    return destPath;
  } catch (err) {
    console.error('[images] video download 실패:', err.message);
    return null;
  }
}

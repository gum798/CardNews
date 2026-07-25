// RSS 수집. 피드별로 페치→파싱→정규화→중복제거→DB 삽입.
// XML 파싱은 fast-xml-parser (node 버전 제약 없음). RSS 2.0 / RSS 1.0(RDF) / Atom 지원.
import { XMLParser } from 'fast-xml-parser';
import { feeds } from '../config.js';
import { newsUrlExists, insertNewsItem } from '../db/index.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// URL 트래킹 파라미터. 이걸로 시작하거나 정확히 일치하면 제거.
const TRACKING_EXACT = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid']);
const isTracking = (k) => k.startsWith('utm_') || TRACKING_EXACT.has(k.toLowerCase());

// UTM 등 트래킹 파라미터를 벗겨 URL 정규화. 파싱 실패 시 원문 트림.
function canonicalizeUrl(raw) {
  const s = (raw || '').trim();
  try {
    const u = new URL(s);
    for (const k of [...u.searchParams.keys()]) {
      if (isTracking(k)) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return s;
  }
}

// 텍스트/속성 혼재 노드에서 문자열만 뽑기. {#text} 형태와 배열 대응.
function textOf(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') return textOf(v['#text']);
  return null;
}

// 잔여 HTML 태그 제거 + 공백 정리. (엔티티는 파서가 이미 디코드)
function cleanText(v) {
  const t = textOf(v);
  if (!t) return null;
  const out = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return out || null;
}

// 링크 추출: RSS <link>텍스트, Atom <link href> (rel=alternate/무명 우선), guid/id 폴백.
function extractLink(item) {
  const l = item.link;
  if (typeof l === 'string' && l.trim()) return l.trim();
  if (Array.isArray(l)) {
    let best = null;
    for (const e of l) {
      const href = typeof e === 'string' ? e : e?.['@_href'];
      const rel = (e?.['@_rel'] || '').toLowerCase();
      if (href && (!best || rel === 'alternate' || rel === '')) best = href;
    }
    if (best) return best.trim();
  }
  if (l && typeof l === 'object' && l['@_href']) return String(l['@_href']).trim();
  const g = textOf(item.guid) ?? textOf(item.id);
  if (g && /^https?:\/\//.test(g)) return g.trim();
  return null;
}

// pubDate 편차 대응: 파싱되면 ISO, 아니면 null.
function parseDate(item) {
  const raw = textOf(item.pubDate ?? item.published ?? item.updated ?? item['dc:date'] ?? item.date);
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.valueOf()) ? null : d.toISOString();
}

// RSS 2.0 / RDF / Atom에서 item·entry 목록 추출.
function extractItems(obj) {
  if (obj?.rss?.channel) return toArray(obj.rss.channel).flatMap((c) => toArray(c.item));
  if (obj?.['rdf:RDF']) return toArray(obj['rdf:RDF'].item);
  if (obj?.feed) return toArray(obj.feed.entry);
  return [];
}

// 헤더 charset → 없으면 XML 선언 sniff → 없으면 utf-8. EUC-KR 계열 정규화 후 디코드.
function decodeBody(buf, contentType) {
  let charset = /charset=([^;]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = buf.toString('latin1', 0, 1024);
    charset = /encoding=["']([^"']+)["']/i.exec(head)?.[1];
  }
  let label = (charset || 'utf-8').toLowerCase().trim();
  if (/euc-?kr|ksc|ks_c/.test(label)) label = 'euc-kr';
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// 단일 피드 처리. 파싱된 아이템 목록을 정규화해 반환(삽입은 호출부에서).
async function fetchFeed(feed) {
  const res = await fetch(feed.url, { redirect: 'follow' });
  const status = res.status;
  if (!res.ok) return { status, items: [], error: `HTTP ${status}` };

  const buf = Buffer.from(await res.arrayBuffer());
  const xml = decodeBody(buf, res.headers.get('content-type'));
  const obj = parser.parse(xml);

  const items = [];
  for (const node of extractItems(obj)) {
    const url = extractLink(node);
    const title = cleanText(node.title);
    if (!url || !title) continue;
    items.push({
      source: feed.name,
      url: canonicalizeUrl(url),
      title,
      summary: cleanText(node.description ?? node.summary ?? node['content:encoded'] ?? node.content),
      publishedAt: parseDate(node),
    });
  }
  return { status, items };
}

// 모든 피드 수집. 피드별 try/catch로 하나가 죽어도 나머지 진행.
export async function collect() {
  let inserted = 0;
  const perFeed = [];

  for (const feed of feeds) {
    try {
      const { status, items, error } = await fetchFeed(feed);
      if (error) throw new Error(error);

      let latest = null;
      for (const item of items) {
        if (item.publishedAt && (!latest || item.publishedAt > latest)) latest = item.publishedAt;
        if (newsUrlExists(item.url)) continue;
        if (insertNewsItem(item)) inserted++;
      }

      console.log(`[collector] ${feed.name}: HTTP ${status}, ${items.length} items, latest ${latest || '-'}`);
      perFeed.push({ name: feed.name, ok: true, count: items.length, latest });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[collector] ${feed.name}: FAILED — ${msg}`);
      perFeed.push({ name: feed.name, ok: false, count: 0, latest: null, error: msg });
    }
  }

  return { inserted, perFeed };
}

/*
 * 洛谷用户文章列表导出器 v1（浏览器控制台版）
 * 目标：UID 377873
 *
 * 最终输出：
 * {
 *   "articles": [
 *     { "url": "...", "title": "...", "category": "...", "source": "..." },
 *     ...
 *   ]
 * }
 *
 * 特点：
 * - 严格串行，不并发。
 * - 任意两次网络请求开始时间至少间隔 5.5 秒，再增加 0~0.8 秒随机抖动。
 * - 403 / 429 / 5xx 自动退避重试。
 * - 当前第一页优先直接读取页面中的 lentille-context，不额外请求。
 * - IndexedDB 断点续传；再次运行自动跳过已成功抓取的文章。
 * - 不下载多个 JSON，也不生成 ZIP；最终在控制台输出一个总 JSON。
 */

(async () => {
  'use strict';

  const CONFIG = Object.freeze({
    version: 'v1',
    uid: 377873,
    minRequestIntervalMs: 5500,
    jitterMs: 800,
    maxRetries: 5,
    firstBackoffMs: 30_000,
    maxBackoffMs: 10 * 60_000,
    dbName: 'luogu-article-list-v1-uid-377873',
    dbVersion: 1,
  });

  const CATEGORY_NAMES = Object.freeze({
    1: '个人记录',
    2: '题解',
    3: '科技·工程',
    4: '算法·理论',
    5: '生活·游记',
    6: '学习·文化课',
    7: '休闲·娱乐',
    8: '闲话',
  });

  const EXPECTED_PATH = `/user/${CONFIG.uid}/article`;
  const origin = location.origin;

  if (!/(^|\.)luogu\.com(\.cn)?$/i.test(location.hostname)) {
    alert('请在洛谷网页内运行本脚本。');
    throw new Error('当前页面不是洛谷。');
  }

  if (!location.pathname.replace(/\/$/, '').endsWith(EXPECTED_PATH)) {
    const ok = confirm(
      `建议先打开：\n${origin}${EXPECTED_PATH}\n\n` +
      '当前页面不是目标用户的文章列表页。继续会额外请求第一页，是否继续？'
    );
    if (!ok) return;
  }

  if (window.__LUOGU_ARTICLE_LIST_V1_RUNNING__) {
    alert('v1 已经在运行。');
    return;
  }
  window.__LUOGU_ARTICLE_LIST_V1_RUNNING__ = true;

  let stopRequested = false;
  let lastRequestStartedAt = 0;
  let requestCounter = 0;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const randInt = max => Math.floor(Math.random() * Math.max(1, max));

  function fmtTime(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}min`;
  }

  function createPanel() {
    const old = document.getElementById('luogu-article-list-v1-panel');
    if (old) old.remove();

    const box = document.createElement('div');
    box.id = 'luogu-article-list-v1-panel';
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:min(520px,calc(100vw - 32px))', 'max-height:65vh', 'overflow:auto',
      'padding:12px 14px', 'border-radius:10px', 'background:rgba(17,24,39,.94)',
      'color:#fff', 'font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace',
      'box-shadow:0 10px 36px rgba(0,0,0,.35)', 'white-space:pre-wrap'
    ].join(';');

    const text = document.createElement('div');
    text.textContent = '洛谷文章列表导出器 v1：初始化…';

    const btn = document.createElement('button');
    btn.textContent = '停止并保存进度';
    btn.style.cssText = [
      'margin-top:10px', 'padding:6px 10px', 'border:0', 'border-radius:6px',
      'cursor:pointer', 'background:#ef4444', 'color:#fff', 'font:inherit'
    ].join(';');
    btn.onclick = () => {
      stopRequested = true;
      btn.disabled = true;
      btn.textContent = '已请求停止';
      text.textContent += '\n\n当前请求结束后停止，已完成内容会保留。';
    };

    box.append(text, btn);
    document.body.appendChild(box);

    return {
      set(s) { text.textContent = s; box.scrollTop = box.scrollHeight; },
      append(s) { text.textContent += `\n${s}`; box.scrollTop = box.scrollHeight; },
      done(s) { text.textContent = s; btn.remove(); box.scrollTop = box.scrollHeight; },
    };
  }

  const ui = createPanel();

  function assertNotStopped() {
    if (stopRequested) {
      const e = new Error('用户已停止');
      e.name = 'UserStoppedError';
      throw e;
    }
  }

  function parseRetryAfter(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  }

  async function waitForRateLimit() {
    const jitter = randInt(CONFIG.jitterMs + 1);
    const earliest = lastRequestStartedAt + CONFIG.minRequestIntervalMs + jitter;
    const wait = Math.max(0, earliest - Date.now());
    if (wait > 0) await sleep(wait);
  }

  async function rateLimitedFetch(url, options = {}, label = '请求') {
    let lastError = null;

    for (let attempt = 0; attempt < CONFIG.maxRetries; attempt++) {
      assertNotStopped();
      await waitForRateLimit();
      assertNotStopped();

      lastRequestStartedAt = Date.now();
      requestCounter++;

      let response;
      try {
        response = await fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          ...options,
          headers: {
            accept: 'application/json, text/html, text/plain, */*',
            ...(options.headers || {}),
          },
        });
      } catch (err) {
        lastError = err;
        const backoff = Math.min(
          CONFIG.maxBackoffMs,
          CONFIG.firstBackoffMs * (2 ** attempt)
        ) + randInt(5000);
        ui.append(`${label} 网络错误：${err?.message || err}\n${fmtTime(backoff)} 后重试。`);
        await sleep(backoff);
        continue;
      }

      if (response.ok) return response;

      const body = await response.text().catch(() => '');
      const error = new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 180)}`);
      lastError = error;

      const retryable = response.status === 403 || response.status === 408 ||
        response.status === 425 || response.status === 429 || response.status >= 500;

      if (!retryable) throw error;

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
      const exponential = Math.min(
        CONFIG.maxBackoffMs,
        CONFIG.firstBackoffMs * (2 ** attempt)
      );
      const specialFloor = (response.status === 403 || response.status === 429) ? 60_000 : 0;
      const backoff = Math.max(retryAfter, exponential, specialFloor) + randInt(5000);

      ui.append(`${label} 返回 HTTP ${response.status}，${fmtTime(backoff)} 后退避重试。`);
      await sleep(backoff);
    }

    throw lastError || new Error(`${label} 多次重试后仍失败`);
  }

  function parseLentilleText(text, sourceUrl) {
    const trimmed = text.trim();
    if (!trimmed) throw new Error(`空响应：${sourceUrl}`);

    try {
      return JSON.parse(trimmed);
    } catch (_) {
      // 完整 HTML 时，从 lentille-context 读取。
    }

    const doc = new DOMParser().parseFromString(text, 'text/html');
    const node = doc.querySelector('script#lentille-context');
    if (!node) throw new Error(`无法在响应中找到 lentille-context：${sourceUrl}`);

    try {
      return JSON.parse(node.textContent || '');
    } catch (err) {
      throw new Error(`lentille-context JSON 解析失败：${sourceUrl}\n${err?.message || err}`);
    }
  }

  async function fetchLentille(url, label) {
    const res = await rateLimitedFetch(url, {
      headers: { 'x-lentille-request': 'content-only' },
    }, label);
    return parseLentilleText(await res.text(), url);
  }

  function getCurrentContext() {
    const node = document.querySelector('script#lentille-context');
    if (!node) return null;
    try { return JSON.parse(node.textContent || ''); }
    catch { return null; }
  }

  function getArticleListHolder(payload) {
    return payload?.data?.articles ?? payload?.currentData?.articles ?? payload?.articles ?? null;
  }

  function normalizeList(holder) {
    if (!holder) return [];
    if (Array.isArray(holder)) return holder;
    if (Array.isArray(holder.result)) return holder.result;
    if (holder.result && typeof holder.result === 'object') return Object.values(holder.result);
    return [];
  }

  function getDetailArticle(payload) {
    return payload?.data?.article ?? payload?.currentData?.article ?? payload?.article ?? null;
  }

  function categoryName(categoryId) {
    const id = Number(categoryId);
    if (Number.isFinite(id) && CATEGORY_NAMES[id]) return CATEGORY_NAMES[id];
    return categoryId == null ? '' : String(categoryId);
  }

  function safeLid(raw) {
    const lid = String(raw ?? '').trim();
    if (/^[A-Za-z0-9]{8}$/.test(lid)) return lid;
    const cleaned = lid.replace(/[^A-Za-z0-9]/g, '');
    if (cleaned.length >= 8) return cleaned.slice(0, 8);
    throw new Error(`异常文章 lid：${JSON.stringify(raw)}`);
  }

  // ---------------- IndexedDB ----------------

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.dbName, CONFIG.dbVersion);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('articles')) {
          db.createObjectStore('articles', { keyPath: 'lid' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
    });
  }

  function idbGet(db, storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }

  function idbGetAll(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result || []);
    });
  }

  function idbPut(db, storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
      tx.objectStore(storeName).put(value);
    });
  }

  function idbPutMany(db, storeName, values) {
    if (!values.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
      const store = tx.objectStore(storeName);
      for (const value of values) store.put(value);
    });
  }

  function sameStringArray(a, b) {
    return Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((x, i) => x === b[i]);
  }

  async function mergeListItems(db, items, listPage) {
    const oldAll = await idbGetAll(db, 'articles');
    const oldMap = new Map(oldAll.map(x => [x.lid, x]));
    const merged = [];

    for (const item of items) {
      const lid = safeLid(item?.lid);
      const prev = oldMap.get(lid) || {};
      const categoryId = item?.category ?? prev.categoryId ?? null;
      merged.push({
        ...prev,
        lid,
        url: `${origin}/article/${lid}`,
        title: String(item?.title ?? prev.title ?? ''),
        categoryId,
        category: categoryName(categoryId),
        listPage,
        fetched: Boolean(prev.fetched && typeof prev.source === 'string'),
      });
    }

    await idbPutMany(db, 'articles', merged);
  }

  async function collectIndex(db) {
    ui.set('v1 阶段 1/3：读取文章索引…');

    let firstPayload = getCurrentContext();
    let firstHolder = getArticleListHolder(firstPayload);
    let firstItems = normalizeList(firstHolder);

    if (!firstItems.length) {
      const url = `${origin}${EXPECTED_PATH}`;
      ui.set(`v1 阶段 1/3：请求文章列表第 1 页…\n网络请求计数：${requestCounter}`);
      firstPayload = await fetchLentille(url, '文章列表第 1 页');
      firstHolder = getArticleListHolder(firstPayload);
      firstItems = normalizeList(firstHolder);
    }

    if (!firstItems.length) throw new Error('第一页没有解析到文章列表。');

    const total = Number(firstHolder?.count ?? firstItems.length);
    const perPage = Number(firstHolder?.perPage ?? firstItems.length);
    if (!Number.isFinite(total) || total <= 0) throw new Error(`异常文章总数：${firstHolder?.count}`);
    if (!Number.isFinite(perPage) || perPage <= 0) throw new Error(`异常每页数量：${firstHolder?.perPage}`);

    const totalPages = Math.ceil(total / perPage);
    const firstLids = firstItems.map(x => safeLid(x.lid));
    const cached = await idbGet(db, 'meta', 'index');

    const canResumeIndex = Boolean(
      cached?.complete &&
      cached?.total === total &&
      cached?.perPage === perPage &&
      sameStringArray(cached?.firstLids, firstLids) &&
      Array.isArray(cached?.lids) &&
      cached.lids.length === total
    );

    await mergeListItems(db, firstItems, 1);

    if (canResumeIndex) {
      ui.set(
        `v1 阶段 1/3：索引已有缓存，直接继续。\n` +
        `文章总数：${total}\n列表页：${totalPages}\n网络请求计数：${requestCounter}`
      );
      return cached.lids;
    }

    const allLids = [...firstLids];
    const seen = new Set(allLids);

    await idbPut(db, 'meta', {
      key: 'index', complete: false, total, perPage, totalPages,
      firstLids, lids: allLids.slice(), updatedAt: Date.now(),
    });

    for (let page = 2; page <= totalPages; page++) {
      assertNotStopped();
      ui.set(
        `v1 阶段 1/3：读取文章索引…\n` +
        `列表页：${page}/${totalPages}\n已收集：${allLids.length}/${total}\n` +
        `请求间隔：至少 ${CONFIG.minRequestIntervalMs / 1000}s + 随机抖动\n` +
        `网络请求计数：${requestCounter}`
      );

      const url = `${origin}${EXPECTED_PATH}?page=${page}`;
      const payload = await fetchLentille(url, `文章列表第 ${page} 页`);
      const holder = getArticleListHolder(payload);
      const items = normalizeList(holder);
      if (!items.length) throw new Error(`第 ${page} 页没有解析到文章。`);

      await mergeListItems(db, items, page);

      let added = 0;
      for (const item of items) {
        const lid = safeLid(item.lid);
        if (!seen.has(lid)) {
          seen.add(lid);
          allLids.push(lid);
          added++;
        }
      }

      if (added === 0 && allLids.length < total) {
        throw new Error(`第 ${page} 页与之前页面重复；为防止无限请求，脚本已停止。`);
      }
    }

    await idbPut(db, 'meta', {
      key: 'index', complete: true, total, perPage, totalPages,
      firstLids, lids: allLids, updatedAt: Date.now(),
    });

    return allLids;
  }

  async function fetchArticleDetail(lid) {
    const url = `${origin}/article/${encodeURIComponent(lid)}`;
    const payload = await fetchLentille(url, `文章 ${lid}`);
    const article = getDetailArticle(payload);

    if (!article || typeof article !== 'object') {
      throw new Error(`文章 ${lid} 的响应中没有 article 对象。`);
    }
    if (typeof article.content !== 'string') {
      throw new Error(`文章 ${lid} 的响应中没有完整 Markdown content。`);
    }
    return article;
  }

  async function crawlDetails(db, lids) {
    const all = await idbGetAll(db, 'articles');
    const recMap = new Map(all.map(x => [x.lid, x]));

    let completed = lids.filter(lid => {
      const r = recMap.get(lid);
      return r?.fetched && typeof r.source === 'string';
    }).length;

    const failures = [];

    for (let i = 0; i < lids.length; i++) {
      assertNotStopped();
      const lid = lids[i];
      const prev = await idbGet(db, 'articles', lid) || {
        lid,
        url: `${origin}/article/${lid}`,
        title: '',
        categoryId: null,
        category: '',
        fetched: false,
      };

      if (prev.fetched && typeof prev.source === 'string') continue;

      ui.set(
        `v1 阶段 2/3：抓取完整 Markdown 源码…\n` +
        `已完成：${completed}/${lids.length}\n` +
        `当前：${lid} (${i + 1}/${lids.length})\n` +
        `请求间隔：至少 ${CONFIG.minRequestIntervalMs / 1000}s + 随机抖动\n` +
        `已完成内容会立即写入 IndexedDB，可断点续传。\n` +
        `网络请求计数：${requestCounter}`
      );

      try {
        const detail = await fetchArticleDetail(lid);
        const categoryId = detail.category ?? prev.categoryId ?? null;
        await idbPut(db, 'articles', {
          ...prev,
          lid,
          url: `${origin}/article/${lid}`,
          title: String(detail.title ?? prev.title ?? ''),
          categoryId,
          category: categoryName(categoryId),
          source: detail.content,
          fetched: true,
          fetchedAt: Date.now(),
          lastError: null,
        });
        completed++;
      } catch (err) {
        if (err?.name === 'UserStoppedError') throw err;
        failures.push({ lid, error: String(err?.message || err) });
        await idbPut(db, 'articles', {
          ...prev,
          lid,
          fetched: false,
          lastError: String(err?.message || err),
          lastErrorAt: Date.now(),
        });
        console.error(`[LuoguArticleList v1] ${lid} 抓取失败`, err);
      }
    }

    return failures;
  }

  async function outputOneJson(db, lids, failures) {
    ui.set('v1 阶段 3/3：整理单个 JSON 并输出到控制台…');

    const all = await idbGetAll(db, 'articles');
    const map = new Map(all.map(x => [x.lid, x]));
    const articles = [];
    const missing = [];

    for (const lid of lids) {
      const rec = map.get(lid);
      if (!rec?.fetched || typeof rec.source !== 'string') {
        missing.push(lid);
        continue;
      }

      articles.push({
        url: `${origin}/article/${lid}`,
        title: String(rec.title ?? ''),
        category: String(rec.category ?? categoryName(rec.categoryId)),
        source: rec.source,
      });
    }

    const result = { articles };
    const jsonText = JSON.stringify(result, null, 2);

    // 方便后续在控制台直接访问/复制。
    window.__LUOGU_ARTICLE_LIST_V1__ = result;
    window.__LUOGU_ARTICLE_LIST_V1_JSON__ = jsonText;
    window.__LUOGU_ARTICLE_LIST_V1_MISSING__ = missing.slice();

    console.log('===== LUOGU ARTICLE LIST v1 JSON START =====');
    console.log(jsonText);
    console.log('===== LUOGU ARTICLE LIST v1 JSON END =====');
    console.info(
      '[LuoguArticleList v1] JSON 已保存到 window.__LUOGU_ARTICLE_LIST_V1_JSON__。\n' +
      'Chrome/Edge DevTools 可执行：copy(window.__LUOGU_ARTICLE_LIST_V1_JSON__)'
    );

    if (missing.length) {
      console.warn('[LuoguArticleList v1] 本次仍未完成的 lid：', missing);
      console.warn('[LuoguArticleList v1] 再运行一次本脚本会跳过已成功文章，只重试未完成文章。');
    }
    if (failures.length) {
      console.warn('[LuoguArticleList v1] 本轮错误：', failures);
    }

    ui.done(
      `v1 完成。\n` +
      `索引文章：${lids.length}\n` +
      `JSON articles 元素：${articles.length}\n` +
      `未完成：${missing.length}\n` +
      `网络请求总计：${requestCounter}\n\n` +
      `完整 JSON 已输出到浏览器控制台。\n` +
      `同时保存在：window.__LUOGU_ARTICLE_LIST_V1_JSON__\n` +
      `复制命令：copy(window.__LUOGU_ARTICLE_LIST_V1_JSON__)`
    );

    return result;
  }

  try {
    const db = await openDB();
    window.__LUOGU_ARTICLE_LIST_V1_DB__ = db;

    const lids = await collectIndex(db);
    assertNotStopped();

    const failures = await crawlDetails(db, lids);
    assertNotStopped();

    await outputOneJson(db, lids, failures);
  } catch (err) {
    if (err?.name === 'UserStoppedError') {
      ui.done(
        'v1 已停止。\n已完成文章保存在 IndexedDB 中。\n' +
        '重新运行同一个 v1 脚本会自动断点续传。'
      );
      console.info('[LuoguArticleList v1] 用户停止，进度已保存。');
    } else {
      ui.done(
        `v1 发生错误：\n${err?.stack || err}\n\n` +
        '已成功抓取的文章仍保存在 IndexedDB，重新运行即可继续。'
      );
      console.error('[LuoguArticleList v1]', err);
    }
  } finally {
    window.__LUOGU_ARTICLE_LIST_V1_RUNNING__ = false;
  }
})();

洛谷用户文章列表导出器 v1

使用方法：
1. 打开 https://www.luogu.com.cn/user/377873/article
2. F12 -> Console / 控制台
3. 打开 luogu_article_list_console_v1.js，复制全部内容到控制台执行
4. 等待抓取完成
5. 最终控制台会输出一个 JSON：
   {
     "articles": [
       {"url":"...","title":"...","category":"...","source":"..."},
       ...
     ]
   }

同时：
- 对象保存在 window.__LUOGU_ARTICLE_LIST_V1__
- JSON 文本保存在 window.__LUOGU_ARTICLE_LIST_V1_JSON__
- Chrome / Edge 控制台可执行：
  copy(window.__LUOGU_ARTICLE_LIST_V1_JSON__)
  直接复制完整 JSON。

限速：
- 严格串行
- 两次网络请求开始时间至少相隔 5.5 秒
- 额外加入 0~0.8 秒随机抖动
- 403 / 429 / 5xx 自动长时间退避
- IndexedDB 断点续传

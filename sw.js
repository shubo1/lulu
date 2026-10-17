// 离线缓存：网页文件存在手机里，先用存着的打开（网站慢或连不上也能开），同时在后台取新版，
// 下次打开就是新版。只缓存本网站的文件；云端（Supabase）的数据从不缓存。
// 改了网页文件，把 VERSION 加一，旧缓存会被清掉。

const VERSION = "v1";
const CACHE = `lulu-${VERSION}`;
const FILES = [
  "./",
  "index.html",
  "app.js",
  "core.js",
  "crypto.js",
  "store.js",
  "style.css",
  "manifest.webmanifest",
  "vendor/noble-hashes/scrypt.js",
  "vendor/noble-hashes/pbkdf2.js",
  "vendor/noble-hashes/sha2.js",
  "vendor/noble-hashes/hmac.js",
  "vendor/noble-hashes/utils.js",
  "vendor/noble-hashes/_md.js",
  "vendor/noble-hashes/_u64.js",
  "static/icon-180.png",
  "static/lulu_stairs.jpg",
  "static/lulu_frame.jpg",
  "static/lulu_hit_pan.jpg",
  "static/lulu_hit_punch.jpg",
  "static/lulu_hug.jpg",
  "static/lulu_sorry.jpg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("lulu-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // 只管本网站的 GET；视频要按字节范围读，交给浏览器自己处理
  if (req.method !== "GET" || url.origin !== location.origin || req.headers.has("range") || url.pathname.endsWith(".mp4")) return;
  event.respondWith(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req, { ignoreSearch: true });
        const fresh = fetch(req).then((resp) => {
          if (resp.ok && resp.type === "basic") cache.put(req, resp.clone()).catch(() => {});
          return resp;
        });
        if (cached) {
          event.waitUntil(fresh.catch(() => {})); // 后台更新，下次打开用新的
          return cached;
        }
        return await fresh;
      } catch {
        return fetch(req); // 缓存出了任何问题，就当没有缓存，直接上网取
      }
    })(),
  );
});

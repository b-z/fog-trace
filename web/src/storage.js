/*
 * storage.js — 浏览器本地存储（IndexedDB 的一个键值表）。所有数据只在这台设备的这个浏览器里。
 *
 *   state          标记状态 { source, updated, edits, points: [...] }（与 tools/deadends.py 的 review.json 同格式）
 *   archive        最近打开的存档 { name, blob, size, saved }（刷新页面后自动打开）
 *   edits:<存档名>  编辑记录 { ops, ptr, exported_ptr, updated }
 *   detcache       检测的窗口缓存（窗口内容没变就不重算）
 */
(function (global) {
  'use strict';
  var DB = 'fog-trace', STORE = 'kv', dbp = null;

  function open() {
    if (!dbp) {
      dbp = new Promise(function (resolve, reject) {
        if (!global.indexedDB) { reject(new Error('浏览器不支持 IndexedDB')); return; }
        var req = indexedDB.open(DB, 1);
        req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IndexedDB 打不开')); };
      });
    }
    return dbp;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onerror = t.onabort = function () { reject(t.error || new Error('IndexedDB 写入失败')); };
      });
    });
  }

  var persisted = false;
  global.FogDB = {
    get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
    set: function (k, v) {
      // 第一次写入时请求「持久存储」，浏览器清理空间时不会删掉标记
      if (!persisted && global.navigator && navigator.storage && navigator.storage.persist) {
        persisted = true; navigator.storage.persist().catch(function () {});
      }
      return tx('readwrite', function (s) { return s.put(v, k); });
    },
    del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }); },
  };
})(typeof window !== 'undefined' ? window : globalThis);

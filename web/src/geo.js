/*
 * geo.js — Web Mercator 坐标 <-> 世界像素 <-> 区块 的纯数学。
 *
 * 关键事实（逆向自 eraser.bundle.js 的编码函数 v()）：
 *   区块就是标准 XYZ 瓦片 zoom=9（512×512），坐标系是 WGS84（真实 GPS，可直接配 OSM）。
 *   blockNo = 512 * yBlock + xBlock。
 *   整个世界在 Web Mercator 下展开为 2^22 × 2^22 像素；
 *   512 个区块 × 每个 8192 像素 = 4,194,304 = 2^22，正好铺满。
 */
(function (global) {
  'use strict';

  var N = 512;                 // 每边区块数 (2^9)
  var BLOCK_PX = 8192;         // 每个区块像素边长
  var WORLD_PX = N * BLOCK_PX; // 4,194,304 = 2^22

  function clampLat(lat) { return Math.max(-85.05112878, Math.min(85.05112878, lat)); }

  // 经纬度 -> 世界像素（原点在左上角，y 向南增大）
  function lngToWorldX(lng) { return (lng + 180) / 360 * WORLD_PX; }
  function latToWorldY(lat) {
    var s = Math.sin(clampLat(lat) * Math.PI / 180);
    var y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return y * WORLD_PX;
  }
  // 世界像素 -> 经纬度
  function worldXToLng(px) { return px / WORLD_PX * 360 - 180; }
  function worldYToLat(py) {
    var n = Math.PI - 2 * Math.PI * py / WORLD_PX;
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  // 一个区块 (x,y) 的地理范围
  function blockBounds(x, y) {
    return {
      west: worldXToLng(x * BLOCK_PX),
      east: worldXToLng((x + 1) * BLOCK_PX),
      north: worldYToLat(y * BLOCK_PX),
      south: worldYToLat((y + 1) * BLOCK_PX),
    };
  }

  // 给定经纬度范围，返回覆盖它的区块坐标列表 [{x,y,blockNo}]。
  // bbox: {minLng,maxLng,minLat,maxLat}
  function blocksForBBox(bbox) {
    var pxLeft = lngToWorldX(bbox.minLng);
    var pxRight = lngToWorldX(bbox.maxLng);
    var pxTop = latToWorldY(bbox.maxLat);   // 北 = y 小
    var pxBottom = latToWorldY(bbox.minLat);
    var x0 = Math.floor(pxLeft / BLOCK_PX);
    var x1 = Math.floor((pxRight - 1e-6) / BLOCK_PX);
    var y0 = Math.floor(pxTop / BLOCK_PX);
    var y1 = Math.floor((pxBottom - 1e-6) / BLOCK_PX);
    var out = [];
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (x < 0 || x >= N || y < 0 || y >= N) continue;
        out.push({ x: x, y: y, blockNo: N * y + x });
      }
    }
    return out;
  }

  // 把 bbox 换算成世界像素矩形（供渲染定位用）
  function bboxToWorldRect(bbox) {
    var left = lngToWorldX(bbox.minLng);
    var right = lngToWorldX(bbox.maxLng);
    var top = latToWorldY(bbox.maxLat);
    var bottom = latToWorldY(bbox.minLat);
    return { left: left, right: right, top: top, bottom: bottom,
             width: right - left, height: bottom - top };
  }

  global.FogGeo = {
    N: N, BLOCK_PX: BLOCK_PX, WORLD_PX: WORLD_PX,
    lngToWorldX: lngToWorldX, latToWorldY: latToWorldY,
    worldXToLng: worldXToLng, worldYToLat: worldYToLat,
    blockBounds: blockBounds, blocksForBBox: blocksForBBox,
    bboxToWorldRect: bboxToWorldRect,
  };
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * fog-layer.js — 把迷雾轨迹做成一个 Leaflet 图层，叠在 OSM 底图之上。
 *
 * 原理：迷雾区块本身就是 zoom=9 的标准 XYZ 瓦片，坐标系 = Web Mercator (EPSG:3857) /
 * WGS84，和 Leaflet 默认 CRS、OSM 底图完全一致。所以我们用一个自定义 L.GridLayer：
 * 对 Leaflet 请求的每一张瓦片 (x, y, z)，算出它对应的「世界像素」矩形，找出覆盖的区块，
 * 把这些区块里落在该瓦片内的「走过像素」画到瓦片 canvas 上。无需任何投影转换。
 *
 * 世界像素总宽 = 2^22；Leaflet 在 zoom z 下整幅世界 = 2^z 张 256px 瓦片。
 * => zoom=9 时一张 256px 瓦片正好对应一个 8192px 区块（8192/32=256）。
 *
 * 数据源二选一：
 *   createFogLayer(archive)                      只读，直接解码 FogDecoder 归档
 *   createFogLayer(null, { source: store })      可编辑，store.getBlock(blockNo) -> Promise<block|null>
 * 编辑后调用 layer.refreshRect([x0,y0,x1,y1])（世界像素）原地重画受影响的瓦片，不闪烁。
 */
(function (global) {
  'use strict';

  function archiveSource(archive) {
    var cache = new Map();
    return {
      getBlock: function (blockNo) {
        var path = archive.pathForBlock(blockNo);
        if (!path) return Promise.resolve(null);
        if (!cache.has(path)) cache.set(path, archive.decodeBlock(path));
        return cache.get(path);
      },
    };
  }

  function createFogLayer(archive, opts) {
    opts = opts || {};
    var G = global.FogGeo;
    var color = opts.color || [80, 220, 140];
    var TILE = 256;
    var source = opts.source || archiveSource(archive);

    function tileRect(coords) {
      var worldPxPerTile = G.WORLD_PX / Math.pow(2, coords.z);
      var left = coords.x * worldPxPerTile, top = coords.y * worldPxPerTile;
      return [left, top, left + worldPxPerTile, top + worldPxPerTile];
    }

    // 把 coords 对应的轨迹画进 canvas。返回 Promise。
    function drawTile(tile, coords) {
      var w = tile.width, h = tile.height;
      var rc = tileRect(coords), left = rc[0], top = rc[1], right = rc[2], bottom = rc[3];
      var scale = (right - left) / w;                       // 每个输出像素 = 多少世界像素
      // zoom ≥ 14 时一个世界像素放大成 q×q 个输出像素，否则会画成稀疏点阵 / 太细看不清
      var q = Math.max(scale <= 1 ? 2 : 1, Math.ceil(1 / scale));
      var bx0 = Math.floor(left / G.BLOCK_PX), bx1 = Math.floor((right - 1e-6) / G.BLOCK_PX);
      var by0 = Math.floor(top / G.BLOCK_PX), by1 = Math.floor((bottom - 1e-6) / G.BLOCK_PX);
      var tasks = [];
      for (var by = by0; by <= by1; by++) {
        for (var bx = bx0; bx <= bx1; bx++) {
          if (bx < 0 || bx >= G.N || by < 0 || by >= G.N) continue;
          tasks.push(source.getBlock(G.N * by + bx).then((function (bx, by) {
            return function (block) { return block ? { block: block, bx: bx, by: by } : null; };
          })(bx, by)));
        }
      }
      return Promise.all(tasks).then(function (blocks) {
        var ctx = tile.getContext('2d');
        var img = ctx.createImageData(w, h), d = img.data;
        blocks.forEach(function (b) {
          if (!b) return;
          var baseX = b.bx * G.BLOCK_PX, baseY = b.by * G.BLOCK_PX;
          b.block.forEachSetPixelInRect(left - baseX, top - baseY, right - baseX, bottom - baseY, function (lx, ly) {
            var ox = ((baseX + lx - left) / scale) | 0, oy = ((baseY + ly - top) / scale) | 0;
            for (var yy = oy; yy < oy + q && yy < h; yy++) {
              for (var xx = ox; xx < ox + q && xx < w; xx++) {
                var p = (yy * w + xx) * 4;
                d[p] = color[0]; d[p + 1] = color[1]; d[p + 2] = color[2]; d[p + 3] = 255;
              }
            }
          });
        });
        ctx.putImageData(img, 0, 0);
      });
    }

    var FogLayer = L.GridLayer.extend({
      createTile: function (coords, done) {
        var tile = document.createElement('canvas');
        var size = this.getTileSize();
        tile.width = size.x;
        tile.height = size.y;
        drawTile(tile, coords).then(function () { done(null, tile); }, function (e) { done(e, tile); });
        return tile;
      },
      // 原地重画与世界像素矩形 rect=[x0,y0,x1,y1] 相交的已加载瓦片
      refreshRect: function (rect) {
        var tiles = this._tiles || {}, jobs = [];
        Object.keys(tiles).forEach(function (k) {
          var t = tiles[k], rc = tileRect(t.coords);
          if (rc[0] < rect[2] && rc[2] > rect[0] && rc[1] < rect[3] && rc[3] > rect[1]) jobs.push(drawTile(t.el, t.coords));
        });
        return Promise.all(jobs);
      },
    });

    return new FogLayer(Object.assign({ tileSize: TILE, noWrap: true }, opts.gridOptions || {}));
  }

  // 计算归档里全部数据的地理范围（Leaflet LatLngBounds），用于 fitBounds。
  function dataBounds(archive) {
    var G = global.FogGeo;
    var xs = [], ys = [];
    archive.entries.forEach(function (e) { if (e.blockNo !== null) { xs.push(e.x); ys.push(e.y); } });
    if (!xs.length) return null;
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var sw = L.latLng(G.worldYToLat((maxY + 1) * G.BLOCK_PX), G.worldXToLng(minX * G.BLOCK_PX));
    var ne = L.latLng(G.worldYToLat(minY * G.BLOCK_PX), G.worldXToLng((maxX + 1) * G.BLOCK_PX));
    return L.latLngBounds(sw, ne);
  }

  global.createFogLayer = createFogLayer;
  global.fogDataBounds = dataBounds;
})(typeof window !== 'undefined' ? window : globalThis);

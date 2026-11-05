/*
 * decoder.js — 世界迷雾 (Fog of World) 存档解码器
 *
 * 存档结构（逆向自公众号「迷雾资料库」系列 + eraser.html 实现，并用真实数据校验）：
 *
 *   世界坐标系：Web Mercator，整个世界展开为 2^22 x 2^22 像素。
 *   分块：512 x 512 个 block，每个 block = 8192 x 8192 像素 (2^22 / 512)。
 *   每个 block 存成 zip 里 Sync/ 下的一个文件。
 *
 *   单个 block 文件 = zlib 压缩 (0x78 0x5E)。解压后：
 *     [0, 32768)                     : 128x128 的 uint16 (小端) 索引头。
 *                                      每格是一个「子瓦片编号」N；0 表示该格无数据。
 *     后续每个非空子瓦片 (按 N)       : 515 字节记录，位于
 *                                        32768 + 515 * (N - 1)
 *                                      其中前 512 字节 = 64x64 位图 (1 bit/像素，
 *                                      1 = 走过)，尾 3 字节为校验/面积/国家码 (忽略)。
 *
 *   => 每个 block = 128x128 子瓦片 × 每个 64x64 像素 = 8192 x 8192。
 *
 * 本文件只做「解码」，不含任何地图/投影/UI 逻辑，方便后续复用。
 */
(function (global) {
  'use strict';

  var BLOCKS_PER_SIDE = 512;      // 世界横竖各 512 个 block
  var BLOCK_PX = 8192;            // 每个 block 的像素边长
  var TILE_INDEX_SIDE = 128;      // 索引头 128x128
  var SUBTILE_PX = 64;            // 每个子瓦片 64x64 像素
  var INDEX_BYTES = TILE_INDEX_SIDE * TILE_INDEX_SIDE * 2; // 32768
  var SUBTILE_BITMAP_BYTES = (SUBTILE_PX * SUBTILE_PX) / 8; // 512
  var SUBTILE_CHECKSUM_BYTES = 3;
  var SUBTILE_RECORD_BYTES = SUBTILE_BITMAP_BYTES + SUBTILE_CHECKSUM_BYTES; // 515

  // 文件名解码：Sync/ 下文件名编码了区块编号。
  // 编码规则（逆向自 eraser.bundle.js 的 v()）：
  //   filename = md5(String(checksum)).slice(0,4)  +  <各位数字用表1编码>  +  <2 位校验用表2编码>
  //   表1 = "olhwjsktri"（数字 0..9 -> 对应字符），表2 = "eizxdwknmo"。
  //   区块编号 blockNo = 512*yBlock + xBlock。
  // 解码：丢掉前 4 位 md5 前缀，丢掉末尾 2 位表2校验，中间用表1逐字符还原成十进制。
  var T1 = 'olhwjsktri';
  function decodeFilename(name) {
    var core = name.split(' ')[0];        // 去掉 macOS 重复副本的 " 2" 后缀
    if (core.length < 7) return null;      // 至少 4(前缀)+1(数字)+2(校验)
    var body = core.slice(4);
    var digits = body.slice(0, body.length - 2);
    var num = '';
    for (var i = 0; i < digits.length; i++) {
      var d = T1.indexOf(digits.charAt(i));
      if (d < 0) return null;             // 非法字符 -> 不是有效区块名
      num += d;
    }
    var blockNo = parseInt(num, 10);
    if (!isFinite(blockNo)) return null;
    var x = blockNo % 512, y = Math.floor(blockNo / 512);
    if (x < 0 || x >= 512 || y < 0 || y >= 512) return null;
    return { blockNo: blockNo, x: x, y: y };
  }

  // 用浏览器原生 DecompressionStream 做 zlib inflate，避免额外依赖 pako。
  async function inflateZlib(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(global.FogI18n ? global.FogI18n.t('e.noDecompress') : 'This browser lacks DecompressionStream: please use a current browser');
    }
    var ds = new DecompressionStream('deflate'); // 'deflate' = zlib 包装 (RFC1950)，匹配 0x78 头
    var stream = new Response(bytes).body.pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // 打开一个 Sync.zip（ArrayBuffer），返回可枚举/解码的归档对象。
  async function open(arrayBuffer) {
    var zip = await JSZip.loadAsync(arrayBuffer);
    var entries = [];
    var byBlockNo = {}; // blockNo -> path
    zip.forEach(function (path, file) {
      // 只取真实 block 文件（跳过目录、隐藏文件；macOS 副本名如 "xxx 2" 保留并归一化）
      if (file.dir) return;
      var name = path.replace(/^.*\//, '');
      if (!name || name.charAt(0) === '.') return;
      var loc = decodeFilename(name);
      var e = {
        path: path, name: name,
        size: file._data ? file._data.uncompressedSize : 0,
        x: loc ? loc.x : null, y: loc ? loc.y : null,
        blockNo: loc ? loc.blockNo : null,
      };
      entries.push(e);
      if (loc && byBlockNo[loc.blockNo] === undefined) byBlockNo[loc.blockNo] = path;
    });

    async function rawBytes(path) {
      return await zip.file(path).async('uint8array');
    }

    // 解码一个 block，返回其 8192x8192 的 fog 数据访问器。
    async function decodeBlock(path) {
      var compressed = await rawBytes(path);
      var data = await inflateZlib(compressed);
      return makeBlock(data);
    }

    return {
      entries: entries,
      byBlockNo: byBlockNo,
      pathForBlock: function (blockNo) { return byBlockNo[blockNo]; },
      rawBytes: rawBytes,
      decodeBlock: decodeBlock,
    };
  }

  // 把解压后的 block 字节包装成一个可查询「像素是否走过」的对象。
  function makeBlock(data) {
    function subtileIndexAt(tx, ty) {
      var i = (tx + ty * TILE_INDEX_SIDE) * 2;
      return data[i] + data[i + 1] * 256; // 小端 uint16
    }

    // 遍历所有走过的像素，回调 (x, y)，坐标范围 [0, 8192)。
    function forEachSetPixel(cb) {
      for (var ty = 0; ty < TILE_INDEX_SIDE; ty++) {
        for (var tx = 0; tx < TILE_INDEX_SIDE; tx++) {
          var n = subtileIndexAt(tx, ty);
          if (!n) continue;
          var base = INDEX_BYTES + SUBTILE_RECORD_BYTES * (n - 1);
          var ox = tx * SUBTILE_PX;
          var oy = ty * SUBTILE_PX;
          for (var by = 0; by < SUBTILE_PX; by++) {
            var rowByte = base + by * (SUBTILE_PX / 8); // 每行 8 字节
            for (var bb = 0; bb < SUBTILE_PX / 8; bb++) {
              var b = data[rowByte + bb];
              if (!b) continue;
              for (var bit = 0; bit < 8; bit++) {
                if (b & (1 << (7 - bit))) {
                  cb(ox + bb * 8 + bit, oy + by);
                }
              }
            }
          }
        }
      }
    }

    // 只遍历落在 [x0,x1)×[y0,y1)（区块内局部坐标）里的走过像素；只扫相关子瓦片，瓦片渲染用。
    function forEachSetPixelInRect(x0, y0, x1, y1, cb) {
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
      x1 = Math.min(BLOCK_PX, Math.ceil(x1)); y1 = Math.min(BLOCK_PX, Math.ceil(y1));
      if (x0 >= x1 || y0 >= y1) return;
      var tx0 = (x0 / SUBTILE_PX) | 0, tx1 = ((x1 - 1) / SUBTILE_PX) | 0;
      var ty0 = (y0 / SUBTILE_PX) | 0, ty1 = ((y1 - 1) / SUBTILE_PX) | 0;
      for (var ty = ty0; ty <= ty1; ty++) {
        for (var tx = tx0; tx <= tx1; tx++) {
          var n = subtileIndexAt(tx, ty);
          if (!n) continue;
          var base = INDEX_BYTES + SUBTILE_RECORD_BYTES * (n - 1);
          var ox = tx * SUBTILE_PX, oy = ty * SUBTILE_PX;
          for (var by = 0; by < SUBTILE_PX; by++) {
            var y = oy + by;
            if (y < y0 || y >= y1) continue;
            var rowByte = base + by * (SUBTILE_PX / 8);
            for (var bb = 0; bb < SUBTILE_PX / 8; bb++) {
              var b = data[rowByte + bb];
              if (!b) continue;
              for (var bit = 0; bit < 8; bit++) {
                if (b & (1 << (7 - bit))) {
                  var x = ox + bb * 8 + bit;
                  if (x >= x0 && x < x1) cb(x, y);
                }
              }
            }
          }
        }
      }
    }

    return {
      width: BLOCK_PX,
      height: BLOCK_PX,
      raw: data,
      subtileIndexAt: subtileIndexAt,
      forEachSetPixel: forEachSetPixel,
      forEachSetPixelInRect: forEachSetPixelInRect,
    };
  }

  global.FogDecoder = {
    open: open,
    decodeFilename: decodeFilename,
    inflateZlib: inflateZlib,
    constants: {
      BLOCKS_PER_SIDE: BLOCKS_PER_SIDE,
      BLOCK_PX: BLOCK_PX,
      TILE_INDEX_SIDE: TILE_INDEX_SIDE,
      SUBTILE_PX: SUBTILE_PX,
      INDEX_BYTES: INDEX_BYTES,
      SUBTILE_RECORD_BYTES: SUBTILE_RECORD_BYTES,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

# Fog Trace · 迷雾轨迹断头复查

在浏览器里打开《世界迷雾》(Fog of World) 的同步存档：自动找出轨迹里断开的地方（断头），逐个复查标记；
顺手擦掉 GPS 飘出去的线、补上缺的路，再导出成 App 能导入的存档。

**在线使用：<https://b-z.github.io/fog-trace/>**

纯静态网页，没有后端。存档只在你自己的浏览器里读取和处理，不会上传；标记和编辑记录也只存在这个浏览器里。

> 非官方工具，与 App 开发者无关。导入改过的存档前，请先备份原来的同步文件夹。

## 怎么用

1. 打开网页，选择 App 的 `Sync` 文件夹，或把它压缩成的 zip（也可以直接拖进页面）。
2. 第一次打开会自动检测断头：整份存档几秒到十几秒，地图上的红点就是待处理的断头。
3. 按置信度从高到低复查：`J` / `K` 上下切换，`X` 不需要处理，`D` 已处理，`U` 撤销。标过的点变成灰点。
4. 需要修的地方用地图上方的工具改：橡皮擦擦掉飘出去的线，画笔补上缺的路。改完点「重新检测」，只重算改过的区域（不到一秒）。
5. 点「导出存档」下载 `Sync-edited-….zip`，再导回 App。导回前先备份原来的存档；想再确认一遍，可以用 `tools/check_export.py` 校验（见下）。

存档在哪里：App 开启同步后，同步目录里的 `Sync` 文件夹就是存档（每个文件是一块地图区域）。
iCloud 同步的 Mac 上在 `~/Library/Mobile Documents/iCloud~com~ollix~FogOfWorld/Documents/Sync`
（文件选择窗口里按 `⌘⇧G` 粘贴路径；还在云端没下载的文件要先在 Finder 里下载）。

## 功能

| 功能 | 说明 |
|---|---|
| 断头检测 | 找出轨迹「突出来、不和别处相连」的地方：起终点、原地掉头、GPS 信号丢失。每处有 0–100 的置信度 |
| 复查 | 按置信度排序；上方分类只筛右侧列表，地图上始终显示全部点（待处理红色，标过的灰色）；「最低分」滑块过滤低分点 |
| 框选 `B` | 拖出矩形，框里看得到的红点一次标成「不需要处理」；已处理的不改，整批 `U` 撤销 |
| 浏览 `V` | 拖动平移，滚轮缩放 |
| 橡皮擦 `E` | 按住拖动擦除；`[` `]` 调大小；按住空格临时拖地图；放大到 12 级以上才能擦 |
| 画笔 `P` | 1px 细线（与轨迹同宽）。单击加点，右键 / 双击 / `Enter` 结束，`Backspace` 删上一个点，`Esc` 取消 |
| 吸附 | 画笔顶点自动接到附近的断头或画过的线的端点（实线圈），其次接到附近的轨迹（虚线圈）；按住 `⌥` 不吸附 |
| 撤销 `⌘Z` / 重做 `⇧⌘Z` | 一次拖擦 / 一条折线为一步 |
| 导出存档 | 只重新编码改过的区块，其余文件逐字节原样保留；整块擦空的区块不写文件（与 App 的做法一致） |

## 断头检测

每个窗口 32×32 个子瓦片（2048×2048 像素）外加 4 个子瓦片的边距，Web Worker 并行处理：

位图 → 膨胀 1px（补栅格缝）→ 骨架化 → 剪掉 < 6px 的毛刺 → 骨架端点 → 打分

**置信度**（0–100）= 三个饱和因子相乘，任何一项小都会把分数压低：

- **突出长度**：端点沿骨架回溯到最近分叉点的长度（很短 ≈ GPS 抖动）；
- **前方空旷**：沿突出方向 ±35° 锥形内，到下一段轨迹的距离（≤3px 说明轨迹其实接着走，只是骨架断了）；
- **离别的轨迹**：端点到「不属于自己这条支线」的轨迹的最近距离（≈1px 说明是粗轨迹带里的假端点）。

**类型**：支线断头（从主线伸出后停住）、孤立线段端点（两头都不连，多为信号丢失）、孤立点。

窗口结果按内容哈希缓存在浏览器里：再次检测（编辑后、或打开新同步的存档）只重算内容变了的窗口。

## 标记会跟着走

所有存档共用一份标记。打开别的存档（新导出的、或更早的）时自动检测，标记按以下规则沿用：

- 新检测到的端点与旧点相距 ≤6px、且突出方向相差 ≤60°，算同一个端点：沿用原来的 ID 和标记，位置和分数更新；
  方向不同的（比如断口两侧相对的两个端头）不会被误合并。
- 标过的点永不删除；当前存档里没检测到的（已修好、或来自别的存档）保留，列表里变淡，卡片注明「没检测到」。
- 待处理的点没再检测到就去掉（多半是修好了）。

「存档与标记」菜单里可以**导出标记**（JSON，备份或换设备）和**导入标记**。浏览器清除网站数据会把标记一起删掉，记得备份。

## 本地运行

需要经 HTTP 打开（Web Worker 不能从 `file://` 加载）：

```bash
python3 -m http.server 8000
```

然后打开 <http://localhost:8000/>。需要较新的 Chrome / Edge / Safari / Firefox（用到 `DecompressionStream`、Web Worker、IndexedDB）。

## 命令行工具（`tools/`）

| 工具 | 用途 |
|---|---|
| `deadends.py` | 断头检测的 Python 参考实现（numpy + scipy + scikit-image），输出的 JSON 可以在网页里「导入标记」 |
| `detect_node.js` | 在 Node 里跑网页版的检测（同一份 `src/detect-core.js`） |
| `compare_raw.py` | 逐条比对两边的检测结果 |
| `check_export.py` | 校验导出的存档：每个区块的格式、未改区块逐字节一致；带 `--ops` 时独立重放编辑记录逐像素比对 |
| `apply_edits.js` | 不开浏览器，把编辑记录套到存档上导出（与网页同一套代码） |
| `store_selftest.js` | 存储层自测：文件名编码、无改动重新编码、真实编辑 |

网页版与 Python 版逐条一致（骨架化的查表、最近像素等距时取哪个，都照搬了 scikit-image / SciPy 的实现）：

```bash
pip install -r tools/requirements.txt
python3 tools/deadends.py Sync.zip --state /tmp/state.json --raw /tmp/py.json   # 约 3 分钟
node tools/detect_node.js Sync.zip --raw /tmp/js.json                           # 约 6 秒
python3 tools/compare_raw.py /tmp/py.json /tmp/js.json
```

## 存档格式

逆向自「迷雾资料库」系列文章，并用真实存档逐字节校验：

- 世界坐标系：Web Mercator，整个世界展开为 2²² × 2²² 像素（相当于 OSM 第 14 级）。
- 分 512 × 512 个区块，每块 8192 × 8192 像素，对应 `Sync/` 下的一个文件。区块编号 = `512 × y + x`，`(x, y)` 就是 XYZ 瓦片第 9 级的坐标。
- 区块文件是 zlib 压缩。解压后前 32768 字节是 128 × 128 的 uint16（小端）索引，每格是子瓦片编号，0 表示空；
  之后每个子瓦片 515 字节：64 × 64 的位图（1 bit/像素，高位在前，1 = 走过）+ 3 字节大端整数 `2 × 走过像素数 + 1`。
- 文件名 = `md5(区块编号)` 的前 4 位 + 编号各位数字按表 `olhwjsktri` 替换 + `编号 % 100` 的两位数字按表 `eizxdwknmo` 替换。

## 代码结构

| 文件 | 内容 |
|---|---|
| `index.html` | 页面：打开存档、复查列表、卡片、检测进度、标记导入导出 |
| `src/decoder.js` | 解码 zip → 区块 |
| `src/geo.js` | 经纬度 ↔ 世界像素 |
| `src/fog-layer.js` | Leaflet 轨迹图层 |
| `src/fog-store.js` | 可编辑存档：擦 / 画、撤销用的差异、区块编码与导出 |
| `src/editor.js` | 地图编辑交互：工具栏、橡皮擦、画笔与吸附、框选 |
| `src/detect-core.js` | 断头检测算法（一个窗口） |
| `src/detect.js` | 分窗口、Worker 池、缓存、去重、标记合并 |
| `src/detect-worker.js` | Web Worker |
| `src/storage.js` | IndexedDB：标记、编辑记录、最近的存档、检测缓存 |
| `vendor/` | Leaflet 1.9.4、JSZip 3.10.1（本地文件，不走 CDN） |

## 底图

底图用 OpenStreetMap 官方瓦片，按 [OSM 瓦片使用政策](https://operations.osmfoundation.org/policies/tiles/) 适合个人和小流量使用。
访问量大的部署请换成别的瓦片服务（改 `index.html` 里的 `BASEMAP`）。轨迹本身的解码、检测和渲染不依赖任何外部服务。

## 致谢

- 存档格式：微信公众号「迷雾资料库」《世界迷雾逆向工程系列》，以及 vicc.wang 的「迷雾橡皮擦」。
- 检测算法中的骨架化与距离变换移植自 [scikit-image](https://scikit-image.org/) 和 [SciPy](https://scipy.org/)（BSD-3-Clause），见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 地图：[Leaflet](https://leafletjs.com/)、© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors。

## 许可

MIT，见 [LICENSE](LICENSE)。

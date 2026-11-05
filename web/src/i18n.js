/*
 * i18n.js — 界面文字（English / 中文 / 日本語）。
 *
 *   FogI18n.t('key', { n: 3 })   取当前语言的文字，{n} 换成参数；缺的语言退回英文
 *   FogI18n.apply(root)          把 data-i18n / data-i18n-html / data-i18n-title / data-i18n-placeholder 填好
 *   FogI18n.set('ja')            记住选择并刷新页面
 * 默认语言：网址里的 ?lang= > 上次的选择 > 浏览器语言（zh* → 中文，ja* → 日本語）> English
 */
(function (global) {
  'use strict';

  var LANGS = ['en', 'zh', 'ja'];
  var NAMES = { en: 'English', zh: '中文', ja: '日本語' };
  var KEY = 'fog-trace-lang';

  // key: [English, 中文, 日本語]
  var D = {
    // 页面
    'doc.title': ['Fog Trace · Dead-end review', '迷雾轨迹 · 断点复查', 'Fog Trace · 途切れチェック'],
    'doc.desc': ['Open your Fog of World archive in the browser: find where tracks break off, review them, erase GPS glitches, fill in missing roads and export the fixed archive. Your data never leaves your device.',
      '在浏览器里打开《世界迷雾》存档：找出轨迹断点、逐个复查、擦掉 GPS 飘线、补上缺的路，导出改好的存档。数据不离开本机。',
      'Fog of World のアーカイブをブラウザで開き、軌跡の途切れを見つけて確認、GPS の飛びを消し、足りない道を描き足して書き出します。データは端末の外に出ません。'],
    'bar.title': ['Dead ends', '断点复查', '途切れチェック'],
    'tab.open': ['To review', '待处理', '未対応'],
    'tab.ignored': ['Ignored', '不需要处理', '対応不要'],
    'tab.done': ['Fixed', '已处理', '対応済み'],
    'tab.all': ['All', '全部', 'すべて'],
    'bar.minScore': ['Min score', '最低分', '最低スコア'],
    'bar.detect': ['Detect', '检测', '検出'],
    'bar.redetect': ['Re-detect', '重新检测', '再検出'],
    'bar.detecting': ['Detecting…', '检测中…', '検出中…'],
    'bar.detectTitle': ['Find dead ends in the current archive (with your edits); windows that did not change reuse the last result',
      '检测当前存档（含编辑）的断点；窗口内容没变的直接用上次的结果',
      '現在のアーカイブ（編集を含む）の途切れを検出します。変わっていない範囲は前回の結果を使います'],
    'bar.menu': ['Archive & marks ▾', '存档与标记 ▾', 'アーカイブとマーク ▾'],
    'menu.open': ['Open another archive…', '打开别的存档…', '別のアーカイブを開く…'],
    'menu.export': ['Export marks (backup / other device)', '导出标记（备份 / 换设备）', 'マークを書き出す（バックアップ・別の端末へ）'],
    'menu.import': ['Import marks…', '导入标记…', 'マークを読み込む…'],
    'bar.sponsor': ['Sponsor', '赞助', '支援'],
    'bar.github': ['Source code on GitHub', 'GitHub 上的源码', 'GitHub のソースコード'],
    'bar.lang': ['Language', '语言', '言語'],

    // 赞助
    'sp.title': ['Support Fog Trace', '支持 Fog Trace', 'Fog Trace を支援する'],
    'sp.text': ['Fog Trace is free and maintained in spare time. If it helped clean up your map, you can support it here. Entirely optional.',
      'Fog Trace 免费使用，在业余时间维护。如果它帮你把地图整理得更干净，欢迎赞助支持。完全自愿。',
      'Fog Trace は無料で、空き時間に保守しています。地図の整理に役立ったら、ここから支援していただけるとうれしいです。支援は任意です。'],
    'sp.github': ['Sponsor on GitHub', '在 GitHub 上赞助', 'GitHub Sponsors で支援'],
    'sp.wechat': ['WeChat reward: scan with WeChat', '微信赞赏：用微信扫一扫', 'WeChat 赞赏コード：WeChat でスキャン'],
    'sp.close': ['Close', '关闭', '閉じる'],

    // 打开存档
    'w.title': ['Open a Fog of World archive', '打开《世界迷雾》存档', 'Fog of World のアーカイブを開く'],
    'w.intro': ['Finds the places where your tracks break off (dead ends) so you can review them one by one. You can also erase GPS glitches, draw in missing roads, and export an archive the app can import.',
      '找出轨迹里断开的地方（断点），逐个复查标记；也能擦掉 GPS 飘出去的线、补上缺的路，再导出成 App 能导入的存档。',
      '軌跡が途切れている場所を見つけ、1 か所ずつ確認できます。GPS の飛びを消したり、足りない道を描き足したりして、アプリに読み込めるアーカイブとして書き出せます。'],
    'w.zip': ['Choose zip / snapshot', '选择 zip / 快照', 'zip / スナップショットを選択'],
    'w.dir': ['Choose Sync folder', '选择 Sync 文件夹', 'Sync フォルダを選択'],
    'w.drop': ['or drop a zip, a snapshot (.fwss) or the Sync folder here', '或者把 zip、快照（.fwss）或 Sync 文件夹拖到这里', 'または zip、スナップショット（.fwss）、Sync フォルダをここにドロップ'],
    'w.where': ['Where is my archive?', '存档在哪里？', 'アーカイブはどこ？'],
    'w.where1': ['With sync turned on, the app keeps your data in a <code>Sync</code> folder (one file per map area). Choose the whole folder, or zip it first.',
      'App 开启同步后，存档是同步目录里的 <code>Sync</code> 文件夹（每个文件是一块地图区域）。整个文件夹选中即可，或者先压缩成 zip。',
      '同期をオンにすると、データは同期先の <code>Sync</code> フォルダに保存されます（1 ファイルが 1 区画）。フォルダごと選ぶか、先に zip にしてください。'],
    'w.where2': ['iCloud on a Mac: <code>~/Library/Mobile Documents/iCloud~com~ollix~FogOfWorld/Documents/Sync</code>. In the file dialog press <kbd>⌘⇧G</kbd> and paste the path. Files still in the cloud (cloud icon) must be downloaded in Finder first.',
      'iCloud 同步的 Mac：<code>~/Library/Mobile Documents/iCloud~com~ollix~FogOfWorld/Documents/Sync</code>。选择窗口里按 <kbd>⌘⇧G</kbd> 粘贴这个路径。文件如果还在云端（图标带云朵），先在 Finder 里下载。',
      'iCloud 同期の Mac：<code>~/Library/Mobile Documents/iCloud~com~ollix~FogOfWorld/Documents/Sync</code>。ファイル選択画面で <kbd>⌘⇧G</kbd> を押してパスを貼り付けます。クラウドにしかないファイル（雲のアイコン）は先に Finder でダウンロードしてください。'],
    'w.where3': ['Dropbox: the <code>Sync</code> folder inside the app\'s Dropbox folder.', 'Dropbox 同步：Dropbox 里 App 的文件夹下的 <code>Sync</code>。', 'Dropbox 同期：Dropbox 内のアプリ用フォルダにある <code>Sync</code>。'],
    'w.where4': ['App snapshots (<code>.fwss</code>) work too: <code>Databases/&lt;name&gt;.fwdb/Snapshots/&lt;year&gt;/&lt;month&gt;/Snapshot-….fwss</code> in the same app folder. Editing a snapshot exports a new <code>.fwss</code>.',
      'App 的快照（<code>.fwss</code>）也可以：在同一个 App 文件夹的 <code>Databases/&lt;名字&gt;.fwdb/Snapshots/&lt;年&gt;/&lt;月&gt;/Snapshot-….fwss</code>。编辑快照后导出的是新的 <code>.fwss</code>。',
      'アプリのスナップショット（<code>.fwss</code>）も開けます：同じアプリフォルダの <code>Databases/&lt;名前&gt;.fwdb/Snapshots/&lt;年&gt;/&lt;月&gt;/Snapshot-….fwss</code>。スナップショットを編集すると新しい <code>.fwss</code> として書き出します。'],
    'w.privacy': ['Your archive is read and processed only in this browser and is never uploaded. Marks and edits are stored in this browser too (export a backup from “Archive & marks”).',
      '存档只在你的浏览器里读取和处理，不会上传到任何地方。标记和编辑记录也只存在这个浏览器里（可在「存档与标记」里导出备份）。',
      'アーカイブはこのブラウザの中だけで読み込み・処理され、どこにもアップロードされません。マークと編集履歴もこのブラウザに保存されます（「アーカイブとマーク」からバックアップを書き出せます）。'],

    // 列表与卡片
    'list.count': ['{n}', '{n} 处', '{n} 件'],
    'list.sort': ['By confidence', '按置信度排序', '信頼度順'],
    'kind.junction': ['Branch end', '支线断点', '枝の行き止まり'],
    'kind.end': ['Loose segment end', '孤立线段端点', '孤立した線の端'],
    'kind.dot': ['Lone dot', '孤立点', '孤立点'],
    'card.noArchive': ['Open an archive first.', '先打开一个存档。', 'まずアーカイブを開いてください。'],
    'card.noResult': ['No results yet: click “Detect” above.', '还没有检测结果：点上方的「检测」。', 'まだ結果がありません。上の「検出」を押してください。'],
    'card.pick': ['Pick one from the list.', '从列表里选一处。', 'リストから選んでください。'],
    'card.allDone': ['Nothing left to review.', '待处理的都处理完了。', '未対応はすべて片付きました。'],
    'card.empty': ['Nothing under this filter.', '这个筛选下没有点。', 'この条件に当てはまる地点はありません。'],
    'card.notInList': ['Not in the current list', '不在当前列表', '現在のリストにはありません'],
    'card.confidence': ['confidence', '置信度', '信頼度'],
    'card.length': ['Sticks out', '突出长度', '突き出た長さ'],
    'card.forward': ['Clear ahead', '前方空旷', '前方の空き'],
    'card.touch': ['To other track', '离别的轨迹', '他の軌跡まで'],
    'card.coords': ['Coordinates', '坐标', '座標'],
    'card.marked': ['Marked', '标记', 'マーク'],
    'card.here': ['This archive', '本存档', 'このアーカイブ'],
    'card.absent': ['Not detected here (fixed, or the mark came from another archive)', '没检测到这个断点（已修好，或标记来自别的存档）', 'ここでは検出されていません（修正済み、または別のアーカイブでのマーク）'],
    'card.ignore': ['Ignore', '不需要处理', '対応不要'],
    'card.done': ['Fixed', '已处理', '対応済み'],
    'card.prev': ['Previous', '上一个', '前へ'],
    'card.reopen': ['Reopen', '恢复待处理', '未対応に戻す'],
    'card.next': ['Next', '下一个', '次へ'],
    'card.gmaps': ['Google Maps', 'Google 地图', 'Google マップ'],
    'card.center': ['Go to point', '回到该点', 'この地点へ'],

    // 标记
    't.reopened': ['Back to “to review”', '已恢复为待处理', '未対応に戻しました'],
    't.marked': ['Marked “{s}” · press U to undo', '已标记为「{s}」 · 按 U 撤销', '「{s}」にしました · U で元に戻す'],
    't.boxUndone': ['Box selection undone: {n} restored', '已撤销框选：{n} 处恢复原状', '範囲選択を取り消しました：{n} 件を元に戻しました'],
    't.saveFail': ['Could not save marks (is local storage blocked?): {e}', '标记保存失败（浏览器不允许本地存储？）：{e}', 'マークを保存できません（ローカル保存がブロックされている？）：{e}'],
    'box.label': ['Box', '框选', '範囲選択'],
    'box.hint': ['Drag a box: red points inside → ignored (U to undo)', '拖出矩形：框里的红点 → 不需要处理（U 撤销）', '四角で囲む：中の赤い点 → 対応不要（U で元に戻す）'],
    'box.count': ['{n} to review in the box', '框内 {n} 处待处理', '範囲内の未対応 {n} 件'],
    'box.none': ['No points to review in the box', '框里没有待处理的点', '範囲内に未対応の地点はありません'],
    'box.done': ['Marked {n} as ignored · press U to undo', '已把 {n} 处标为「不需要处理」 · 按 U 撤销', '{n} 件を「対応不要」にしました · U で元に戻す'],

    // 状态行与检测
    's.noArchive': ['No archive open', '还没打开存档', 'アーカイブを開いていません'],
    's.notDetected': ['{a} · not detected yet', '{a} · 还没检测断点', '{a} · まだ検出していません'],
    's.stale': ['⚠ Marks come from {src}, this is {a}: click “Detect” (marks carry over)', '⚠ 标记来自 {src}，当前是 {a}：点「检测」（标记会自动沿用）', '⚠ マークは {src} のもの、現在は {a}：「検出」を押してください（マークは引き継がれます）'],
    's.detected': ['{a} · detected {d}', '{a} · 检测于 {d}', '{a} · {d} に検出'],
    's.editedSince': [' · edited since, not re-detected', ' · 编辑后还没重新检测', ' · 編集後、未検出'],
    'd.reading': ['Reading all blocks…', '读取全部区块…', 'すべてのブロックを読み込み中…'],
    'd.readingN': ['Reading blocks {i} / {n}', '读取区块 {i} / {n}', 'ブロック読み込み中 {i} / {n}'],
    'd.progress': ['Detecting: {d} / {t} windows · {s} s', '检测断点：{d} / {t} 个窗口 · {s} 秒', '検出中：{d} / {t} 区画 · {s} 秒'],
    'd.reused': [' ({n} unchanged, reused)', '（{n} 个没变，直接沿用）', '（変更なし {n} 区画は前回の結果）'],
    'd.done': ['Detected {n} dead ends · {fresh} new · {gone} fixed · {carried} marks carried over', '检测完成：{n} 处断点 · 新 {fresh} · 修好 {gone} · 沿用标记 {carried}', '検出完了：途切れ {n} 件 · 新規 {fresh} · 修正済み {gone} · マーク引き継ぎ {carried}'],
    'd.missing': [' · {n} marks not found in this archive', ' · {n} 个标记本存档没检测到', ' · このアーカイブにないマーク {n} 件'],
    'd.secs': [' · {s} s', ' · {s} 秒', ' · {s} 秒'],
    'd.failed': ['Detection failed: {e}', '检测失败：{e}', '検出に失敗しました：{e}'],

    // 打开存档
    'o.cloudAll': ['All {n} blocks in this folder are still in iCloud: download them in Finder first', '这个文件夹里的 {n} 个区块都还在 iCloud 云端：先在 Finder 里下载', 'このフォルダの {n} ブロックはまだ iCloud にあります。先に Finder でダウンロードしてください'],
    'o.noBlocks': ['“{f}” has no Fog of World block files', '「{f}」里没有世界迷雾的区块文件', '「{f}」に Fog of World のブロックファイルがありません'],
    'o.cloudSome': ['{n} blocks are still in iCloud and were not read this time', '有 {n} 个区块还在 iCloud 云端没下载，这次没读到它们', '{n} ブロックがまだ iCloud にあり、今回は読み込めませんでした'],
    'o.cantOpen': ['Cannot open this file: {e}', '打不开这个文件：{e}', 'このファイルを開けません：{e}'],
    'o.notArchive': ['This is not a Fog of World sync archive (no block files inside)', '这不是世界迷雾的同步存档（里面没有区块文件）', 'Fog of World の同期アーカイブではありません（ブロックファイルがありません）'],
    'o.noStorage': ['Local storage is blocked, so the archive cannot be switched; reload the page and choose again', '浏览器不允许本地存储，没法切换存档；刷新页面后再选', 'ローカル保存がブロックされているため切り替えられません。ページを再読み込みしてから選んでください'],
    'o.replaying': ['Replaying edits…', '回放编辑记录…', '編集履歴を再生中…'],
    'o.replayed': ['Replayed {n} edits', '已回放 {n} 步编辑', '{n} 件の編集を再生しました'],
    'o.opening': ['Opening {a}…', '打开 {a}…', '{a} を開いています…'],
    'o.lastFailed': ['The last archive cannot be opened: {e}', '上次的存档打不开了：{e}', '前回のアーカイブを開けません：{e}'],
    'o.storageBlocked': ['Local storage is blocked: marks and edits will not be saved this time', '浏览器不允许本地存储：这次的标记和编辑不会保存', 'ローカル保存がブロックされています。今回のマークと編集は保存されません'],

    // 导入导出标记
    'm.exported': ['Exported {n} points ({k} marked)', '已导出 {n} 个点（其中 {k} 个已标记）', '{n} 地点を書き出しました（うちマーク済み {k}）'],
    'm.badJson': ['Not valid JSON: {e}', '不是有效的 JSON：{e}', '有効な JSON ではありません：{e}'],
    'm.badFormat': ['Wrong format: expected { points: [...] } (from “Export marks” or tools/deadends.py)', '格式不对：需要 { points: [...] }（导出标记 / tools/deadends.py 生成的文件）', '形式が違います：{ points: [...] } が必要です（「マークを書き出す」または tools/deadends.py のファイル）'],
    'm.confirm': ['Importing replaces all current marks ({have} marked now, {come} in the file). Continue?', '导入会替换当前的全部标记（现在有 {have} 个已标记的点，文件里有 {come} 个）。继续？', '読み込むと現在のマークはすべて置き換わります（現在 {have} 件、ファイルに {come} 件）。続けますか？'],
    'm.imported': ['Imported {n} points ({k} marked)', '已导入 {n} 个点（{k} 个已标记）', '{n} 地点を読み込みました（マーク済み {k}）'],

    // 编辑工具栏（src/editor.js）
    'e.pan': ['Pan', '浏览', '移動'],
    'e.erase': ['Eraser', '橡皮擦', '消しゴム'],
    'e.pen': ['Pen', '画笔', 'ペン'],
    'e.size': ['Size', '大小', 'サイズ'],
    'e.penHint': ['1px · snaps to ends (hold ⌥ to turn off) · right-click to finish', '1px · 吸附端点（按住 ⌥ 不吸附）· 右键结束', '1px · 端点に吸着（⌥ で解除）· 右クリックで確定'],
    'e.undo': ['Undo (⌘Z)', '撤销 (⌘Z)', '元に戻す (⌘Z)'],
    'e.redo': ['Redo (⇧⌘Z)', '重做 (⇧⌘Z)', 'やり直す (⇧⌘Z)'],
    'e.export': ['Export archive', '导出存档', 'アーカイブを書き出す'],
    'e.exportTitle': ['Download the edited archive as a Sync.zip', '打包改过的存档为 Sync.zip', '編集したアーカイブを Sync.zip としてダウンロード'],
    'e.busy': ['Working…', '处理中…', '処理中…'],
    'e.none': ['No edits', '未编辑', '編集なし'],
    'e.steps': ['{n} edits', '{n} 步编辑', '編集 {n} 件'],
    'e.exported': ['exported', '已导出', '書き出し済み'],
    'e.notExported': ['not exported', '未导出', '未書き出し'],
    'e.zoomIn': ['Zoom in to level {z}+ to erase', '放大到 {z} 级以上才能擦除', 'ズーム {z} 以上で消せます'],
    'e.error': ['Edit failed: {e}', '编辑出错：{e}', '編集エラー：{e}'],
    'e.saveFail': ['Could not save the edit log: {e}', '编辑记录保存失败：{e}', '編集履歴を保存できません：{e}'],
    'e.undone': ['Undone', '已撤销', '元に戻しました'],
    'e.redone': ['Redone', '已重做', 'やり直しました'],
    'e.twoPoints': ['A line needs at least two points', '至少两个点才能成线', '線には 2 点以上必要です'],
    'e.noChange': ['This line did not change any pixel', '这条线没有改变任何像素', 'この線では何も変わりませんでした'],
    'e.packing': ['Packing the archive…', '正在打包存档…', 'アーカイブを作成中…'],
    'e.exportDone': ['Exported {name}: {changed} blocks changed, {created} new, {emptied} emptied and removed, {copied} files kept as they were',
      '已导出 {name}：改动 {changed} 个区块，新增 {created}，擦空删除 {emptied}，原样保留 {copied} 个文件',
      '{name} を書き出しました：変更 {changed} ブロック、新規 {created}、空になり削除 {emptied}、そのまま {copied} ファイル'],
    'e.exportSnap': [' · snapshot: also updated {hash} count blocks and {tilde} zoom-pyramid blocks', ' · 快照：同步更新了 {hash} 个统计区块、{tilde} 个缩放金字塔区块', ' · スナップショット：集計 {hash} ブロック、縮小ピラミッド {tilde} ブロックも更新'],
    'e.noDecompress': ['This browser lacks DecompressionStream: please use a current browser', '浏览器不支持 DecompressionStream，请换用现代浏览器', 'このブラウザは DecompressionStream に対応していません。最新のブラウザをお使いください'],
  };

  function pick() {
    try {   // ?lang=ja 这样的链接：只这一次用，不记住
      var q = new URLSearchParams(global.location.search).get('lang');
      if (LANGS.indexOf(q) >= 0) return q;
    } catch (e) { /* 没有 location（Node）*/ }
    try { var s = global.localStorage && localStorage.getItem(KEY); if (LANGS.indexOf(s) >= 0) return s; } catch (e) { /* 隐私模式等 */ }
    var list = (global.navigator && (navigator.languages || [navigator.language])) || [];
    for (var i = 0; i < list.length; i++) {
      var l = String(list[i] || '').toLowerCase();
      if (l.indexOf('zh') === 0) return 'zh';
      if (l.indexOf('ja') === 0) return 'ja';
      if (l.indexOf('en') === 0) return 'en';
    }
    return 'en';
  }

  var lang = pick(), li = LANGS.indexOf(lang);

  function t(key, p) {
    var e = D[key], s = e ? (e[li] != null ? e[li] : e[0]) : key;
    if (p) s = s.replace(/\{(\w+)\}/g, function (m, k) { return p[k] != null ? p[k] : m; });
    return s;
  }

  function apply(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  }

  function set(l) {
    try { localStorage.setItem(KEY, l); } catch (e) { /* 存不了就只这一次 */ }
    location.reload();
  }

  if (global.document) document.documentElement.lang = { en: 'en', zh: 'zh-CN', ja: 'ja' }[lang];

  global.FogI18n = { t: t, apply: apply, set: set, lang: lang, LANGS: LANGS, NAMES: NAMES, _dict: D };
})(typeof window !== 'undefined' ? window : globalThis);

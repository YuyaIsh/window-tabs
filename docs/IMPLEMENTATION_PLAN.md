# Implementation plan

## 目的

Windows 版を先に日常利用できる状態まで実装し、その後 macOS backend を追加する。

Windows 先行であっても、共通 core / UI に Windows 固有型や挙動を持ち込まない。各フェーズは実装しただけでは完了とせず、必ずレビュー、動作確認、修正ループを通し、`APPROVED` になってから次のフェーズへ進む。

## フェーズ完了ルール

すべてのフェーズで次の順序を固定する。

```text
IMPLEMENT
  ↓
SELF REVIEW
  ↓
AUTOMATED CHECKS
  ↓
BEHAVIOR VERIFICATION
  ↓
SPEC / ARCHITECTURE REVIEW
  ↓
修正が必要 ────────┐
  ↑                 │
  └─────────────────┘
  ↓
FINAL REVIEW
  ↓
APPROVED
```

### `APPROVED` の条件

次をすべて満たした場合だけフェーズを `APPROVED` とする。

- フェーズの acceptance criteria をすべて満たす
- build / typecheck / lint / unit test など、その時点で存在する自動チェックがすべて成功する
- フェーズで追加した主要ユーザーフローを実機で確認する
- 既存の主要ユーザーフローを壊していないことを regression 確認する
- `SPEC.md` と `ARCHITECTURE.md` に反する実装がない
- Windows 固有型、Win32 API、macOS 固有型が共通 core / UI へ漏れていない
- 既知の仕様違反、データ破損、誤接続、操作不能の不具合が残っていない
- レビューで見つかった指摘を修正し、修正後に対象チェックを再実行している

見た目だけの軽微な調整や後続フェーズへ明示的に移した項目は、acceptance criteria に影響しない場合だけ残してよい。その場合は phase review に記録する。

### phase review の記録

各フェーズ完了時に `docs/phase-reviews/PHASE-XX.md` を作り、最低限次を残す。

```text
Status: APPROVED

Implemented
- ...

Automated checks
- command: result

Behavior verification
- scenario: PASS / FAIL

Review findings
- finding
- fix
- re-check result

Deferred
- 後続フェーズへ移した項目

Approval
- acceptance criteria: PASS
- regression: PASS
- architecture boundary: PASS
```

`FAIL` が 1 件でも残る場合は `APPROVED` にしない。

## Phase 0: Windows feasibility spike

### 目的

設計の前提になっている Windows のウィンドウ制御が実際に成立するかを、製品コードを広げる前に確認する。

### 実装 / 検証対象

最小の spike で以下だけを確認する。

1. 2 個以上の外部トップレベルウィンドウを列挙できる
2. 対象ウィンドウを同じ座標・サイズへ配置できる
3. 対象ウィンドウをユーザー操作から前面化できる
4. focus 変更を監視できる
5. 同じ位置へ重ねた複数ウィンドウが Task View / Alt+Tab で個別に扱われる
6. 自作タブバー用ウィンドウを Alt+Tab / Task View から実用上除外できる
7. `Ctrl + 実ウィンドウ D&D` の開始・移動・終了を検出できる
8. D&D 中にドロップ先のトップレベルウィンドウを hit test できる
9. Windows の maximize / restore / Snap 操作後に frame を再取得して追従できる
10. 100% / 125% / 150% など異なる DPI のディスプレイ間で座標変換方針が成立する

### spike の方針

- 最初から低レベルマウスフックへ依存しない
- `SetWinEventHook` の move / size / foreground 系イベントと修飾キー状態から成立するかを先に試す
- 足りない場合だけ限定的な pointer hook を追加検証する
- spike コードは捨ててもよい

### 動作確認

最低限以下を実機で確認する。

- Chrome + Notion
- Chrome の別ウィンドウ 2 個
- Terminal + Chrome
- `Win + Tab` から背後の管理対象ウィンドウを選択
- `Alt + Tab` から管理対象ウィンドウを選択
- Chrome を maximize → restore
- Windows Snap で左右へ配置 → restore
- 外部ディスプレイがある環境ではディスプレイ間移動

### APPROVE 条件

- 上記 1〜10 の成立 / 不成立が明確になっている
- 不成立項目があれば `SPEC.md` または `ARCHITECTURE.md` を先に修正している
- v1 を阻害する未解決の Windows 制約がない
- 次フェーズで採用する Windows API とイベント経路が決まっている

## Phase 1: Cross-platform foundation

### 目的

Windows 実装を進めても macOS 追加時に書き直しにならない境界を作る。

### 実装

- Tauri + React + TypeScript + Rust の基本構成
- `core` / `platform` / UI の依存方向を固定
- OS 非依存の `WindowId`, `WindowInfo`, `TabGroup`, `TabEntry`, `WindowMatchRule`, `NormalizedFrame`
- platform interface
  - window enumeration
  - activate / restore
  - frame get / set
  - focus / move / resize / lifecycle event
  - display enumeration / movement
- Windows backend の skeleton
- macOS backend は未実装でも compile-time boundary を用意
- runtime ID を永続モデルへ保存できない構造
- logging / error model
- unit test の土台

### 自動確認

- Rust build / test
- TypeScript typecheck
- frontend test
- lint / format
- Windows build

### レビュー観点

- `HWND` が core / TypeScript model に出ていない
- Win32 の class name / executable などは platform hint へ閉じている
- UI が Windows API を直接呼んでいない
- macOS backend を追加するための interface に Windows 固有前提がない

### APPROVE 条件

- Windows backend を差し替え可能な形で最小アプリが起動する
- platform mock で core の unit test が可能
- architecture review で OS 境界違反が 0 件

## Phase 2: Windows basic tab groups

### 目的

D&D やプリセットを入れる前に、ウィンドウをタブとして管理する中心機能を完成させる。

### 実装

- Windows のトップレベルウィンドウ列挙
- `+` からの Window Picker
- 2 個以上の実ウィンドウを 1 グループへ追加
- グループ内ウィンドウを同じ frame へ配置
- GUI タブ選択で対象実ウィンドウを前面化
- foreground event から active tab を同期
- 1 タブだけでもタブバーを維持
- 明示的なグループ解除
- 最小化したタブを残し、選択時に restore
- ウィンドウ終了時の runtime 接続解除
- 複数グループの基本管理

### 動作確認

- Chrome + Notion + Terminal を 1 グループで切り替える
- Chrome の 2 ウィンドウを別タブとして扱う
- `+` から同一アプリの別ウィンドウを選択する
- Task View / Alt+Tab / タスクバーから管理対象を前面化すると active tab が同期する
- 3 タブ → 2 タブ → 1 タブに減らしてもバーが残る
- 最小化 → タブ選択で復元
- 対象ウィンドウを閉じても他のグループが壊れない

### APPROVE 条件

- `SPEC.md` のタブ切り替えの中心フローが D&D なしで日常利用できる
- foreground event と自前 activate のイベントループが発生しない
- 複数グループで focus が混線しない

## Phase 3: D&D and group lifecycle

### 目的

マウス操作だけでグループ作成・再編成できる状態にする。

### 実装

- Windows: `Ctrl + 実ウィンドウ D&D`
- ドロップ候補表示
- 非管理ウィンドウ同士のドロップで新規グループ作成
- 既存グループへの実ウィンドウ追加
- タブ D&D による並べ替え
- タブを別グループへ移動
- タブをグループ外へ分離
- タブバー自体の移動
- D&D キャンセル
- Chrome の通常タブ分離では自動グループ化しない

### 動作確認

- Chrome を Notion へ `Ctrl + D&D` して新規グループ化
- Terminal を既存グループへ `Ctrl + D&D`
- タブ順を D&D で変更
- タブを別グループへ移動
- 1 タブまで減らしてから新しいウィンドウを D&D で追加
- `Ctrl` なしの通常ウィンドウ移動では何も起きない
- D&D 中にキャンセルしても元ウィンドウ位置が壊れない

### APPROVE 条件

- `+` と D&D のどちらから追加しても同じ `TabGroup` 状態になる
- D&D 検出が通常のウィンドウ移動を妨害しない
- Chrome の会議ウィンドウなどが勝手に既存グループへ入らない

## Phase 4: Multi-display, geometry, maximize and Snap

### 目的

複数ディスプレイを含む通常の Windows 操作でグループ配置が壊れないようにする。

### 実装

- monitor enumeration
- グループ単位のディスプレイ移動
- タブバーを別ディスプレイへドラッグしたときのグループ追従
- 前 / 次ディスプレイ移動 command
- normalized frame
- DPI / scale factor を考慮した座標変換
- ディスプレイ切断時の primary fallback
- active window の move / resize をグループ frame へ反映
- maximize / restore 追従
- Snap 後の frame 同期
- 自分の `setFrame` が発生させた event の再伝播防止

### 動作確認

- 100% と 125% 以上の DPI が混在する 2 画面間の移動
- 左右 / 上下に配置されたディスプレイ間の移動
- maximize → タブ切り替え → restore
- Snap 左右 → タブ切り替え
- 外部ディスプレイ切断
- active tab をリサイズしたとき他タブも同じ frame へ追従

単一ディスプレイ環境しかない場合、monitor logic の自動テストを先に通し、実機マルチディスプレイ確認は `APPROVED` 前に別環境で必ず実施する。

### APPROVE 条件

- ディスプレイ移動後にタブバーと実ウィンドウが分離しない
- DPI 差による位置ずれが日常操作で発生しない
- maximize / Snap がグループ状態を破壊しない

## Phase 5: Presets and restart reconnection

### 目的

OS / アプリ再起動後も、存在するウィンドウをプリセットへ安全に再接続できるようにする。

### 実装

- preset persistence
- 現在のグループからプリセット保存
- user-defined tab name
- Windows window hints
  - executable
  - window class
  - title pattern
  - 利用可能なら document / path 相当
- matching engine
- `connected` / `unresolved` / `minimized` state
- 候補 0 件 → unresolved
- 候補が一意 → 自動接続
- 候補複数 → 自動確定せず手動選択
- 未起動アプリは起動しない
- 対象ウィンドウが後から作られた場合の再照合
- 一致ウィンドウ 0 件でもプリセット選択時に待機グループと未接続タブを表示
- runtime `HWND` を永続化しない

### matching のテストケース

- アプリ 1 件・候補 1 件
- 同一アプリ複数ウィンドウ・タイトルで一意
- 同一アプリ複数ウィンドウ・同一タイトルで識別不能
- 前回とは HWND が変わっている
- 対象アプリ未起動
- プリセット適用後に対象ウィンドウが起動
- Chrome の window title が利用中に変化

### 動作確認

- プリセット保存 → `window-tabs` 再起動 → 再接続
- PC 再起動 → Windows / 各アプリが復元したウィンドウへ再接続
- 未起動 Notion を含むプリセットを選び、Notion を起動しないことを確認
- その後 Notion を手動起動し、再照合できることを確認
- Claude 等で識別不能な 2 ウィンドウを用意し、誤接続せず手動選択になることを確認

### APPROVE 条件

- 識別不能なウィンドウを推測だけで自動接続しない
- runtime ID が persistence に存在しない
- 0 件 / 1 件 / 複数候補の状態遷移がテストされている
- PC 再起動を含む実機確認が PASS

## Phase 6: Windows v1 hardening

### 目的

Windows 10 / 11 で日常利用できる状態まで edge case を潰す。

### 対象

- Task View
- Alt+Tab
- タスクバーからの選択
- 通知などによる foreground 変更
- sleep / resume
- explorer restart
- display reconnect
- app crash / restart
- `window-tabs` crash / restart
- elevated process など権限差がある対象
- transient / utility / invisible window の除外
- 高頻度 event の debounce / coalescing
- タスクトレイ常駐
- 設定 / ログの確認導線

### regression matrix

最低限、次のアプリ構成で主要フローを通す。

- Chrome + Chrome
- Chrome + Notion
- Chrome + Terminal
- Chrome + Claude
- 3 アプリ以上のグループ
- 2 グループ同時
- 1 タブグループ
- preset unresolved を含むグループ

Windows 10 と Windows 11 の両方で確認する。

### APPROVE 条件

- `SPEC.md` の Windows v1 完了条件をすべて満たす
- Windows 10 / 11 の regression matrix が PASS
- 日常利用を止める既知不具合がない
- Phase 0 で確認した Task View / tab bar host / D&D / Snap の成立条件が製品コードでも維持されている

この Phase の `APPROVED` を Windows v1 完了とする。

## Phase 7: macOS feasibility spike

### 目的

Windows 版の共通 core / UI を維持したまま macOS backend を実装できることを確認する。

### 検証対象

- Accessibility 権限導線
- AXUIElement での window enumeration
- focus / move / resize / create / destroy event
- raise / focus
- frame 操作
- NSPanel 相当のタブバー host
- Mission Control で管理対象ウィンドウが個別表示されること
- Mission Control / Dock から選択した window の active tab 同期
- `Command + 実ウィンドウ D&D`
- NSScreen と複数ディスプレイ

ネイティブ full-screen Space は対象外のままにする。

### APPROVE 条件

- Windows 用 core model / preset schema を変更せず macOS backend を接続できる
- 変更が必要な場合は、Windows 固有前提が core に漏れていた原因を修正してから approve する
- Mission Control、タブバー host、native window D&D の成立が確認できる

## Phase 8: macOS parity

### 目的

Windows v1 の共通仕様を macOS でも使える状態にする。

### 実装

- macOS WindowBackend
- macOS DisplayBackend
- macOS native tab bar host
- `Command + D&D`
- focus sync
- multi-display
- preset matching の macOS hints
  - bundle identifier
  - Accessibility document / identifier など取得可能な属性
- Accessibility permission state / error handling

共通 preset / core / UI は原則変更しない。必要な OS 差は `platformHints` / capabilities で表現する。

### 動作確認

Windows Phase 6 の regression matrix に相当する主要フローを macOS で実施する。

追加で以下を確認する。

- 3 本指上スワイプの Mission Control
- Dock からの window activation
- 複数デスクトップ / Space を通常利用したときに管理対象が壊れない範囲
- Accessibility 権限なし / 付与後

### APPROVE 条件

- Windows の共通挙動を壊さず macOS 版が動作する
- Mission Control から選択した実ウィンドウへタブ状態が同期する
- Windows-only branch が core / UI に追加されていない

## Phase 9: Cross-platform stabilization

### 目的

2 OS 対応後に共通層の回帰と設定互換を確認する。

### 実装 / 検証

- shared core unit tests
- preset schema migration 方針
- platform capability test
- Windows / macOS CI build
- Windows / macOS の smoke test 手順
- error logging の共通化
- docs と実装の最終同期

### APPROVE 条件

- 同じ preset schema を両 OS が読み込める
- OS 固有 hint がない preset でも壊れない
- Windows v1 regression と macOS regression が再度 PASS
- `SPEC.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `IMPLEMENTATION_PLAN.md` が実装と一致している

## レビュー時の優先順位

各フェーズのレビューでは次の順番で確認する。

1. 誤ったウィンドウを操作・接続しないか
2. ユーザーの通常の OS ウィンドウ操作を壊さないか
3. グループ状態と実ウィンドウ状態が不整合にならないか
4. 再起動後に誤接続しないか
5. Windows 固有実装が共通層へ漏れて macOS 実装を阻害していないか
6. event loop / race / stale window reference がないか
7. 見た目と細かな UX

## 実装中に仕様変更が必要になった場合

技術制約で現行仕様が成立しない場合、実装側だけで挙動を変えない。

1. 該当フェーズを `APPROVED` にしない
2. 制約と再現条件を phase review に記録する
3. `SPEC.md` / `ARCHITECTURE.md` / `DECISIONS.md` のどれを変えるべきか整理する
4. 仕様変更を反映する
5. 変更後の acceptance criteria で再レビューする
6. PASS してから次フェーズへ進む

ユーザー判断が必要なのは、既に確定したプロダクト挙動を変える場合だけとする。技術的な実装詳細、テスト追加、内部構造の修正は approve まで自律的に続ける。

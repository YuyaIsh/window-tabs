# Implementation plan

## 目的

Windows 版を先に日常利用できる状態まで作り、その後 macOS backend を追加する。

Windows 先行でも共通 core / UI に Windows 固有型や Win32 の都合を持ち込まない。各フェーズは実装だけでは完了とせず、レビュー、動作確認、修正、再確認まで終えて `APPROVED` になってから次へ進む。

## 進行単位

原則として **1 フェーズ = 1 branch / 1 PR** とする。

```text
main
  └─ phase/00-windows-spike
      └─ review / verify / fix
          └─ APPROVED → merge
              └─ phase/01-foundation
```

- `main` は常に最後に `APPROVED` された状態にする
- 次フェーズは前フェーズの approve / merge 後に開始する
- 仕様変更を含む場合は実装だけ先行させず docs を同じ PR で更新する
- PR の説明には phase review へのリンクを載せる

## フェーズ共通の approve loop

```text
IMPLEMENT
  ↓
IMPLEMENTATION REVIEW
  ↓
AUTOMATED CHECKS
  ↓
BEHAVIOR VERIFICATION
  ↓
ACCEPTANCE / ARCHITECTURE REVIEW
  ↓
findings あり → FIX → affected checks を再実行
  ↓
FINAL REVIEW
  ↓
APPROVED
```

### Implementation review

実装完了後は実装時の判断をそのまま信用せず、base branch との差分を最初から読み直す。

確認対象:

- 変更ファイル全体
- 変更箇所の前後コード
- event / state transition
- error path
- stale window reference
- OS 境界
- test coverage

可能なら実装担当とは別の reviewer agent / review context を使う。別 reviewer を使えない場合でも、実装完了後に diff ベースで独立した review pass を必ず行う。

### Review finding の扱い

- P0: データ破損、誤操作、重大な安全性問題
- P1: 主要フローが成立しない、誤ウィンドウ操作、クラッシュ
- P2: acceptance criteria 違反、再現性のある回帰、OS 境界違反
- P3: acceptance criteria に影響しない軽微な UX / 保守性改善

`APPROVED` には P0 / P1 / P2 が 0 件であることが必要。P3 を後続へ送る場合は phase review の `Deferred` に残す。

### Behavior verification

「コード上は動くはず」では PASS にしない。実際に実行した結果だけを記録する。

OS GUI の確認を自動実行できない環境では、未実行のまま代理で PASS にしない。そのフェーズは `BLOCKED: MANUAL VERIFICATION` とし、必要な確認手順と期待結果を出す。実機結果が得られた後に approve loop を再開する。

ユーザーが明示的に「未実行の確認を残したまま実装を先へ進める」と指示した場合に限り、後続フェーズの実装は開始してよい。この例外は APPROVE ではない。未確認項目と P0〜P2 finding は残したままにし、Windows v1 の最終 APPROVE はすべての実機確認を終えるまで行わない。

### APPROVED 条件

全フェーズ共通で以下を満たす。

- phase acceptance criteria がすべて PASS
- build / typecheck / lint / test など存在する自動チェックがすべて PASS
- 追加した主要フローの動作確認が PASS
- 既存主要フローの regression が PASS
- `SPEC.md` / `ARCHITECTURE.md` / `DECISIONS.md` と矛盾しない
- Windows / macOS 固有型や API が共通 core / UI に漏れていない
- P0 / P1 / P2 finding が 0 件
- finding 修正後に該当チェックを再実行済み

### Phase review の記録

各フェーズで `docs/phase-reviews/PHASE-XX.md` を作る。

```text
Status: APPROVED | BLOCKED | IN_REVIEW

Implemented
- ...

Automated checks
- command: PASS / FAIL

Behavior verification
- scenario: PASS / FAIL / NOT RUN

Review findings
- severity / finding / fix / re-check

Regression
- scenario: PASS / FAIL

Deferred
- ...

Approval
- acceptance criteria: PASS
- regression: PASS
- architecture boundary: PASS
- unresolved P0-P2: 0
```

## Windows v1 architecture update

実装の主設計は、当初の「タブバーを対象 window に追従させる」方式から、`SetParent` / `WS_CHILD` を使う integrated native group host 方式へ更新する。各 group は 1 つの枠なし top-level host を持ち、最上部に React tab strip、その下に active child window を表示する。inactive child は非表示にし、host を閉じる・解除する・アプリを終了する・updater を install する前には parent / style / exstyle / frame / visibility を復元する。host HWNDの作成はTauri main/event-loop threadへdispatchし、作成後に実HWNDのmixed-DPI hosting behaviorを検証する。

この OS 境界をまたぐ mutation は transaction開始時点のnative state / registry ownershipのsnapshot → preflight → `WS_CHILD` style変更 → `SetParent` → size/visibility → registry commit の順に実行する。いずれかが失敗した場合は transaction開始時点へ rollback し、registry に部分的な ownership を commit しない。host / child の DPI context が無効、実HWNDのmixed-DPI hostingが利用不可、または権限境界で操作できない場合は fail closed とする。

## Phase 0: Windows feasibility spike

### Goal

製品コードを広げる前に、Windows 10 上で今回の設計が成立するか確認する。

### Verify

1. 外部トップレベルウィンドウを列挙できる
2. Chrome の複数ウィンドウを別 `HWND` として区別できる
3. 複数ウィンドウを同じ位置・サイズへ移動できる
4. タブクリック相当のユーザー操作から対象を前面化できる
5. foreground / move / resize / create / destroy を監視できる
6. 複数 window を 1 つの integrated group host に組み込み、tab strip と active child を同じ frame に表示できる
7. group host を Task View / Alt+Tab / taskbar の 1 つの通常 window として扱える
8. host 終了時に child の parent / style / exstyle / frame を復元できる
9. native mutation の失敗時に registry と native state を rollback できる
10. `Ctrl + 実ウィンドウ D&D` を検出できる
11. D&D 中に drop target のトップレベルウィンドウを特定できる
12. maximize / restore / Snap 後の frame を追跡できる
13. 実際に生成された host HWND の mixed-DPI hosting behavior 検証と、unsupported window の fail-closed が成立する

### Approach

- 最初から低レベルマウスフックへ依存しない
- `SetWinEventHook` の move / size / foreground 系イベントと modifier state を先に使う
- 不足した場合だけ限定的な pointer hook を検証する
- spike code は製品コードへ無理に流用しない

### Behavior verification

Windows 10 で基本確認する。

- Chrome + Notion
- Chrome の別ウィンドウ 2 個
- Terminal + Chrome
- `Win + Tab` から背後の管理対象を選択
- `Alt + Tab` から管理対象を選択
- group host が taskbar / Alt+Tab / Task View に 1 つだけ出る
- tab click → active child の表示 / focus
- group dissolve / app quit → child restore
- restore failure → quit / updater install が中止され、controllerへエラーが表示される
- SetParent / style / size の失敗を注入または観測し、partial group が残らない
- maximize → restore
- Windows 10: 通常の Snap
- 可能なら DPI の異なる 2 画面間移動

Windows 10 の実機確認を実行できない場合、Phase 0 を `BLOCKED: MANUAL VERIFICATION` にする。

### APPROVE

- 1〜13 の結果と、restore failure時のquit/install gate結果が phase review に記録されている
- Windows 10 の基本検証が PASS
- 不成立項目があれば先に仕様 / architecture を修正している
- v1 を阻害する未解決制約がない
- Windows backend で採用する API / event route が決まっている

## Phase 1: Cross-platform foundation

### Goal

Windows 実装を進めても macOS 追加時に共通部分を書き直さない境界を作る。

### Implement

- Tauri + React + TypeScript + Rust
- `core` / `platform` / UI の依存方向
- OS 非依存 model
  - `WindowId`
  - `WindowInfo`
  - `TabGroup`
  - `TabEntry`
  - `WindowMatchRule`
  - `NormalizedFrame`
- platform interface
  - enumerate
  - activate / restore
  - frame get / set
  - window events
  - display enumerate / move
  - integrated group-host native capability
  - native-window drag events
- Windows backend skeleton
- macOS backend 用 boundary / cfg skeleton
- logging / error model
- test harness / platform mock
- runtime ID を永続化できない persistence model
- 大きな管理画面を常駐させない shell
- Windows task tray の最小入口
  - app quit
  - window picker / new group 入口
  - preset menu の placeholder

macOS 追加時は同じ application shell を menu bar へ接続する。

### Review focus

- `HWND` が共通 model に出ていない
- Win32 class / executable は platform hint に閉じている
- UI が Win32 を直接呼ばない
- persistence が runtime ID を保存できない構造になっている
- interface 名や semantics が Windows の事情に寄りすぎていない
- tray / menu-bar 差分が platform host の差だけで済む

### APPROVE

- Windows backend を差し替えられる最小アプリが起動する
- task tray から最小入口を操作できる
- platform mock で core test が動く
- architecture boundary finding が 0 件

## Phase 2: Windows basic tab groups

### Goal

D&D / preset より先に、タブ管理の中心機能を完成させる。

### Implement

- top-level window enumeration
- `+` Window Picker
- task tray から new group / Window Picker を開く
- window 単位で group へ追加
- integrated group host への組み込み（tab strip + active child）
- child parent / style / frame の snapshot
- GUI tab selection → activate
- group host / active child の foreground event → active tab sync
- 1 tab でも tab bar を維持
- explicit ungroup
- minimized state / restore
- destroyed window handling
- multiple groups

### Behavior verification

- Chrome + Notion + Terminal
- Chrome 2 window を別 tab として追加
- `+` から同一アプリの別 window を選択
- task tray から group 作成
- Task View / Alt+Tab / taskbar から group host を選択 → active tab sync
- 3 → 2 → 1 tab でも bar 維持
- minimize → tab select → restore
- window close 後も他 group が正常

### APPROVE

- D&D なしで中心フローを日常利用できる
- activate と foreground event の loop がない
- multiple groups で focus / state が混線しない

## Phase 3: D&D and group lifecycle

### Goal

実ウィンドウとタブの D&D で group を作成 / 再編成できるようにする。

### Implement

- `Ctrl + 実ウィンドウ D&D`
- drop indicator
- unmanaged window 同士から group 作成
- existing group へ追加
- tab reorder
- tab → other group
- tab → outside で detach
- tab bar move
- cancel
- modifier なしの通常 move は無視
- Chrome tab 分離だけでは自動追加しない
- native group host の mutation は snapshot / rollback 付きで行う

### Behavior verification

- Chrome → Notion へ `Ctrl + D&D`
- Terminal → existing group
- reorder / group move / detach
- 1 tab group へ再追加
- `Ctrl` なし move
- cancel

### APPROVE

- `+` と D&D が同じ `TabGroup` state を作る
- native D&D detection が通常 move を妨害しない
- 一時 window が勝手に group へ入らない

## Phase 4: Multi-display, geometry, maximize and Snap

### Goal

複数ディスプレイと Windows 標準の配置操作を使っても group を維持する。

### Implement

- monitor enumeration
- group display move
- tab bar を別 display へ移動したとき group 追従
- previous / next display command
- normalized frame
- DPI / scale conversion
- mixed-DPI hosting preflight（不可なら fail closed）
- display disconnect fallback
- active window move / resize → group frame sync
- maximize / restore
- Snap frame sync
- self-generated move / resize event の loop guard

### Behavior verification

- DPI 100% + 125% 以上の 2 画面
- 左右 / 上下配置の display
- maximize → tab switch → restore
- Snap → tab switch
- display disconnect / reconnect
- resize propagation
- mixed-DPI の Chrome + Terminal / Notion + Claude

### APPROVE

- display move 後に tab bar と real windows が分離しない
- DPI 差で実用上の位置ずれがない
- maximize / Snap が group state を壊さない

## Phase 5: Presets and restart reconnection

### Goal

runtime ID に依存せず、現在存在する window を安全に preset へ再接続する。

### Implement

- preset persistence
- task tray から preset selection
- preset management screen
- current group → preset
- user-defined tab name
- 保存時に曖昧な tab の matcher を調整できる UI
- Windows matching hints
  - executable
  - window class
  - user-defined / stable title pattern
  - 取得できる document / path 系情報
- matching engine
- `connected` / `unresolved` / `minimized`
- candidate 0 → unresolved
- candidate unique → connect
- multiple ambiguous → manual assignment
- 未起動 app を起動しない
- later-created window の再照合
- 0 connected でも waiting group / unresolved tabs を表示
- `HWND` を永続化しない

現在のウィンドウタイトルを保存時に無条件で matcher 化しない。title pattern はユーザーが明示した条件、または安定性を確認できる属性だけを使う。

空の preset を 0 から編集する高度な UI は v1 後へ送ってよい。v1 では current group から保存する経路を完成させる。

### Test cases

- app 1 / candidate 1
- same app multi-window / unique stable title
- same app multi-window / same title
- changed HWND
- target app not running
- target created after preset apply
- Chrome page title changes
- 保存時タイトルが変わっても誤 matcher が作られない

### Behavior verification

- save → `window-tabs` restart → reconnect
- task tray から preset apply
- PC restart → OS / app が復元した window へ reconnect
- Notion 未起動 preset → Notion を起動しない
- 0 connected preset → waiting tab bar
- 後から Notion 起動 → reconnect candidate
- 識別不能な Claude 2 windows → 誤接続せず manual assignment

### APPROVE

- ambiguous candidate を推測だけで connect しない
- transient な現在タイトルを勝手に matcher として固定しない
- runtime IDs が persistence にない
- 0 / 1 / multiple candidate transition が test 済み
- PC restart を含む実機確認 PASS

## Phase 6: Distribution / Installer / Updater / Windows v1 hardening

### Goal

Windows 10で日常利用できる製品回帰に加え、public GitHub Releaseから通常installし、署名付きupdateをユーザー操作で適用できる状態にする。

### Distribution implementation

- production identifierを初回release前に固定
- `pnpm tauri dev` / `pnpm tauri build` のVite integration
- x86_64 NSIS `setup.exe`（current-user install / shortcut / uninstall）
- GitHub Releasesをinstaller、updater artifact、signature、`latest.json`のsingle sourceにする
- Tauri v2 Updaterをcontrollerだけに接続
- 起動時1回とtray手動check、process内rate limit
- version/notes表示、user-authorized download、install（Windowsの再起動はupdater installerへ委譲）
- failure diagnosticsとGitHub Releases fallback
- updater artifact signing必須、private keyはrelease workflow Secretsだけに注入
- PR CIはrelease signing secretsを扱わずunsigned NSIS smoke
- SemVer/config/tag整合checkとtracked private-key check
- 通常のReleaseは`main` pushだけで開始し、workflowがversionからtagとReleaseをatomic予約し、Tauri actionが同じReleaseへupdater metadataを自動upload
- Release前に既存`v<version>` tagを検出してfail-closedに停止し、同じversionのartifactを上書きしない
- main push gateは既存helperを再利用し、release-impacting changeがなくversionも同じpushは正常skip、release-impacting changeはbaseより新しいstable SemVerを要求し、pre-release versionはproduction channelから拒否する
- 配布binaryに影響するPRはversion bumpをCIで要求し、docs/README/コメントのみの変更は対象外
- 同一commitのmarked draftは再実行可能とし、complete assetならpublish-only、partial assetなら生成assetだけを再構築する。公開直前に公開済みnon-prerelease Releaseの最大SemVerとの順序を検証し、古いrerunでLatestを後退させない。公開済みReleaseは変更しない
- public化前のfull-history secret scan
- 詳細とrelease手順は `docs/DISTRIBUTION.md`

### Harden

- Task View
- Alt+Tab
- taskbar activation
- notification-triggered foreground
- sleep / resume
- Explorer restart
- display reconnect
- target app crash / restart
- `window-tabs` restart
- elevated process / permission mismatch
- transient / utility / invisible window filtering
- event debounce / coalescing
- task tray regression
- log / diagnostic access
- updater install 前の全 group restore
- restore / quit 後に hosted child が通常の top-level window へ戻ること

### Regression matrix

- Chrome + Chrome
- Chrome + Notion
- Chrome + Terminal
- Chrome + Claude
- 3 apps+
- 2 groups simultaneously
- 1-tab group
- unresolved preset group
- 0-connected waiting preset
- grouped windows N → N+1 update の復元・再起動

Windows 10 で実施する。

### Distribution verification

- clean WindowsへNSIS install、installed tray app起動、uninstall
- public Release assetと`latest.json`を未認証download
- version NからN+1を検知し、署名検証後にuser操作でinstall（Windowsの再起動はupdater installerへ委譲）
- install 直前に controller が全 group の child を復元し、updater installer の process exit 後も対象 app が通常 window として残る
- update後もpreset/settings保持
- metadata/network/signature/download/install failureでNが利用可能
- release workflowがNSIS/updater/signature/`latest.json`を再現
- private key/passwordがrepository history、artifact、release、logsにない

これらは実際のpublic ReleaseとWindows実機で観測するまでPASSにしない。code reviewが完了していても未実施なら `BLOCKED: RELEASE VERIFICATION` とする。

### APPROVE

- `SPEC.md` の Windows v1 complete conditions がすべて PASS
- Windows 10 regression PASS
- 日常利用を止める known defect が 0
- Phase 0 で成立確認した integrated group host / Task View / D&D / Snap / rollback / mixed DPI が製品コードでも PASS
- `docs/DISTRIBUTION.md` のrelease acceptanceがすべて実測PASS
- unresolved code-review P0/P1/P2が0

この approve を **Windows v1 APPROVED** とする。

## Phase 7: macOS feasibility spike

### Goal

共通 core / UI / preset schema を維持したまま macOS backend が成立するか確認する。

### Verify

- Accessibility permission flow
- AXUIElement enumeration
- focus / move / resize / create / destroy
- raise / focus
- frame control
- NSPanel 系 tab bar host
- Mission Control で管理対象が個別表示
- Mission Control / Dock selection → active tab sync
- `Command + 実ウィンドウ D&D`
- NSScreen / multi-display
- menu bar shell へ共通 application actions を接続

native full-screen Space は対象外。

### APPROVE

- Windows 用 core / preset schema を壊さず backend を接続できる
- core 変更が必要なら Windows 固有前提を取り除く修正として説明できる
- Mission Control / native tab bar / D&D が成立
- task tray と同じ共通 action を menu bar から呼べる

## Phase 8: macOS parity

### Goal

Windows v1 の共通仕様を macOS へ実装する。

### Implement

- macOS WindowBackend
- DisplayBackend
- native tab bar host
- menu bar host
- `Command + D&D`
- focus sync
- multi-display
- macOS matching hints
  - bundle identifier
  - Accessibility document / identifier 等
- permission / error state

### Behavior verification

Windows の主要 regression に加えて以下を実施する。

- 3 本指上スワイプ Mission Control
- Dock activation
- normal Spaces usage
- Accessibility permission denied / granted
- menu bar から preset / new group / quit

### APPROVE

- Windows 共通挙動を壊さない
- Mission Control selection → active tab sync
- Windows-only branch / type が core / UI に追加されていない

## Phase 9: Cross-platform stabilization

### Goal

2 OS 対応後の shared regression と schema 互換を確認する。

### Verify

- shared core unit tests
- preset schema migration policy
- platform capability tests
- Windows / macOS CI build
- OS ごとの smoke procedure
- logging
- docs sync

### APPROVE

- 同じ preset schema を両 OS が読める
- OS-specific hints がない preset でも壊れない
- Windows v1 regression と macOS regression が再度 PASS
- `SPEC.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `IMPLEMENTATION_PLAN.md` が実装と一致

## Review priority

各 phase の review は次の順で見る。

1. 誤った window を操作 / connect しないか
2. OS 本来の window 操作を壊さないか
3. core state と real window state がずれないか
4. restart 後に誤接続しないか
5. Windows 実装が macOS 追加を阻害していないか
6. event loop / race / stale reference がないか
7. UX / visual details

## 仕様変更が必要になった場合

技術制約で現行仕様が成立しない場合、実装だけで挙動を変えない。

1. phase を `APPROVED` にしない
2. 制約と再現条件を phase review に記録
3. `SPEC.md` / `ARCHITECTURE.md` / `DECISIONS.md` を必要に応じて修正
4. acceptance criteria を更新
5. implementation / tests を修正
6. approve loop を最初から再実行

ユーザー判断が必要なのは、既に確定したプロダクト挙動を変える場合だけとする。内部実装、test、review finding の修正は `APPROVED` になるまで自律的に続ける。

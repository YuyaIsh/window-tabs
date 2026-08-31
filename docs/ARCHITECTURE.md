# Architecture

## 方針

Windows 版を先に実装するが、macOS 追加時に UI・プリセット・グループ管理を書き直さない構成にする。

OS 依存処理は `platform` 配下へ閉じ込め、共通層から `HWND`、`AXUIElement`、`NSScreen` などの OS 固有型を見えないようにする。

## 採用技術

- Tauri
- React + TypeScript
- Rust
- Windows backend: Win32 API
- macOS backend: AppKit + Accessibility API を Rust / native bridge から利用

UI を React / TypeScript で共通化し、ウィンドウ列挙・前面化・移動・イベント監視だけを OS ごとに実装する。

## レイヤー

```text
src/
├─ ui/
│  ├─ tab-bar/
│  ├─ preset-selector/
│  ├─ window-picker/
│  └─ settings/
├─ core/
│  ├─ groups/
│  ├─ presets/
│  ├─ matching/
│  └─ geometry/
└─ platform-client/

src-tauri/
└─ src/
   ├─ core/
   ├─ platform/
   │  ├─ windows/
   │  └─ macos/
   └─ commands/
```

正確なディレクトリ名は実装時に調整してよいが、依存方向は次で固定する。

```text
UI -> Core -> Platform interface
                  ^
                  |
       Windows / macOS backend
```

`core` から特定 OS backend を直接参照しない。

## アプリの常駐形態

大きな管理ウィンドウを常時表示しない。

platform 側で launcher host を持つ。

- Windows: system tray
- macOS: menu bar

launcher からプリセット選択、新規グループ、設定画面を開く。

初期 `main` WebViewは非表示のcontrollerとして、workspace mutation、native event、host lifecycleに加え、updater check/download/installを一意に所有する。secondary group hostはsnapshotを受け取りcommandをcontrollerへ送るだけで、updater pluginを直接呼ばない。

プリセット内の接続済みウィンドウが 0 件でも、保存済み frame に group host の待機 frame を作成できるようにする。

Windows v1 の group は、タブ strip と対象アプリの child window を同じ枠なし native host に持つ。対象アプリの描画プロセスは変えず、`SetParent` と `WS_CHILD` によって host の content 領域へ一時的に組み込む。active child だけを表示し、inactive child は非表示にする。解除・終了・更新前には保存した parent、style、exstyle、frame、visibility を復元する。host の `HWND` は Tauri の main/event-loop thread 上で、`SetThreadDpiHostingBehavior(MIXED)` を有効にした作成区間に生成し、生成後の `GetWindowDpiHostingBehavior` でも実際の host が mixed であることを検証する。

## 共通モデル

### WindowId

```ts
type WindowId = string;
```

runtime 中だけ有効な opaque ID とする。

- Windows backend 内部: `HWND` と対応
- macOS backend 内部: `CGWindowID` / `AXUIElement` と対応

永続化しない。

### WindowInfo

```ts
type WindowInfo = {
  id: WindowId;
  processId: number;
  appId: string;
  appName: string;
  title: string;
  frame: Rect;
  displayId: DisplayId;
  state: "normal" | "minimized" | "maximized" | "unknown";
};
```

`appId` は runtime で対象アプリをまとめるための OS 内識別子として使う。

- Windows: executable identity を backend で正規化した値
- macOS: bundle identifier を基本とする

永続 matcher では OS 固有情報を別フィールドへ保存する。

### TabGroup

```ts
type TabGroup = {
  id: string;
  name?: string;
  presetId?: string;
  tabs: TabEntry[];
  activeTabId?: string;
  displayId: DisplayId;
  frame: NormalizedFrame;
};
```

`activeTabId` は全タブ unresolved の待機グループでは存在しなくてよい。

1 タブになっても `TabGroup` を破棄しない。

### TabEntry

runtime 接続と永続ルールを分離する。

```ts
type TabEntry = {
  id: string;
  name: string;
  rule?: WindowMatchRule;
  runtimeWindowId?: WindowId;
  status: "connected" | "unresolved" | "minimized";
};
```

`runtimeWindowId` は保存しない。

## Platform interface

TypeScript 側へ直接 OS API を露出せず、Tauri command / event を介して能力を提供する。

```ts
interface WindowBackend {
  listWindows(): Promise<WindowInfo[]>;
  getWindow(id: WindowId): Promise<WindowInfo | null>;
  activate(id: WindowId): Promise<void>;
  restore(id: WindowId): Promise<void>;
  getFrame(id: WindowId): Promise<Rect>;
  setFrame(id: WindowId, frame: Rect): Promise<void>;
}
```

イベント:

```ts
type WindowEvent =
  | { type: "created"; window: WindowInfo }
  | { type: "destroyed"; id: WindowId }
  | { type: "focused"; id: WindowId }
  | { type: "moveResizeStart"; id: WindowId }
  | { type: "frameChanged"; id: WindowId; frame: Rect }
  | { type: "moveResizeEnd"; id: WindowId; frame: Rect }
  | { type: "minimized"; id: WindowId }
  | { type: "restored"; id: WindowId };
```

OS ごとの細かいイベント差は backend 内で正規化する。

## Windows backend

主に次を使う。

- `EnumWindows`: トップレベルウィンドウ列挙
- `GetWindowText`: タイトル
- `GetClassName`: window class
- process API: executable 情報
- `GetWindowRect`: frame
- `SetWindowPos`: 位置・サイズ・Z order
- `SetForegroundWindow`: 前面化
- `ShowWindow`: 最小化解除
- `SetParent`: 対象ウィンドウを group host へ組み込み / 復元
- `SetWindowLongW`: `WS_CHILD` と frame style の変更 / 復元
- `SetThreadDpiHostingBehavior(DPI_HOSTING_BEHAVIOR_MIXED)`: mixed-DPI child hosting の明示
- monitor API: ディスプレイ処理
- `SetWinEventHook`: focus、move/size、create、destroy などの監視
- `WindowFromPoint` など: D&D 終了時の対象判定

### 前面化

Windows は任意プロセスからの `SetForegroundWindow` を制限するため、タブクリックなど明示的なユーザー操作から呼ぶ経路を基本にする。

focus イベントを受けた際は、対象ウィンドウを再度 activate せず、`activeTabId` だけ同期する。イベントループを防ぐ。

### 実ウィンドウ D&D

最初から低レベルのグローバルマウスフックへ依存しない。

第一候補は次の流れ。

1. OS の move/size start event を監視する
2. 移動開始時に Ctrl 状態を確認する
3. 移動中は cursor position と管理可能ウィンドウ一覧から drop target を表示する
4. move/size end で cursor 下の対象を確定する
5. target があれば group 化し、なければ通常移動として終了する

この方式で成立しないアプリだけがある場合に、より低レベルな pointer hook を検討する。

### Group host transaction

`SetParent`、window style、size/visibility の変更は 1 回の native transaction として扱う。transaction開始時には、永続的な standalone 用 recovery snapshot とは別に、現在の parent / style / exstyle / frame / visibility と registry ownership を保存し、preflight で host 自身、破棄済み HWND、DPI context、権限境界を検査する。途中の Win32 呼び出しが 1 つでも失敗した場合は、その transaction 開始時点の native state と registry ownership へ戻してからエラーを返す。rollback 自体に失敗した場合は recovery record を残し、終了・更新を進めない。

新しい child は `WS_POPUP` を外して `WS_CHILD` を設定し、frame change を適用してから `SetParent` する。native transaction が成功してからだけ workspace / registry の新しい ownership を公開する。

group host の終了、アプリ終了、Windows updater の install 直前も同じ restore path を使う。updater plugin が installer からプロセスを終了させるため、controller は install command の直前に対象 HWND の復元を完了させ、復元が成功した場合だけ install を呼ぶ。tray quit も復元失敗時は終了せず、controller にエラーを表示する。

### DPI and unsupported windows

host と child の DPI awareness context が有効であること、host の hosting behavior が mixed であることを preflight で確認する。mixed-DPI hosting が使えない OS / window は組み込まず、候補一覧や UI ではエラーとして扱う。権限の異なるプロセスなど `SetParent` が失敗する境界も同じく fail closed とする。

### 最大化 / Snap

通常 frame とは別に window state を取得する。

Windows 10 の標準 Snap や maximize の操作後、最終 frame を group layout へ反映する。

最大化 state 自体を全 tab へ同期する方式と、restore 後に同じ frame を適用する方式は spike で比較して決める。

## macOS backend

後から次で実装する。

- `AXUIElement`: ウィンドウ列挙、位置、サイズ、raise / focus
- `AXObserver`: focus、move、resize、create、destroy の監視
- `CGWindowID`: runtime のウィンドウ対応付け
- `NSScreen`: ディスプレイ
- `NSPanel`: タブバーのホストウィンドウ

macOS では Accessibility 権限を前提とする。

Space / ネイティブ全画面の操作は v1 共通仕様へ入れない。

## Integrated group host window

React で描画する内容は共通にするが、ホストウィンドウの性質は platform 層で調整する。

要求:

- 枠なし
- 最上部に React の tab strip、その下に active child window を置く
- タブ選択で child の表示 / activation を切り替える
- Windows では group host がタスクバー / Alt+Tab / Task View に 1 つの通常ウィンドウとして出る
- host に組み込み中の child window は個別の OS window entry として重複表示しない
- D&D 可能

Windows と macOS で必要な native window flag が違うため、group host の設定を platform abstraction にする。

Windows の host は Tauri の WebView window と Win32 child hosting の境界を platform 層で実装する。macOS は Accessibility / AppKit の制約を踏まえ、host の Task View semantics を別途決める。Web UI の描画と group state は共通のままにする。

## Native window D&D

React 内のタブ D&D と、OS 上の実ウィンドウ D&D を分ける。

### タブ D&D

UI 層だけで処理する。

- 並べ替え
- グループ間移動
- グループ解除

### 実ウィンドウ D&D

platform 層で検出する。

```text
Windows
move/size events + modifier state + hit testing

macOS
global event / AX movement observation + modifier state + hit testing
```

platform 層は共通層へ次のようなイベントだけを渡す。

```ts
type NativeWindowDragEvent =
  | { type: "start"; windowId: WindowId }
  | { type: "move"; windowId: WindowId; point: Point; target?: WindowId }
  | { type: "end"; windowId: WindowId; point: Point; target?: WindowId };
```

## Window matching

プリセット復元は `runtimeWindowId` ではなく `WindowMatchRule` で行う。

```ts
type WindowMatchRule = {
  titlePattern?: string;
  documentHint?: string;
  platformHints: {
    windows?: {
      executable?: string;
      executablePath?: string;
      className?: string;
    };
    macos?: {
      bundleId?: string;
      accessibilityIdentifier?: string;
    };
  };
};
```

Windows と macOS のプリセットファイル形式は共通にできるが、同じタブを両 OS で自動照合できること自体は v1 の要求にしない。各 OS の matcher を同じ entry に保存できる形だけ確保する。

### matching の原則

- 一意性の高い属性から使う
- 位置・列挙順だけでは確定しない
- 候補 0 件: unresolved
- 確実な候補 1 件: 自動接続
- 複数候補: unresolved のまま手動選択

スコアリングを導入する場合でも、一定スコア以上なら必ず自動接続する設計にはしない。候補同士に明確な差がある場合だけ自動確定する。

現在タイトルは候補情報として保存してよいが、その値を自動的に永続 `titlePattern` へ昇格させない。

## プリセット永続化

保存対象:

- preset ID / name
- tab ID / user-defined name
- `WindowMatchRule`
- tab order
- target display hint
- normalized frame

保存しないもの:

- `HWND`
- `AXUIElement`
- `CGWindowID`
- process ID

これらは再起動後に再取得する。

presetはproduction identifier `io.github.yuyaish.window-tabs` に属するWebView application dataのlocal storageへ保存し、installer directoryへ保存しない。同じidentifierを維持するNSIS upgrade/Tauri updateで保持する設計とするが、実際のN→N+1保持はrelease acceptanceで検証する。

## Distribution boundary

Windows bundleはx86_64 NSIS、update sourceはpublic GitHub Releasesの`latest.json`とする。Tauri Updaterのpublic keyはbuild configへ含め、private signing key/passwordはrelease workflowだけへSecretsとして注入する。PR CIはconfig overrideでupdater artifact生成を無効化し、production signing chainから分離する。詳細は `DISTRIBUTION.md` を参照する。

## ディスプレイ識別

ディスプレイ ID も接続変更で変化し得るため、プリセットでは完全な runtime ID だけに依存しない。

候補として次を保持する。

- OS から得られる display identifier
- display name
- primary / built-in / external などのヒント
- 前回の相対配置

一致するディスプレイがなければ primary display へフォールバックする。

## move / resize のイベント競合対策

`window-tabs` 自身が `setFrame` した結果として move / resize イベントが返る。

また、ユーザーが active window をドラッグしている間に他の全 window へ即時伝播すると、操作が重くなる可能性がある。

次を行う。

- 自分が発行した mutation を短時間追跡する
- 連続 frame event を coalesce する
- active window の move/size end では必ず group frame を確定する
- 自分由来の event から再帰的に伝播しない

例:

```ts
type MutationGuard = {
  windowId: WindowId;
  operation: "move" | "resize" | "activate";
  expiresAt: number;
};
```

## セキュリティ / 権限

### Windows

通常ユーザー権限で操作できる範囲を対象にする。権限レベルが異なる管理者プロセスなど、操作できないウィンドウは unsupported として扱う。

### macOS

Accessibility 権限がない場合はウィンドウ制御機能を開始せず、権限付与導線を表示する。

## platform capability

OS 差を無理に共通仕様へ押し込まない。

```ts
type PlatformCapabilities = {
  nativeWindowDrag: boolean;
  focusObservation: boolean;
  displayMove: boolean;
  windowRestoreFromMinimize: boolean;
  nativeWindowState: boolean;
};
```

機能差が出た場合は capability で UI を調整する。

## Windows implementation spike

UI を作り込む前に、独立した小さい検証コードで次を確認する。

1. `EnumWindows` から Chrome などの複数トップレベルウィンドウを安定して列挙できる
2. 2 個以上を 1 つの group host に組み込み、tab strip と child window が同じ frame になる
3. group host がタスクバー / Alt+Tab / Task View で 1 つの通常 window として扱われる
4. host 終了時に child の parent / style / exstyle / frame を復元できる
5. native mutation 失敗時に partial hosting を残さず transaction を rollback できる
6. mixed-DPI hosting を有効化し、無効な DPI context や権限境界は fail closed にできる
7. Ctrl + native window move の start / end と drop target を安定して取得できる
8. maximize / Windows 10 standard Snap 後に group frame を復元できる
9. Windows 10 で上記が成立する

この spike が失敗した項目は、backend 実装で無理に隠さず仕様を修正する。

## 実装順

### Phase 0: Windows spike

- integrated group host / Task View / Alt+Tab
- SetParent / rollback / mixed DPI
- native window D&D
- maximize / Snap

### Phase 1: Windows core

- Tauri shell
- platform interface
- Windows window enumeration
- window activation / frame control
- focus / move / resize events
- 2 ウィンドウを同位置へ重ねてタブ切り替え

### Phase 2: Windows UX

- tray launcher
- タブバー
- `+` picker
- Ctrl + native window D&D
- tab D&D
- 複数グループ
- 1 タブグループ維持
- 複数ディスプレイ

### Phase 3: persistence

- プリセット保存
- matching
- unresolved state
- 0 connected の待機グループ
- 再起動後の再接続

### Phase 4: Windows integration

- Task View / Alt+Tab からの focus 同期
- 最小化 / 復元
- 最大化 / Snap
- ディスプレイ切断
- edge case 修正

### Phase 5: macOS

- macOS backend
- menu bar launcher
- native tab bar host
- native window D&D
- Mission Control / Command+Tab focus 同期
- Accessibility 権限処理

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
│  └─ window-picker/
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
};
```

`appId` は OS ごとに意味が違ってよい。

- Windows: executable identity を backend で正規化した値
- macOS: bundle identifier を基本とする

OS 固有の照合情報は `platformHints` に分離する。

### TabGroup

```ts
type TabGroup = {
  id: string;
  name?: string;
  tabs: TabEntry[];
  activeTabId: string;
  displayId: DisplayId;
  frame: NormalizedFrame;
};
```

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

TypeScript 側へ直接 OS API を露出せず、Tauri command / event を介して次の能力を提供する。

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
  | { type: "moved"; id: WindowId; frame: Rect }
  | { type: "resized"; id: WindowId; frame: Rect }
  | { type: "minimized"; id: WindowId }
  | { type: "restored"; id: WindowId };
```

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
- `MonitorFromWindow` / monitor enumeration: ディスプレイ処理
- `SetWinEventHook`: focus、move、resize、create、destroy などの監視

### 前面化

Windows は任意プロセスからの `SetForegroundWindow` を制限するため、タブクリックなど明示的なユーザー操作から呼ぶ経路を基本にする。

focus イベントを受けた際は、対象ウィンドウを再度 activate せず、`activeTabId` だけ同期する。イベントループを防ぐ。

## macOS backend

後から次で実装する。

- `AXUIElement`: ウィンドウ列挙、位置、サイズ、raise / focus
- `AXObserver`: focus、move、resize、create、destroy の監視
- `CGWindowID`: runtime のウィンドウ対応付け
- `NSScreen`: ディスプレイ
- `NSPanel`: タブバーのホストウィンドウ

macOS では Accessibility 権限を前提とする。

Space / ネイティブ全画面の操作は v1 共通仕様へ入れない。

## タブバーウィンドウ

React で描画する内容は共通にするが、ホストウィンドウの性質は platform 層で調整する。

要求:

- 枠なし
- 対象ウィンドウ上端へ追従
- タブをクリックしても不要にフォーカスを奪わない
- OS 標準のウィンドウ一覧で通常アプリウィンドウとして目立たない
- D&D 可能

Windows と macOS で必要な native window flag が違うため、タブバー用 native host の設定を platform abstraction にする。

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
modifier + global pointer / window movement detection
+ HWND hit testing

macOS
modifier + global event monitoring
+ Accessibility / window hit testing
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
  appKey: string;
  titlePattern?: string;
  documentHint?: string;
  platformHints?: {
    windows?: {
      executable?: string;
      className?: string;
    };
    macos?: {
      bundleId?: string;
      accessibilityIdentifier?: string;
    };
  };
};
```

### matching の原則

- 一意性の高い属性から使う
- 位置・列挙順だけでは確定しない
- 候補 0 件: unresolved
- 確実な候補 1 件: 自動接続
- 複数候補: unresolved のまま手動選択

スコアリングを導入する場合でも、一定スコア以上なら必ず自動接続する設計にはしない。候補同士に明確な差がある場合だけ自動確定する。

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

## ディスプレイ識別

ディスプレイ ID も接続変更で変化し得るため、プリセットでは完全な runtime ID だけに依存しない。

候補として次を保持する。

- OS から得られる display identifier
- display name
- primary / built-in / external などのヒント
- 前回の相対配置

一致するディスプレイがなければ primary display へフォールバックする。

## イベント競合対策

`window-tabs` 自身が `setFrame` した結果として move / resize イベントが返る。

そのため、platform event と user operation を区別する仕組みを持つ。

例:

```ts
type MutationGuard = {
  windowId: WindowId;
  operation: "move" | "resize" | "activate";
  expiresAt: number;
};
```

自分で発生させた直後のイベントから再度全ウィンドウへ同じ操作を伝播しない。

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
};
```

機能差が出た場合は capability で UI を調整する。

## 実装順

### Phase 1: Windows core

- Tauri shell
- platform interface
- Windows window enumeration
- window activation / frame control
- focus / move / resize events
- 2 ウィンドウを同位置へ重ねてタブ切り替え

### Phase 2: Windows UX

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
- 再起動後の再接続

### Phase 4: Windows integration

- Task View / Alt+Tab からの focus 同期
- 最小化 / 復元
- ディスプレイ切断
- edge case 修正

### Phase 5: macOS

- macOS backend
- native tab bar host
- native window D&D
- Mission Control / Command+Tab focus 同期
- Accessibility 権限処理

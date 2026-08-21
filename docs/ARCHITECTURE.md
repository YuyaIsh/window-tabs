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

プリセット内の接続済みウィンドウが 0 件でも、保存済み frame にタブバーだけを作成できるようにする。

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

### 最大化 / Snap

通常 frame とは別に window state を取得する。

Windows 11 Snap Layouts や maximize の操作後、最終 frame を group layout へ反映する。

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

## タブバーウィンドウ

React で描画する内容は共通にするが、ホストウィンドウの性質は platform 層で調整する。

要求:

- 枠なし
- 対象ウィンドウ上端へ追従
- タブをクリックしても不要にフォーカスを残さない
- タスクバー / Alt+Tab / Task View / Mission Control の通常ウィンドウとして出さない
- D&D 可能

Windows と macOS で必要な native window flag が違うため、タブバー用 native host の設定を platform abstraction にする。

この要求が通常の Tauri window 設定だけで満たせない場合は、Web UI の描画は共通のまま native host だけ platform 固有実装にする。

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
2. 2 個以上を同一 frame に置いても Task View に個別表示される
3. Task View / Alt+Tab から前面化された HWND を `SetWinEventHook` で検知できる
4. タブバー host をタスクバー / Alt+Tab / Task View から除外できる
5. タブバー操作後に対象ウィンドウへ自然に focus を戻せる
6. Ctrl + native window move の start / end と drop target を安定して取得できる
7. maximize / Snap Layouts 後に group frame を復元できる
8. Windows 10 / 11 で上記が成立する

この spike が失敗した項目は、backend 実装で無理に隠さず仕様を修正する。

## 実装順

### Phase 0: Windows spike

- Task View / Alt+Tab
- tab bar host
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

# Design decisions

## D-001: Windows を先に実装し、macOS を後から追加する

**Status:** Accepted

Windows 側で先に日常利用できる状態を作る。

ただし、Windows 専用アプリとして設計しない。共通ロジックと OS 依存処理を最初から分ける。

## D-002: UI / core は共通化し、OS 依存のウィンドウ操作だけ backend 化する

**Status:** Accepted

共通:

- タブバー UI
- グループ管理
- プリセット
- matching
- タブ D&D
- 永続化
- normalized frame

OS 依存:

- 実ウィンドウ列挙
- 前面化
- move / resize
- focus / create / destroy 監視
- 実ウィンドウ D&D
- ディスプレイ API
- タブバー native host の window flag
- tray / menu bar の host

## D-003: Tauri + React / TypeScript + Rust を採用する

**Status:** Accepted

Windows だけなら別の選択肢もあるが、後から macOS を追加するときに UI・状態管理・プリセットを二重実装しないことを優先する。

通常の Tauri window だけでタブバー要件を満たせない場合は、描画 UI は共通のまま native host 部分だけ OS 固有にする。

## D-004: 実ウィンドウは埋め込まない

**Status:** Accepted

別アプリのウィンドウを `window-tabs` の子ウィンドウとして取り込まない。

対象ウィンドウは OS 上の通常ウィンドウのまま保持し、位置・サイズ・Z order を制御する。

## D-005: 非選択ウィンドウは画面外へ退避させない

**Status:** Accepted

グループ内の全ウィンドウを同じ位置・サイズに置き、選択中だけ前面へ出す。

Task View / Mission Control では各実ウィンドウを個別に表示し、そこで選ばれたウィンドウを対応タブへ同期する。

この挙動は Windows の spike で先に成立確認する。

## D-006: グループ作成は修飾キー + 実ウィンドウ D&D を基本操作にする

**Status:** Accepted

- Windows: Ctrl
- macOS: Command

`+` からのウィンドウ選択も常に用意する。

Windows では最初から低レベルマウスフックへ依存せず、move/size start/end と modifier state、hit testing で成立するか先に試す。

## D-007: 新しく作られた同一アプリのウィンドウを自動追加しない

**Status:** Accepted

Chrome のタブ分離、会議ウィンドウ、一時ウィンドウなどが意図せず既存グループへ入ることを防ぐ。

プリセットの unresolved tab に明確に一致する場合の再接続は別扱いとする。

## D-008: 1 タブだけになってもタブバーを残す

**Status:** Accepted

1 タブでもグループを維持する。

理由:

- グループ管理中であることが分かる
- D&D の受け口を維持できる
- プリセット / グループ名を表示できる
- ディスプレイ移動などグループ操作を維持できる

完全解除は明示的な「グループ解除」で行う。

## D-009: プリセット適用時に未起動アプリを起動しない

**Status:** Accepted

現在存在するウィンドウだけを再接続する。

未接続タブは残し、対象ウィンドウが後から作られた場合に再照合する。

OS / アプリ自身のセッション復元を利用し、`window-tabs` がアプリ起動やセッション再生成まで担当しない。

## D-010: プリセット上のタブ名と実ウィンドウタイトルを分離する

**Status:** Accepted

ユーザーが `AIチャット`、`開発Chrome` などの安定した名前を付けられるようにする。

実ウィンドウタイトルは matching の材料として扱うだけで、タブ表示名の永続 ID として扱わない。

現在タイトルを保存しただけで、自動的に永続 `titlePattern` として使わない。

## D-011: 再起動後は runtime window ID を復元しない

**Status:** Accepted

Windows の HWND、macOS の runtime window reference は永続化しない。

アプリ識別子、window class、bundle identifier、document、title pattern などを使って再接続する。

## D-012: 識別不能な複数候補を推測で接続しない

**Status:** Accepted

同一アプリ・同一タイトルなど、外部から区別する材料がない場合は unresolved とし、ユーザーが手動で割り当てる。

前回位置や列挙順は補助情報には使えるが、それだけで自動確定しない。

## D-013: プリセットの未接続タブは UI 上に残す

**Status:** Accepted

見つからなかったウィンドウを黙って省略せず、未接続状態として表示する。

ユーザーはそこから手動割り当てできる。

## D-014: ディスプレイ間移動を v1 に含める

**Status:** Accepted

タブバーの D&D またはショートカットでグループ全体を別ディスプレイへ移す。

frame はディスプレイ作業領域に対する割合で保存する。

## D-015: 複数グループを許可する

**Status:** Accepted

同時に複数の独立したタブグループを作れるようにする。

例:

```text
開発: Chrome / Claude / Terminal
会議: Chrome Meet / Slack
```

## D-016: OS 標準のウィンドウ切り替えを置き換えない

**Status:** Accepted

Task View、Alt+Tab、Mission Control、Command+Tab などは残す。

管理対象ウィンドウが OS 標準操作で選択された場合に、`window-tabs` 側の active tab を同期する。

## D-017: macOS ネイティブ全画面 Space は v1 の対象外

**Status:** Accepted

まず通常ウィンドウ / 最大化相当の操作で安定させる。

macOS の full-screen Space 制御は platform 固有の追加機能として後から検討する。

## D-018: 公開前提にはしない

**Status:** Accepted

当面は個人利用を優先する。

署名、インストーラ、ストア配布、公開向け onboarding、互換性保証は v1 完了条件へ入れない。

ただし macOS ではローカル利用でも Accessibility 権限の扱いを明示する。

## D-019: 何も接続されていないプリセットでも待機グループを作れる

**Status:** Accepted

プリセット選択時に一致する実ウィンドウが 0 件でも、保存済み位置へ細いタブバーを表示する。

全タブを unresolved として保持し、対象ウィンドウが後から作られたら再照合する。

このため `TabGroup.activeTabId` は runtime 上で未設定を許可する。

## D-020: 本実装前に Windows 固有の成立条件を spike で確認する

**Status:** Accepted

UI を作り込む前に次を確認する。

- Task View に重なった管理対象ウィンドウが個別表示される
- Task View / Alt+Tab からの focus を検知できる
- タブバー host をタスクバー / Alt+Tab / Task View から除外できる
- Ctrl + 実ウィンドウ D&D を安定して検知できる
- 最大化 / Snap Layouts と frame 同期が共存できる
- Windows 10 で基本挙動が成立する

失敗した項目は無理に実装で隠さず、先に仕様を修正する。

## D-021: Windows の最大化 / Snap を壊さない

**Status:** Accepted

Windows の通常操作として maximize / Snap Layouts を使った後でもグループを維持する。

最大化 state そのものを他タブへ同期するか、最終 frame だけを同期するかは spike の結果で決める。

## D-022: Windows v1 の対象 OS は Windows 10 に限定する

**Status:** Accepted

v1 の実機検証と回帰対象は Windows 10 とする。Windows 11 と Snap Layouts は将来の互換性確認として扱い、Windows v1 の承認条件には含めない。

## D-023: 明示指示があれば未確認の phase を残して実装を継続できる

**Status:** Accepted

実機 GUI の未確認項目は PASS と扱わず、phase review に残す。ただしユーザーが明示的に継続を指示した場合は後続実装を開始できる。Windows v1 の最終 APPROVE は保留し、未確認項目をすべて実施するまで完了とは扱わない。

## 後から決めてよい事項

次は実装を止める判断ではない。Windows の試作結果を見て決める。

- タブバーの高さ、角丸、色などの見た目
- タブ切り替えショートカットの最終キー
- プリセットの空編集 UI を v1 に入れるか
- title pattern の UI を単純な部分一致にするか、正規表現まで露出するか
- グループ全体のディスプレイ移動ショートカット
- minimized tab の表示方法
- Windows maximize state の同期方法
- macOS の Space 対応をどこまで追加するか

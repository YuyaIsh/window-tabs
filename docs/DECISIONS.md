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

## D-018: 個人利用を優先するが、repository は public 運用にする

**Status:** Accepted

当面のプロダクト判断は自分が日常利用しやすいことを優先し、公開ユーザー向けの広い互換性保証やサポート体制は v1 の目的にしない。

一方、`window-tabs` 自体には秘密情報や個人データを含める必要がないため、repository は public 運用とする。

public repository にすることで、GitHub Releases の installer / updater metadata / updater artifact を認証なしで取得できる構成を採用する。

repository に秘密鍵、token、個人設定、ローカルパスなどの秘密情報は commit しない。

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
- Windows 10 / 11 の両方で基本挙動が成立する

失敗した項目は無理に実装で隠さず、先に仕様を修正する。

## D-021: Windows の最大化 / Snap を壊さない

**Status:** Accepted

Windows の通常操作として maximize / Snap Layouts を使った後でもグループを維持する。

最大化 state そのものを他タブへ同期するか、最終 frame だけを同期するかは spike の結果で決める。

## D-022: Windows v1 に installer と in-app updater を含める

**Status:** Accepted

Windows v1 は開発環境から起動できるだけでは完了としない。

正式な導入方法は Tauri の NSIS `setup.exe` とし、初回インストール後は Tauri Updater からアプリ内更新できる状態を v1 の完了条件に含める。

更新フローはユーザー操作で開始し、勝手にアプリを再起動しない。

プリセットや設定は installer directory と分離し、更新・再インストールで失われないようにする。

## D-023: GitHub Releases を配布・Updater の単一基盤にする

**Status:** Accepted

自前の update server や配布専用 repository は持たない。

public な `YuyaIsh/window-tabs` の GitHub Releases を正式な配布先とし、次を同じ release へ置く。

- NSIS installer
- updater artifact
- updater signature
- `latest.json`

release workflow は GitHub Actions + `tauri-action` を使って定型化する。

Updater の private signing key は GitHub Actions Secrets と安全な別バックアップで管理し、repository には含めない。

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

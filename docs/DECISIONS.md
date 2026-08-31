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

**Status:** Superseded by D-028

対象アプリの描画を Web 化・再実装しない、という意味では維持する。ただし Windows v1 では、描画プロセスを変えずに `SetParent` と `WS_CHILD` で group host へ一時的に組み込む。

グループ解除・終了・更新前には元の parent、style、exstyle、frame を復元する。

## D-005: 非選択ウィンドウは画面外へ退避させない

**Status:** Superseded by D-028

group host 内では active child だけを表示し、非選択 child は非表示にする。画面外への退避や最小化で状態を隠す方式は採用しない。

Windows の Task View / Alt+Tab / taskbar では group host を 1 つの作業単位として表示し、active tab と同期する。

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

**Status:** Superseded by D-028

Task View、Alt+Tab、Mission Control、Command+Tab などは残す。

Windows では group host を OS 標準操作の 1 つの選択単位として残し、選択された group host と active tab を同期する。組み込み中の child を個別の OS window として残すことは要求しない。

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

プリセット選択時に一致する実ウィンドウが 0 件でも、保存済み位置へ group host の待機 frame を表示する。

全タブを unresolved として保持し、対象ウィンドウが後から作られたら再照合する。

このため `TabGroup.activeTabId` は runtime 上で未設定を許可する。

## D-020: 本実装前に Windows 固有の成立条件を spike で確認する

**Status:** Superseded by D-028

UI を作り込む前に次を確認する。

- 複数ウィンドウを group host に組み込める
- group host をタスクバー / Alt+Tab / Task View の 1 つの通常 window として扱える
- host 終了時の child restore と native transaction rollback が成立する
- mixed-DPI hosting と unsupported window の fail-closed が成立する
- Ctrl + 実ウィンドウ D&D を安定して検知できる
- 最大化 / Windows 10 の標準 Snap と frame 同期が共存できる
- Windows 10 で基本挙動が成立する

失敗した項目は無理に実装で隠さず、先に仕様を修正する。

## D-021: Windows の最大化 / Snap を壊さない

**Status:** Accepted

Windows 10 の通常操作として maximize / standard Snap を使った後でもグループを維持する。

最大化 state そのものを他タブへ同期するか、最終 frame だけを同期するかは spike の結果で決める。

## D-022: Windows v1 の対象 OS は Windows 10 に限定する

**Status:** Accepted

v1 の実機検証と回帰対象は Windows 10 とする。Windows 11 と Snap Layouts は将来の互換性確認として扱い、Windows v1 の承認条件には含めない。

## D-023: 明示指示があれば未確認の phase を残して実装を継続できる

**Status:** Accepted

実機 GUI の未確認項目は PASS と扱わず、phase review に残す。ただしユーザーが明示的に継続を指示した場合は後続実装を開始できる。Windows v1 の最終 APPROVE は保留し、未確認項目をすべて実施するまで完了とは扱わない。

## D-024: distribution のため repository を public 化する

**Status:** Accepted

D-018 の個人利用優先は維持するが、「公開前提にはしない」という配布部分を supersede する。Phase 6 implementation のreviewと履歴secret scanが完了した後、`YuyaIsh/window-tabs` をpublic化し、認証不要のinstaller/updater配布を可能にする。licenseは別の明示判断であり、本decisionだけでは追加しない。

public化はbranch変更ではなくrepository-wide operationなので、implementation PR内では実行しない。

## D-025: Windows v1 は NSIS installer と Tauri v2 Updater を含む

**Status:** Accepted

Windows v1の正式な初回導線をx86_64 NSIS `setup.exe`、更新導線を署名必須のTauri v2 Updaterとする。起動時に1回確認し、手動確認も提供する。downloadとinstallはユーザーの明示操作後だけ行う。Windowsではupdaterがinstallerを起動するとアプリプロセスを終了し、installerが更新後の再起動を扱うため、frontendからのprocess-plugin再起動は使わない。Microsoft StoreとWindows Authenticode証明書購入はv1の必須条件にしない。

## D-026: GitHub Releases を単一の配布・更新sourceにする

**Status:** Accepted

installer、updater artifact、signature、`latest.json` はpublic GitHub Releasesから配布し、自前update serverや配布専用repositoryは持たない。アプリにはPATやGitHub tokenを埋め込まない。release workflowはGitHub提供の短命な`GITHUB_TOKEN`をleast privilegeで使う。

## D-027: production identifier を固定する

**Status:** Accepted

初回public release前のproduction identifierを `io.github.yuyaish.window-tabs` とする。公開release後はinstaller identityとWebView/application dataの継続性を守るため、migration planなしに変更しない。pre-releaseの `local.window-tabs` に属するlocal dataは自動migration対象外とする。

## D-028: Windows v1 は integrated native group host を採用する

**Status:** Accepted

Windows v1 では、各グループに 1 つの枠なし top-level native host を作る。React の tab strip と、対象アプリの active child window を同じ host frame に配置し、inactive child は非表示にする。`+`、tab D&D、グループ間移動、グループ解除は同じ `TabGroup` state と native host lifecycle に接続する。

host へ組み込む前の対象は通常の top-level window として列挙する。host HWNDはTauriの実際のnative window作成threadでmixed-DPI hostingを有効化した区間に生成し、生成後のHWND behaviorも検証する。組み込み時は host / child の DPI context と権限を preflight し、mixed-DPI hosting を有効化できない、または `SetParent` / style / size の変更が失敗する場合は組み込まない。styleは `WS_POPUP` を外して `WS_CHILD` を設定してから `SetParent` する。native mutation は transaction開始時点のnative state / registry ownership snapshotとrollback付きで実行し、全操作が成功した後だけ registry ownership を commit する。

group host の終了、アプリ終了、Windows updater の install 直前には child を元の parent、style、exstyle、frame、visibility へ復元する。復元に失敗した場合はtray quit / updater installを進めず、controllerへエラーを表示する。これにより、通常利用時は 1 group = 1 OS window の分かりやすい挙動を保ちつつ、外部アプリの描画とプロセスは維持する。

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

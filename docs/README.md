# window-tabs docs

`window-tabs` は、既存のデスクトップアプリのウィンドウをウィンドウ単位でグループ化し、共通のタブバーから切り替えるためのデスクトップアプリ。

Windows を先に実装するが、macOS を後から追加できる構成を前提にする。

運用方針として repository は public にし、初回導入は GitHub Releases の Windows installer、以後の更新は Tauri Updater から行う。自前の update server や配布専用 repository は持たない。実際の public 化は Phase 6 で repository history の秘密情報チェックを通してから行う。

## Documents

- [SPEC.md](./SPEC.md): ユーザー操作、タブグループ、プリセット、復元、マルチディスプレイの仕様
- [ARCHITECTURE.md](./ARCHITECTURE.md): 共通層と OS 依存層の分離、Windows / macOS backend の境界
- [DECISIONS.md](./DECISIONS.md): 現時点で確定した設計判断、採用しない方針、未確定事項
- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md): フェーズ分け、各フェーズのレビュー・動作確認・APPROVE 条件
- [DISTRIBUTION.md](./DISTRIBUTION.md): public GitHub Releases、Windows installer、Tauri Updater、更新署名と release pipeline
- [PLAN_REVIEW.md](./PLAN_REVIEW.md): 実装プラン自体のレビュー履歴と最終 APPROVE
- `phase-reviews/`: 実装開始後に各フェーズの検証・レビュー・承認結果を保存する

## 開発順

1. Phase 0: Windows 10 / 11 の技術 spike で Task View、タブバー host、実ウィンドウ D&D、最大化 / Snap の成立を確認する
2. Phase 1: 共通モデル、platform interface、task tray shell を作る
3. Phase 2: Windows の基本タブグループを作る
4. Phase 3: 実ウィンドウ D&D とタブ D&D を追加する
5. Phase 4: 複数ディスプレイ、DPI、maximize / Snap を固める
6. Phase 5: プリセット、matching、再起動後の再接続を作る
7. Phase 6: Windows 10 / 11 の regression に加え、public 化、installer、Updater、N→N+1 更新、upgrade persistence を確認して Windows v1 を APPROVE する
8. Phase 7: macOS の技術 spike を行う
9. Phase 8: macOS 版を Windows v1 と同じ共通仕様へ揃える
10. Phase 9: 2 OS の共通 regression、schema 互換、release pipeline を確認する

各 Phase は `IMPLEMENTATION_PLAN.md` の approve loop に従い、レビュー・実機動作確認・修正・再確認を通して `APPROVED` になるまで次へ進まない。

`DISTRIBUTION.md` の Windows acceptance criteria は Phase 6 の必須条件として扱う。

## v1 の対象

- Windows 10 / 11
- タスクトレイ常駐
- 複数の既存ウィンドウを同じ位置・サイズに重ねる
- GUI タブからウィンドウ単位で切り替える
- `Ctrl + ウィンドウ D&D` でグループ化する
- タブ D&D で並べ替え、グループ間移動、グループ解除を行う
- 1 タブでもグループとタブバーを維持する
- 複数グループを同時に管理する
- グループを別ディスプレイへ移動する
- プリセットを保存し、再起動後は現在存在するウィンドウへ再接続する
- 一致するウィンドウが 0 件のプリセットでも未接続タブを持つ待機グループを作る
- 未起動アプリはプリセット適用時に起動しない
- Task View / Alt+Tab から選択した管理対象ウィンドウをアクティブタブへ同期する
- 最大化 / Snap Layouts の通常操作でグループが壊れない
- NSIS `setup.exe` から通常インストールできる
- public GitHub Releases を正式な配布先として使う
- Tauri Updater で GitHub Release の新バージョンを検知・ダウンロード・更新できる
- 更新後もプリセット / 設定が保持される

macOS 版では同じ共通仕様を使い、Task View 相当を Mission Control に置き換える。配布・Updater基盤は同じ public GitHub Releases を再利用する。

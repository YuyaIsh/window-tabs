# window-tabs docs

`window-tabs` は、既存のデスクトップアプリのウィンドウをウィンドウ単位でグループ化し、共通のタブバーから切り替えるためのデスクトップアプリ。

Windows を先に実装するが、macOS を後から追加できる構成を前提にする。

## Documents

- [SPEC.md](./SPEC.md): ユーザー操作、タブグループ、プリセット、復元、マルチディスプレイの仕様
- [ARCHITECTURE.md](./ARCHITECTURE.md): 共通層と OS 依存層の分離、Windows / macOS backend の境界
- [DECISIONS.md](./DECISIONS.md): 現時点で確定した設計判断、採用しない方針、未確定事項

## 開発順

1. Windows の技術 spike で Task View、タブバー host、実ウィンドウ D&D、最大化 / Snap の成立を確認する
2. 共通モデルと platform interface を作る
3. Windows backend とタブ UI を実装する
4. D&D、複数グループ、複数ディスプレイ、プリセット、再接続を実装する
5. Windows 10 / 11 で Task View / Alt+Tab 連携と edge case を詰める
6. macOS backend を追加する
7. Mission Control、Accessibility、macOS 固有のウィンドウ挙動を調整する

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

macOS 版では同じ共通仕様を使い、Task View 相当を Mission Control に置き換える。

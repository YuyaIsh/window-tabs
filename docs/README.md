# window-tabs docs

`window-tabs` は、既存のデスクトップアプリのウィンドウをウィンドウ単位でグループ化し、共通のタブバーから切り替えるためのデスクトップアプリ。

Windows を先に実装するが、macOS を後から追加できる構成を前提にする。

## Documents

- [SPEC.md](./SPEC.md): ユーザー操作、タブグループ、プリセット、復元、マルチディスプレイの仕様
- [ARCHITECTURE.md](./ARCHITECTURE.md): 共通層と OS 依存層の分離、Windows / macOS backend の境界
- [DECISIONS.md](./DECISIONS.md): 現時点で確定した設計判断、採用しない方針、未確定事項

## 開発順

1. 共通モデルと platform interface を作る
2. Windows backend を実装する
3. Windows 版でタブ、D&D、プリセット、複数ディスプレイ、Task View 同期まで完成させる
4. macOS backend を追加する
5. Mission Control、Accessibility、macOS 固有のウィンドウ挙動を調整する

## v1 の対象

- Windows 10 / 11
- 複数の既存ウィンドウを同じ位置・サイズに重ねる
- GUI タブからウィンドウ単位で切り替える
- 修飾キー + ウィンドウ D&D でグループ化する
- タブ D&D で並べ替え、グループ間移動、グループ解除を行う
- 複数グループを同時に管理する
- グループを別ディスプレイへ移動する
- プリセットを保存し、再起動後は現在存在するウィンドウへ再接続する
- 未起動アプリはプリセット適用時に起動しない
- Task View から選択した管理対象ウィンドウをアクティブタブへ同期する

macOS 版では同じ共通仕様を使い、Task View 相当を Mission Control に置き換える。

# Implementation plan review

Status: **APPROVED**

対象: `docs/IMPLEMENTATION_PLAN.md`

照合対象:

- `docs/SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/DECISIONS.md`

## Review round 1

### Findings

1. フェーズの成果物をどこでレビューするかが曖昧だった
2. 実装者の self review だけでも `APPROVED` にできる書き方だった
3. OS GUI の動作確認を実行できない場合の扱いがなく、未確認を PASS 扱いできてしまった
4. review finding の severity と approve threshold がなかった

### Fixes

- 原則 `1 phase = 1 branch / 1 PR` に変更
- `main` は最後に approve された状態だけを持つルールを追加
- 実装後に base diff を読み直す independent review pass を必須化
- P0 / P1 / P2 / P3 の finding level を追加
- P0〜P2 が 0 件でなければ approve 禁止
- 実機 GUI 確認が未実行なら `BLOCKED: MANUAL VERIFICATION` とし、代理 PASS を禁止
- phase ごとに `docs/phase-reviews/PHASE-XX.md` を残す形式を追加

Result: **FIXED**

## Review round 2

### Findings

`SPEC.md` との突合で以下の不足を確認した。

1. Phase 0 が Windows 10 / 11 両方の事前確認を要求していなかった
2. タブバー host の除外対象に taskbar が明示されていなかった
3. Chrome の複数 window を別 `HWND` として識別する spike 項目が弱かった
4. preset 保存時に、その瞬間の window title を無条件で matcher にしないルールが plan に不足していた
5. tray / menu-bar という常駐入口が後半まで実装されず、`SPEC.md` の起動導線と順序がずれていた

### Fixes

- Phase 0 の goal / approve に Windows 10 / 11 両方を追加
- Win10 Snap、Win11 Snap Layouts を分けて確認
- Task View / Alt+Tab / taskbar から tab bar host を除外する確認を追加
- Chrome multi-window の `HWND` 識別確認を追加
- Phase 1 で Windows task tray の最小 shell を作るよう変更
- Phase 5 に preset management / tray selection を追加
- transient な現在タイトルを自動 matcher 化しない acceptance criteria を追加

Result: **FIXED**

## Review round 3: final

### Dependency review

PASS

- Phase 0 で OS 制約を先に確定する
- Phase 1 で cross-platform boundary を固定する
- Phase 2 で D&D なしの中心機能を完成させる
- Phase 3 で D&D を追加する
- Phase 4 で geometry / display を固める
- Phase 5 で persistence を追加する
- Phase 6 で Windows v1 regression を閉じる
- Phase 7 以降で macOS を追加する

### Product-spec review

PASS

- 1 tab でも tab bar を維持
- 未起動 app は起動しない
- 0-connected preset は waiting group を作る
- multi-window を window 単位で扱う
- ambiguous reconnect は manual assignment
- Task View / Mission Control で各実 window を個別表示
- OS 標準 window selection を active tab へ同期
- multi-display を v1 に含める

### Architecture review

PASS

- `HWND` / AX 型を shared core へ出さない
- UI / preset / group state は共通化
- native window control / D&D / tab-bar host は platform backend に分離
- Windows tray / macOS menu bar は同じ application actions に接続する
- runtime window ID は persistence へ保存しない

### Approval-gate review

PASS

- 各 phase に behavior verification がある
- 未実行 GUI check を PASS にできない
- findings 修正後の re-check を要求している
- P0〜P2 が残ると approve できない
- phase review の evidence を保存する

## Final approval

- Specification alignment: **PASS**
- Architecture boundary: **PASS**
- Phase dependency order: **PASS**
- Verification coverage: **PASS**
- Approval criteria enforceability: **PASS**
- Unresolved P0-P2 findings: **0**

**APPROVED**

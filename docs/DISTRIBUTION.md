# Distribution and update strategy

## 方針

`window-tabs` は開発環境から起動するだけでなく、通常のデスクトップアプリとしてインストールして使える状態を Windows v1 の完了条件に含める。

repository は public 運用とし、Windows は NSIS installer を正式な導入方法、更新は Tauri Updater + GitHub Releases + `tauri-action` の標準構成を使う。

自前の update server や配布専用 repository は持たない。ソース、release workflow、installer、updater metadata、updater artifact を `YuyaIsh/window-tabs` に集約する。

macOS 追加時も同じ updater infrastructure を使い、配布形式だけ DMG / app bundle に切り替える。

この文書の Windows 項目は `IMPLEMENTATION_PLAN.md` の Phase 6: Windows v1 hardening の acceptance criteria の一部として扱う。

## Repository visibility

`YuyaIsh/window-tabs` は public repository とする。

理由:

- GitHub Releases の `latest.json` / updater artifact を認証なしで取得できる
- updater 用に GitHub token をアプリへ埋め込む必要がない
- 配布専用 repository や update server を別途管理しなくてよい
- 今回の実装は秘密情報や個人データを source に含める必要がない

public 化する前に secrets / local paths / personal configuration が履歴へ含まれていないことを確認する。

公開してよいもの:

- source code
- updater public key
- GitHub Actions workflow
- installer / release artifacts
- docs

公開してはいけないもの:

- updater signing private key
- signing private-key password
- PAT / GitHub token の固定値
- code-signing private key / certificate secret
- 個人設定やローカル環境固有の秘密情報

## Windows installation

正式な成果物は NSIS の `setup.exe` とする。

```text
GitHub Release
├─ window-tabs_<version>_x64-setup.exe
├─ updater artifact
├─ updater signature
└─ latest.json
```

想定フロー:

1. 初回だけ GitHub Releases から `setup.exe` をダウンロードする
2. current-user install する
3. Start menu / task tray から起動する
4. 必要なら Windows login 時の自動起動を有効化する
5. 以後の更新はアプリ内 updater から行う

Microsoft Store は v1 の対象外。

## Updater

Tauri v2 の updater plugin を使う。

```text
window-tabs
  ↓ update check
public GitHub Releases / latest.json
  ↓
new version found
  ↓
download updater artifact
  ↓
verify signature
  ↓
user approves update
  ↓
install
  ↓
restart window-tabs
```

Tauri の updater artifact generation を有効にする。

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

Updater endpoint は public GitHub Release の `latest.json` に固定する。

```text
https://github.com/YuyaIsh/window-tabs/releases/latest/download/latest.json
```

認証 header、PAT、GitHub login は updater の通常フローに使わない。

## Update UX

v1 では複雑な update UI は作らない。

基本動作:

1. アプリ起動後に更新確認する
2. task tray に `Check for updates` を用意する
3. 新しい version があれば小さい dialog / notification で version と release note 要約を表示する
4. ユーザーが `Update` を押したら download + signature verify + install を行う
5. 更新準備完了後、再起動が必要なことを示してユーザー操作で再起動する

同じ起動中に何度も GitHub へ問い合わせないように update check は rate-limit する。v1 は起動時確認 + 手動確認で十分とし、常時 polling は行わない。

Windows の install mode は Tauri 推奨の passive を基本にする。

更新失敗時は現在 version を壊さず、エラーと GitHub Release への導線を表示する。

自動的に無断で更新・再起動はしない。

## Update signing

Tauri Updater の artifact signature を必須とする。

- public key: app config に含める
- private key: repository に commit しない
- private key password: repository に commit しない
- GitHub Actions では Secrets から渡す

想定 secret:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

秘密鍵を失うと既存インストールへ同じ update chain で配信できなくなるため、GitHub Secrets だけを唯一の保管場所にしない。安全な別バックアップを持つ。

Tauri Updater の署名と Windows Authenticode code signing は別物として扱う。

個人利用優先の v1 では Windows code-signing certificate の購入は必須条件にしない。ただし SmartScreen / installer warning が日常利用を阻害する場合は後から導入する。

## GitHub Actions release pipeline

`tauri-action` を使い、release workflow を定型化する。

release 時に最低限次を自動生成する。

- Windows NSIS installer
- updater artifact
- updater signature
- `latest.json`
- GitHub Release assets

Private updater signing key は GitHub Actions Secrets から注入する。

release trigger は v1 では version tag を基本とし、必要なら `workflow_dispatch` も許可する。

通常 commit / PR merge だけで release されないようにする。

## Release procedure

人間が毎回 installer を組み立てない。

```text
1. version bump
2. changelog / release note
3. automated checks
4. version tag
5. release workflow
6. GitHub Release + updater assets生成
7. clean install smoke test（必要な release）
8. 既存 version から update check
9. update install smoke test
10. release APPROVED
```

バージョンは SemVer を使う。

```text
0.1.0
0.1.1
0.2.0
```

## Persistence during updates

プリセットや設定は installer directory に保存しない。

OS の application data directory を使い、アプリ本体の更新 / 再インストールとユーザーデータを分離する。

update / repair install で次が消えないことを必須とする。

- presets
- app settings
- group-related persistent configuration

runtime window IDs はもともと永続化対象外。

## Windows v1 distribution acceptance criteria

Phase 6 を `Windows v1 APPROVED` にする前に以下を実機で確認する。

1. repository の public Release asset を未認証状態で取得できる
2. clean な Windows 環境へ NSIS installer からインストールできる
3. installer 版が task tray で正常起動する
4. アンインストールできる
5. version N をインストール後、version N+1 を public `latest.json` から検知できる
6. `Update` 操作で artifact を download / verify / install できる
7. update 後に新 version が起動する
8. update 前の presets / settings が残る
9. updater failure 時に旧 version が利用不能にならない
10. release artifact と `latest.json` が GitHub Actions で再現可能に生成される
11. signing private key / password が repository / release artifact / logs に露出していない
12. public 化前の repository history に秘密情報が含まれていないことを確認している

1〜12 のいずれかが未確認なら Distribution は `APPROVED` にしない。

## macOS later

macOS では最終配布形式を DMG とする。

Updater の shared logic / public GitHub Releases / release pipeline / versioning policy は Windows と共通化する。

追加で必要になるもの:

- Apple code signing
- notarization
- updater artifact for macOS
- Accessibility permission onboarding

macOS 公開配布の署名 / notarization は macOS Phase で扱い、Windows v1 の blocker にはしない。

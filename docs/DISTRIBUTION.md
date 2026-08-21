# Distribution and update strategy

## 方針

`window-tabs` は開発環境から起動するだけでなく、通常のデスクトップアプリとしてインストールして使える状態を Windows v1 の完了条件に含める。

Windows は NSIS installer を正式な導入方法とし、更新は Tauri Updater + GitHub Releases + `tauri-action` の標準構成を使う。

自前の update server は持たない。

macOS 追加時も同じ updater infrastructure を使い、配布形式だけ DMG / app bundle に切り替える。

この文書の Windows 項目は `IMPLEMENTATION_PLAN.md` の Phase 6: Windows v1 hardening の acceptance criteria の一部として扱う。

## Windows installation

正式な成果物は NSIS の `setup.exe` とする。

```text
GitHub Release
└─ window-tabs_<version>_x64-setup.exe
```

想定フロー:

1. `setup.exe` を一度ダウンロードする
2. current-user install する
3. Start menu / task tray から起動する
4. 必要なら Windows login 時の自動起動を有効化する
5. 以後の更新はアプリ内 updater から行う

Microsoft Store は v1 の対象外。

## Updater

Tauri v2 の updater plugin を使う。

構成:

```text
window-tabs
  ↓ update check
GitHub Releases / latest.json
  ↓
new version found
  ↓
download updater artifact
  ↓
verify signature
  ↓
install
  ↓
restart window-tabs
```

更新 server は用意せず、GitHub Release に置かれた static `latest.json` を endpoint とする。

Tauri の updater artifact generation を有効にする。

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

Updater endpoint は GitHub Releases の `latest.json` を使う。

```text
https://github.com/YuyaIsh/window-tabs/releases/latest/download/latest.json
```

private repository のまま GitHub Releases を updater endpoint として直接利用できない場合は、認証を必要としない配布先へ updater metadata / artifact を置くか、release asset access の方式を再検討する。

この点は実装時に実環境で確認し、認証情報をアプリへ埋め込む方式は採用しない。

## Update UX

v1 では複雑な update UI は作らない。

推奨動作:

1. 起動時または一定間隔で更新確認
2. 新しい version があれば task tray / 小さい dialog で通知
3. `Update` を押す
4. download + install
5. 再起動

Windows の install mode は Tauri 推奨の `passive` を基本にする。

更新失敗時は現在 version を壊さず、エラーと GitHub Release への導線を表示する。

自動的に無断で再起動はしない。更新開始はユーザー操作を必要とする。

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

個人利用 v1 では Windows code-signing certificate の購入は必須条件にしない。ただし SmartScreen / installer warning が日常利用を阻害する場合は後から導入する。

## GitHub Actions release pipeline

`tauri-action` を使い、release workflow を定型化する。

release 時に最低限次を自動生成する。

- Windows NSIS installer
- updater artifact
- updater signature
- `latest.json`
- GitHub Release assets

Private updater signing key は GitHub Actions Secrets から注入する。

release trigger は v1 では手動 `workflow_dispatch` または version tag を基本とする。

誤って commit しただけで release されないようにする。

## Release procedure

人間が毎回 installer を組み立てない。

```text
1. version bump
2. changelog / release note
3. release workflow を実行
4. CI checks
5. GitHub Release 作成
6. updater metadata / artifact 公開
7. installed window-tabs から update check
8. update install の smoke test
9. release APPROVED
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

1. clean な Windows 環境へ NSIS installer からインストールできる
2. installer 版が task tray で正常起動する
3. アンインストールできる
4. version N をインストール後、version N+1 を updater で検知できる
5. `Update` 操作で artifact を download / verify / install できる
6. update 後に新 version が起動する
7. update 前の presets / settings が残る
8. updater failure 時に旧 version が利用不能にならない
9. release artifact と `latest.json` が GitHub Actions で再現可能に生成される
10. signing private key が repository / artifact / log に露出していない

1〜10 のいずれかが未確認なら Distribution は `APPROVED` にしない。

## macOS later

macOS では最終配布形式を DMG とする。

Updater の shared logic / GitHub Release pipeline / versioning policy は Windows と共通化する。

追加で必要になるもの:

- Apple code signing
- notarization
- updater artifact for macOS
- Accessibility permission onboarding

macOS 公開配布の署名 / notarization は macOS Phase で扱い、Windows v1 の blocker にはしない。

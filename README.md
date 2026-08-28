# window-tabs

Windowsの複数アプリウィンドウを、OS本来のウィンドウとして保ったままタブグループとして扱うTauriアプリです。Windows v1の仕様と未完了の実機検証は [`docs/`](docs/README.md) を参照してください。

## Development

```sh
pnpm install
pnpm test
pnpm tauri dev
```

`pnpm tauri dev` と `pnpm tauri build` はTauri設定からViteを自動起動・buildします。Windows x86_64の正式bundleはNSIS `setup.exe`です。

## Distribution status

Release workflow、installer/updater構成、署名と公開手順は [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) にあります。public Release、clean install、N→N+1 updateの実機確認が完了するまでWindows v1は承認済みではありません。

このrepositoryにlicenseは現在設定されていません。public visibilityはlicense付与を意味しません。

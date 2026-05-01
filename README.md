# Presence Board

A lightweight presence board for labs and small teams, built with Google Sheets and Google Apps Script.

研究室の入口などに共用のタブレットやPCを設置し、メンバーが「名前」と「場所」をタップするだけで、在室状況を表示・記録できるシンプルな在室管理アプリです。Google スプレッドシートをデータベースとして使うため、専用サーバーを用意せずに運用できます。

## Overview / 概要

Presence Board is designed for small teams that want a simple shared presence board rather than a full attendance or access-control system.

主な用途は、研究室や小規模チームでの「今誰がどこにいるか」の表示と記録です。Google スプレッドシートをデータベースとして使い、名前・場所・現在の在室状態・月別ログを管理します。メンバーが操作する記録画面と現在状況の表示画面は、Google Apps Script の Web アプリとして提供されます。

## Quick Start / クイックスタート

コピーしてすぐ使えるテンプレートとマニュアルがあります。

- [テンプレートスプレッドシート](https://docs.google.com/spreadsheets/d/1rs_7nHPYXUjBowMV9iE3dZaFCQKRNdjUGkJva_h3tdQ/)
- [管理者マニュアル](https://docs.google.com/document/d/1aLXh18hwadBRDj0TtehTXwS25bgSF0ulCFcEt-WPE2g/)
- [ユーザーマニュアル](https://docs.google.com/document/d/1Itvdnezfv0nHPGv82CrWNFMA-Yv7f8wXjJzXd3Z2mcs/)

基本的には、テンプレートスプレッドシートをコピーし、スプレッドシート内の Apps Script を Web アプリとしてデプロイして使います。

## Features / 主な機能

- 名前と場所をタップするだけのシンプルな記録画面
- 現在の在室状況を同じ画面に表示
- 月別ログシートへの記録
- 現在状態用の `current_presence` シート
- iPad などの共有端末向けの専用URL生成画面
- QRコードによる端末セットアップ補助
- 夜間などの在室通知メール
- Google Sheets だけで管理できるメンバー・場所マスタ

## Sheet Structure / シート構成

テンプレートには主に以下のシートがあります。

| Sheet | Purpose |
| --- | --- |
| `users` | メンバー一覧。`username`, `name_ja`, `name_en` を管理します。 |
| `locations` | 場所一覧。`location_id`, `location_ja`, `location_en`, `color`, `icon` を管理します。 |
| `current_presence` | 現在の在室状態です。通常はアプリが更新します。 |
| `logs_YYYY_MM` | 月別ログです。保存操作ごとに追記されます。 |

## Deployment / デプロイ手順

1. テンプレートスプレッドシートをコピーします。
2. `users` と `locations` を自分の環境に合わせて編集します。
3. スプレッドシートから Apps Script を開きます。
4. Web アプリとしてデプロイします。
5. 発行された `/exec` URL を開き、端末名を入力して専用URLを生成します。
6. 共有端末のホーム画面やブックマークに登録します。

詳しい手順は [管理者マニュアル](https://docs.google.com/document/d/1aLXh18hwadBRDj0TtehTXwS25bgSF0ulCFcEt-WPE2g/) を参照してください。

## Repository Files / リポジトリ構成

| File | Description |
| --- | --- |
| `Code.gs` | Google Apps Script のサーバー側コードです。 |
| `Index.html` | Web アプリのUIです。 |

テンプレートを使わずに手動導入する場合は、Apps Script プロジェクトに同名ファイルとして配置してください。

## Security / Privacy Notes / セキュリティとプライバシーに関する注意

This app is designed as a lightweight presence board for small teams. It is not intended for strict access control, attendance tracking, or security auditing.

このアプリは、小規模チーム向けの簡易的な在室状況表示ツールです。厳密なアクセス制御、勤怠管理、監査記録を目的としたものではありません。

Access control depends on the Google Apps Script web app deployment settings. If the web app is made accessible to anyone with the URL, anyone who obtains the URL may be able to submit presence updates.

アクセス制御は、Google Apps Script の Web アプリのデプロイ設定に依存します。「URLを知っている全員」がアクセスできる設定にすると、URLを入手した第三者が在室状況を更新できる可能性があります。

The app may load external resources such as web fonts, icon fonts, and a QR-code generation service. If your environment requires fully internal operation, review or replace these external dependencies.

このアプリは、Webフォント、アイコンフォント、QRコード生成サービスなどの外部リソースを読み込む場合があります。完全に内部ネットワーク内で運用する必要がある場合は、これらの外部依存を確認し、必要に応じて置き換えてください。

## Operational Notes / 運用上の注意

- 通知トリガーは `Asia/Tokyo` 固定です。意図しない時刻に通知されるのを避けるためです。
- `current_presence` の再構築は直近2か月分のログを対象にしています。ログシートが増えた場合の処理時間を抑えるためです。
- セットアップ画面のQRコード生成には外部サービス `api.qrserver.com` を使っています。表示されない場合はURLを直接開いてください。
- Google Apps Script と Google Sheets の実行制限に依存します。大規模な入退室管理システムではなく、小規模チーム向けです。

## License / ライセンス

This project is released under the MIT License. See [LICENSE](LICENSE) for details.

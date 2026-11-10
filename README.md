# Tänk!（テンク）

正五角形の大陸で道と建物を育てて競う、オンライン対戦ボードゲーム。

## ファイル
- `seigokaku.html` … ゲーム本体（ルールと画面）
- `shim.js` … ブラウザとサーバーをつなぐ
- `server.js` … ページの配信と、対局の判定。サイコロ、ミニゲーム、CPU、隠し情報はすべてサーバーが扱う

## 動かし方
```
npm install
npm start
```
http://localhost:3000 を開く。

## 注意
無料プランのサーバーは再起動するとデータ（対局中の部屋と席ごとの勝ち数）が消える。

## ログインとアバター（任意）

Render の環境変数に次を入れると、メールでのログインと、写真からのアバター作成が有効になります。入れないときは、今までどおりログインなしで遊べます。

| 変数 | 中身 |
|---|---|
| `SUPABASE_URL` | Supabase の Project URL（例 `https://xxxx.supabase.co`） |
| `SUPABASE_SERVICE_KEY` | Supabase の service_role キー（秘密。GitHubには置かない） |
| `XAI_API_KEY` | xAI の API キー（アバター作成に使う。無ければアバター作成だけ止まる） |
| `AVATAR_PER_DAY` | 1人が1日に作れるアバターの数（省略時 3） |

- アカウントの名前とアバターは Supabase のユーザー情報に、アバター画像は Storage の `avatars`（公開）に入る。`avatars` は起動時に自動で作る。
- Supabase の Authentication → URL Configuration の Site URL を本番のURLにする。
- メールにコードを出すには、Authentication → Emails の Magic Link のテンプレートに `{{ .Token }}` を入れる。入れなくても、メールのリンクでログインできる。
- Supabase 標準のメール送信は1時間に数通までなので、人に配るときは自前のSMTP（Resend など）を設定する。

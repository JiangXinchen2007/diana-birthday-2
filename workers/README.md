# Diana Chat —— 后端部署指南（Kimi 版）

这个文件夹是网页里「自由对话」功能的后端。它跑在 **Cloudflare Workers**（有免费额度），
作用是安全地保管你的 **Kimi（Moonshot）API key**，并把角色聊天请求转发给 Kimi。
妍妍那边只用打开网页，完全不需要懂这些。

> 后端走的是 OpenAI 兼容协议，默认接 Kimi。以后想换 DeepSeek 等，只改 `BASE_URL` +
> `MODEL` + key 三样即可，网页前端一行都不用动。

---

## 你需要准备

1. 一个 **Kimi / Moonshot API key** —— 你已经有了 ✅
   （没有的话：https://platform.moonshot.cn/ 注册 → 「API Key 管理」新建，形如 `sk-...`；
   控制台里可以充值，也能设额度上限。）
2. 一个 **Cloudflare 账号**（免费）—— https://dash.cloudflare.com/sign-up
3. 电脑上有 **Node.js**（你已经装好了 ✅）

---

## 部署步骤（约 5 分钟）

在终端里进到这个文件夹：

```bash
cd ~/Desktop/爱/Diana-Birthday-2/workers
```

### 1. 登录 Cloudflare
```bash
npx wrangler login
```
第一次会问要不要安装 wrangler，输 `y`；浏览器弹出后点「允许」。

### 2. 设置 Kimi key（作为加密 secret，不写进任何文件）
```bash
npx wrangler secret put LLM_API_KEY
```
粘贴你的 Kimi key，回车。

### 3. 部署
```bash
npx wrangler deploy
```
成功后会打印一个网址，类似：
```
https://diana-chat.<你的名字>.workers.dev
```
**把这个网址复制下来** —— 下一步要填进网页。

---

## 把后端接进网页

打开 `index.html`，找到最上面这一行（`<script>` 开头附近）：

```js
const CHAT_API = "";   // ← 把上面 wrangler 给你的网址粘到这里
```

填好保存。例如：
```js
const CHAT_API = "https://diana-chat.jiang.workers.dev";
```

没填的话，网页其它部分照常工作，只是「自由对话」入口会提示未配置。

---

## 换模型 / 调效果

默认 `moonshot-v1-32k`，稳定够用。想调整就在 `wrangler.toml` 的 `[vars]` 里设 `MODEL`，
然后 `npx wrangler deploy` 重新部署：

| MODEL | 说明 |
|---|---|
| `moonshot-v1-32k`（默认） | 均衡，上下文足够群聊用 |
| `kimi-k2-0905-preview` | ⭐ 角色扮演更强、更会演（需账号已开通，可在 Moonshot 控制台查可用模型名）|
| `moonshot-v1-8k` | 更便宜，单聊够用 |
| `moonshot-v1-128k` | 超长上下文，一般用不上 |

> 不确定自己账号有哪些模型名？登录 https://platform.moonshot.cn/ 在控制台能看到。

---

## （可选）锁定来源更安全

部署网页后，把 `wrangler.toml` 里的 `ALLOW_ORIGIN` 改成网页地址，再 deploy 一次：

```toml
[vars]
ALLOW_ORIGIN = "https://你的网页地址"
```

这样只有你的网页能调用这个后端。

---

## 以后想换成 DeepSeek？

在 `wrangler.toml` 里加两行，把 key 换成 DeepSeek 的，重新部署即可（前端不用动）：

```toml
[vars]
BASE_URL = "https://api.deepseek.com"
MODEL = "deepseek-chat"
```
```bash
npx wrangler secret put LLM_API_KEY   # 这次粘 DeepSeek 的 key
npx wrangler deploy
```

---

## 费用心安提示

- Cloudflare Workers 免费额度每天 10 万次请求，个人用绰绰有余。
- Kimi 按 token 计费，单价很低；后端已开 **流式输出**（回复像打字一样逐字蹦出来）。
- 可在 Moonshot 控制台设充值额度，绝不会超支。

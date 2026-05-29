# 项目交接文档 —— Diana 生日网站

> 把这份文档完整发给新对话，即可无缝接着干。

## 一句话背景
为一个叫 **戴妍（妍妍酱 / Diana，生日 6 月 6 日）** 的女孩做的动漫主题生日网站，
送礼人是「江（Jiang）」。项目根目录：`/Users/jxc/Desktop/爱/Diana-Birthday-2/`

## 目录结构
```
Diana-Birthday-2/
├── index.html        ← 整个前端（单文件 HTML/CSS/JS，视觉小说引擎 + 自由对话 UI）
├── img/              ← 各动漫角色立绘 PNG（按世界分子文件夹）
├── audio/            ← 音频
└── workers/          ← 自由对话功能的后端（Cloudflare Worker）
    ├── worker.js     ← 主逻辑：代理 Kimi、注入人格、SSE 流式转发
    ├── personas.js   ← 41 个角色的人格设定 + 中文名 + 世界名
    ├── wrangler.toml ← Cloudflare 部署配置
    └── README.md     ← 部署指南（Kimi 版）
```

## 已完成的功能
- **门户 + 7 个动漫世界**（EVA、电锯人、进击的巨人、鬼灭、死亡笔记、药屋少女、NANA），
  上三下四居中排列；每个世界点进去先有**特色 intro 屏**（EVA 的 MAGI 投票、电锯人心跳、
  AOT 警报、鬼灭呼吸法选择、死亡笔记本、药屋卷轴、NANA 车票），再进视觉小说剧情。
  - intro 里**不出现真名"戴妍"**，只用 Diana（这是用户明确要求）。
- 7 个世界点亮后出现**信封**，点击开启 → **信件**（江写给妍妍的话，目前是占位文案，
  用户说之后会给真正内容）。
- **生日倒计时**（到 2026-06-06）。
- **自由对话功能**（最新做的，重点）：
  - 看完信后，信纸上出现「✦ 走进这些世界，和他们聊聊 ✦」入口，右下角也有常驻 ✦ 浮标。
  - **聊天大厅**：选世界 → 选角色（圆形头像=角色立绘的脸）。点 1 个=单聊，多选/全员=群聊。
  - **聊天室**：单聊时角色立绘淡淡站在右侧；群聊时多角色各自带头像/名字/专属配色气泡，
    **逐字流式打出**、一条条接力浮现，中间有"正在输入"停顿。
  - 前端只跟自己的后端用自定义 SSE 协议（`start`/`delta`/`end`/`done`/`error`）通信。

## 后端技术细节
- **Cloudflare Worker**，调 **Kimi（Moonshot）** 的 OpenAI 兼容接口，流式输出。
  写成了通用版：换 DeepSeek 等只改 `BASE_URL` + `MODEL` + key。
- 环境变量：`LLM_API_KEY`(secret，Kimi key) / `MODEL`(默认 moonshot-v1-32k) /
  `BASE_URL`(默认 https://api.moonshot.cn/v1) / `ALLOW_ORIGIN`(默认 *)。
- 单聊：模型直接输出对话。群聊：模型按 `角色id<Tab>台词\n` 逐行输出，worker 解析后
  按角色分气泡推送（分隔符容忍 Tab/空格/冒号）。
- 已用 Node 脚本验证过 SSE 解析（单聊/群聊/跨块切断的 id 都正确），前端流式也在浏览器实测过。

## ⏳ 当前进度 / 下一步（正卡在这里）
用户在**部署后端**。终端里已经：
1. ✅ `cd ~/Desktop/爱/Diana-Birthday-2/workers`
2. 🔄 `npx wrangler login` —— 正在安装 wrangler@4.95.0（输了 y），等它装完会弹浏览器授权。

**接下来要做的：**
1. 等 `wrangler login` 弹浏览器 → 点「允许」登录 Cloudflare。
2. `npx wrangler secret put LLM_API_KEY` → 粘贴 Kimi key（用户已有 key）。
3. `npx wrangler deploy` → 复制打印出的 `https://diana-chat.xxx.workers.dev` 网址。
4. **把该网址填进 `index.html` 顶部的 `const CHAT_API = "";`**（在 `<script>` 开头附近，
   `WORLD DATA` 注释上方）。填完自由对话就通了。

## 待办 / 可能的后续
- 信件真正内容（用户说之后给）。
- 可选：把 `MODEL` 换成 `kimi-k2-0905-preview`（角色扮演更强，需账号开通）。
- 可选：部署网页后把 `ALLOW_ORIGIN` 锁成网页地址。

## 工作方式备注
- 本地用 preview server（端口 8082）预览 index.html；改完可截图验证。
- 用户中文交流；这是私人礼物，注重情感与细节、视觉要高级丝滑。
- 密钥只在用户终端输入，不经过 AI。

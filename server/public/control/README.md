# control/（st 对象模块化，已启用）

入口：`../control.js` → `main.js`（`device.html` 需 `type="module"`）

## 结构

| 文件 | 职责 |
|------|------|
| `state.js` | `export const st = { ... }` 共享可变状态 + `StreamDiag` |
| `codec.js` | 画质/编码、群控标题、`skipStaleDisplayFrames` |
| `frame.js` | 画面解码、Canvas 绘制、WS 二进制帧 |
| `session.js` | WebSocket、`sendControl`、`handleMessage` |
| `viewer.js` | 手势、侧边按钮、上传、编码切换 UI |
| `main.js` | 初始化顺序 |

跨模块赋值请写 **`st.xxx = ...`**，不要 `import { ws }` 后直接 `ws = ...`。

## 重新生成模块

```bash
node scripts/split-control-st.mjs
```

生成后需人工检查：勿出现 `let st.xxx`、`getElementById("st.xxx")`、`"x-admin-st.token"` 等误替换。

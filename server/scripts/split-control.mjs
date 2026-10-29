/**
 * 将 public/control.js.bak 拆为 ES 模块（import 使用 live binding）
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const srcPath = path.join(publicDir, "control.js.bak");
const outDir = path.join(publicDir, "control");

const lines = fs.readFileSync(srcPath, "utf8").split(/\r?\n/);
const slice = (from, to) => lines.slice(from - 1, to).join("\n");

const stateLines = [
  ...lines.slice(0, 121),
  ...lines.slice(182, 231),
  ...lines.slice(420, 477),
  lines[995],
  ...lines.slice(1081, 1089),
  ...lines.slice(1387, 1389),
  ...lines.slice(1600, 1602),
  ...lines.slice(3216, 3220),
].join("\n");

const stateBody = stateLines
  .split("\n")
  .map((line) => {
    if (!line.trim()) return line;
    if (/^(const|let|var)\s/.test(line)) return `export ${line}`;
    return line;
  })
  .join("\n");

const importNames = [];
const re = /^export (?:const|let|var) (\w+)/gm;
let m;
while ((m = re.exec(stateBody)) !== null) importNames.push(m[1]);
const importBlock = importNames.join(",\n  ");

function wrapModule(name, code) {
  return `/** @module control/${name} */\nimport {\n  ${importBlock},\n} from "./state.js";\n\n${code}\n`;
}

/** 124-179 辅助函数；232-394 编码；432-450 丢帧函数（跳过重复 let/Set） */
const codecBlock = [slice(124, 179), slice(232, 394), slice(432, 450)].join("\n\n")
  .replace("\nfunction updateGroupControlTitle", "\nexport function updateGroupControlTitle")
  .replace("\nfunction initMasterDeviceSelect", "\nexport function initMasterDeviceSelect")
  .replace("\nfunction initViewerQualityBar", "\nexport function initViewerQualityBar");

const sessionBlock = slice(1732, 2712).replace(
  "\nfunction connectWebSocket",
  "\nexport function connectWebSocket"
);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "state.js"), `/** 控制页共享状态 */\n${stateBody}\n`);
fs.writeFileSync(path.join(outDir, "codec.js"), wrapModule("codec", codecBlock));
/** 479-1731 画面逻辑，去掉已迁入 state.js 的零散 let/const 行 */
function frameBlock() {
  const chunks = [];
  let from = 479;
  const skipRanges = [
    [996, 996],
    [1082, 1089],
    [1388, 1389],
    [1601, 1602],
  ];
  for (const [a, b] of skipRanges) {
    if (from <= a - 1) chunks.push(slice(from, a - 1));
    from = b + 1;
  }
  if (from <= 1731) chunks.push(slice(from, 1731));
  return chunks.join("\n");
}
fs.writeFileSync(path.join(outDir, "frame.js"), wrapModule("frame", frameBlock()));
fs.writeFileSync(path.join(outDir, "session.js"), wrapModule("session", sessionBlock));
fs.writeFileSync(path.join(outDir, "viewer.js"), wrapModule("viewer", slice(2713, 3702)));

fs.writeFileSync(
  path.join(outDir, "main.js"),
  `/** 设备控制页入口 */\nimport "./state.js";\nimport { updateGroupControlTitle, initMasterDeviceSelect, initViewerQualityBar } from "./codec.js";\nimport "./frame.js";\nimport { connectWebSocket } from "./session.js";\nimport "./viewer.js";\n\nupdateGroupControlTitle();\ninitMasterDeviceSelect();\ninitViewerQualityBar();\nconnectWebSocket();\n`
);

fs.writeFileSync(
  path.join(publicDir, "control.js"),
  `/** 入口：实现已拆分至 control/ */\nimport "./control/main.js";\n`
);

console.log("OK exports:", importNames.length);

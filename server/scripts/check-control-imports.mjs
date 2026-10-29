import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "control");
const files = ["frame.js", "session.js", "codec.js", "viewer.js"];

const defined = new Map();
const imported = new Map();

for (const f of files) {
    const code = fs.readFileSync(path.join(dir, f), "utf8");
    imported.set(f, new Set());
    for (const m of code.matchAll(/^function\s+(\w+)/gm)) defined.set(m[1], f);
    for (const m of code.matchAll(/^export function\s+(\w+)/gm)) defined.set(m[1], f);
    for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/([^"]+)"/g)) {
        for (const n of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
            imported.get(f).add(n);
        }
    }
}

const called = new Map();
for (const f of files) {
    const code = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of code.matchAll(/\b([a-z][a-zA-Z0-9_]*)\s*\(/g)) {
        const id = m[1];
        if (["if", "for", "while", "switch", "catch", "function", "return", "new", "typeof", "await", "case"].includes(id)) {
            continue;
        }
        if (!called.has(id)) called.set(id, new Set());
        called.get(id).add(f);
    }
}

const missing = [];
for (const [fn, mods] of called) {
    const def = defined.get(fn);
    if (!def) continue;
    for (const m of mods) {
        if (m === def) continue;
        if (!imported.get(m)?.has(fn)) missing.push({ fn, usedIn: m, defIn: def });
    }
}

if (missing.length) {
    console.error("Missing imports:");
    for (const x of missing.sort((a, b) => a.usedIn.localeCompare(b.usedIn) || a.fn.localeCompare(b.fn))) {
        console.error(`  ${x.usedIn} needs ${x.fn} from ${x.defIn}`);
    }
    process.exit(1);
}
console.log("All cross-module imports OK");

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function load(name, fallback = []) {
  const fp = path.join(DATA_DIR, name + ".json");
  if (!fs.existsSync(fp)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function loadMap(name) {
  const data = load(name, {});
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return {};
}

function save(name, data) {
  const fp = path.join(DATA_DIR, name + ".json");
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf8");
}

module.exports = { load, save, loadMap };

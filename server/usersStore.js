const { load, save, loadMap } = require("./store");
const { v4: uuidv4 } = require("uuid");

const USERS_FILE = "adminUsers";
const USER_DEVICES_FILE = "userDevices";

function getAllUsers() {
  return load(USERS_FILE) || [];
}

function saveUsers(users) {
  save(USERS_FILE, users || []);
}

function findUser(username) {
  if (!username) return null;
  const normalized = String(username).trim();
  const users = getAllUsers();
  return users.find((u) => String(u.username).trim() === normalized) || null;
}

function findUserById(id) {
  if (!id) return null;
  const users = getAllUsers();
  return users.find((u) => u.id === id) || null;
}

function createUser(data) {
  const users = getAllUsers();
  const id = data.id || `sub_${Date.now()}`;
  const user = {
    id,
    username: data.username,
    password: data.password,
    role: data.role || "sub",
    maxDevices: typeof data.maxDevices === "number" ? data.maxDevices : -1,
    expireAt: typeof data.expireAt === "number" ? data.expireAt : -1,
    disabled: !!data.disabled,
    createdAt: Date.now(),
  };
  users.push(user);
  saveUsers(users);
  return user;
}

function updateUser(id, data) {
  const users = getAllUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  const user = users[idx];
  Object.assign(user, data);
  users[idx] = user;
  saveUsers(users);
  return user;
}

function deleteUser(id) {
  let users = getAllUsers();
  users = users.filter((u) => u.id !== id);
  saveUsers(users);
}

function getUserDevices(userId) {
  if (!userId) return [];
  const map = loadMap(USER_DEVICES_FILE);
  return Array.isArray(map[userId]) ? map[userId].slice() : [];
}

/** 从 deviceHistory 持久化文件读取 owner（服务重启后仍能认领） */
function getOwnerMapFromHistory() {
  const map = new Map();
  const list = load("deviceHistory");
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    if (item && item.deviceId && item.owner) {
      map.set(String(item.deviceId), String(item.owner).trim());
    }
  }
  return map;
}

/** 按设备 owner 用户名补绑到子账号（内存 + 历史文件） */
function syncUserDevicesByOwner(userId, username, ownerByDeviceId) {
  if (!userId || !username) return 0;
  const normalized = String(username).trim();
  if (!normalized) return 0;

  const merged = new Map(getOwnerMapFromHistory());
  if (ownerByDeviceId) {
    for (const [deviceId, owner] of ownerByDeviceId.entries()) {
      if (owner) merged.set(String(deviceId), String(owner).trim());
    }
  }

  let added = 0;
  const bound = new Set(getUserDevices(userId).map(String));
  for (const [deviceId, owner] of merged.entries()) {
    if (owner !== normalized) continue;
    if (!bound.has(String(deviceId))) {
      bindDevice(userId, String(deviceId));
      bound.add(String(deviceId));
      added++;
    }
  }
  return added;
}

/**
 * 修复历史数据：按 deviceHistory.owner 把设备补绑到对应子账号（可同时保留 root）
 */
function repairSubDevicesFromRoot() {
  const ownerMap = getOwnerMapFromHistory();
  const users = getAllUsers().filter((u) => u.role === "sub");
  const byUsername = new Map(users.map((u) => [String(u.username).trim(), u]));
  let repaired = 0;

  for (const [deviceId, ownerName] of ownerMap.entries()) {
    const sub = byUsername.get(ownerName);
    if (!sub) continue;
    const subList = getUserDevices(sub.id).map(String);
    if (!subList.includes(String(deviceId))) {
      bindDevice(sub.id, String(deviceId));
      repaired++;
    }
  }
  return repaired;
}

/** 子账号登录/拉列表前调用：认领属于自己的全部设备 */
function claimDevicesForSubUser(user) {
  if (!user || user.role !== "sub" || !user.id || !user.username) return [];
  repairSubDevicesFromRoot();
  syncUserDevicesByOwner(user.id, user.username, null);
  return getUserDevices(user.id);
}

function bindDevice(userId, deviceId) {
  const map = loadMap(USER_DEVICES_FILE);

  // 子账号绑定的设备同时写入 root，管理员与子账号均可看到
  if (userId !== "root") {
    for (const u of getAllUsers()) {
      if (u.role !== "sub" || u.id === userId) continue;
      if (Array.isArray(map[u.id])) {
        map[u.id] = map[u.id].filter((d) => d !== deviceId);
      }
    }
    map.root = map.root || [];
    if (!map.root.includes(deviceId)) map.root.push(deviceId);
  }

  map[userId] = map[userId] || [];
  if (!map[userId].includes(deviceId)) map[userId].push(deviceId);
  save(USER_DEVICES_FILE, map);
  return map[userId];
}

function unbindDevice(userId, deviceId) {
  const map = loadMap(USER_DEVICES_FILE);
  if (!Array.isArray(map[userId])) return [];
  map[userId] = map[userId].filter((d) => d !== deviceId);
  save(USER_DEVICES_FILE, map);
  return map[userId];
}

/** 从所有账号（含 root、子账号）的绑定列表中移除设备 */
function removeDeviceFromAllUsers(deviceId) {
  const id = String(deviceId);
  const map = loadMap(USER_DEVICES_FILE);
  let changed = false;
  for (const uid of Object.keys(map)) {
    if (!Array.isArray(map[uid])) continue;
    const next = map[uid].filter((d) => String(d) !== id);
    if (next.length !== map[uid].length) {
      map[uid] = next;
      changed = true;
    }
  }
  if (changed) save(USER_DEVICES_FILE, map);
}

function findDeviceOwner(deviceId) {
  const map = loadMap(USER_DEVICES_FILE);
  let rootOwner = null;
  let subOwner = null;
  for (const [userId, list] of Object.entries(map)) {
    if (!Array.isArray(list) || !list.includes(deviceId)) continue;
    if (userId === "root") rootOwner = userId;
    else subOwner = userId;
  }
  // 历史数据可能同一设备重复挂在 root 与子账号下，优先返回子账号
  return subOwner || rootOwner || null;
}

function isDeviceOwnedBy(userId, deviceId) {
  if (!userId || !deviceId) return false;
  const list = getUserDevices(userId);
  return list.includes(deviceId);
}

module.exports = {
  getAllUsers,
  saveUsers,
  findUser,
  findUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserDevices,
  getOwnerMapFromHistory,
  syncUserDevicesByOwner,
  repairSubDevicesFromRoot,
  claimDevicesForSubUser,
  bindDevice,
  unbindDevice,
  removeDeviceFromAllUsers,
  findDeviceOwner,
  isDeviceOwnedBy,
};

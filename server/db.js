const mysql = require("mysql2/promise");

let pool = null;

async function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "root",
    database: process.env.DB_NAME || "fileserver",
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4",
  });
  return pool;
}

async function initDB() {
  const tmpPool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "root",
    waitForConnections: true,
    connectionLimit: 2,
    charset: "utf8mb4",
  });

  const dbName = process.env.DB_NAME || "fileserver";
  await tmpPool.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`
  );
  await tmpPool.query(`USE \`${dbName}\``);

  await tmpPool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(64) NOT NULL UNIQUE,
      device_name VARCHAR(128) DEFAULT '',
      model VARCHAR(64) DEFAULT '',
      status ENUM('online','offline') DEFAULT 'offline',
      current_file_id VARCHAR(64) DEFAULT '',
      current_step VARCHAR(64) DEFAULT '',
      last_online BIGINT DEFAULT 0,
      s3_access_key VARCHAR(256) DEFAULT '',
      s3_secret_key VARCHAR(256) DEFAULT '',
      s3_bucket VARCHAR(256) DEFAULT '',
      s3_endpoint VARCHAR(256) DEFAULT 's3.ap-east-1.amazonaws.com',
      s3_region VARCHAR(64) DEFAULT 'ap-east-1',
      cycle_seconds INT DEFAULT 300,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const addColSafe = async (table, col, def) => {
    try { await tmpPool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${col} ${def}`); } catch(_) {}
  };
  await addColSafe("devices", "s3_access_key", "VARCHAR(256) DEFAULT '' AFTER current_step");
  await addColSafe("devices", "s3_secret_key", "VARCHAR(256) DEFAULT '' AFTER s3_access_key");
  await addColSafe("devices", "s3_bucket", "VARCHAR(256) DEFAULT '' AFTER s3_secret_key");
  await addColSafe("devices", "s3_endpoint", "VARCHAR(256) DEFAULT 's3.ap-east-1.amazonaws.com' AFTER s3_bucket");
  await addColSafe("devices", "s3_region", "VARCHAR(64) DEFAULT 'ap-east-1' AFTER s3_endpoint");
  await addColSafe("devices", "cycle_seconds", "INT DEFAULT 300 AFTER s3_region");

  await tmpPool.query(`
    CREATE TABLE IF NOT EXISTS files (
      id INT AUTO_INCREMENT PRIMARY KEY,
      file_id VARCHAR(64) NOT NULL,
      device_id VARCHAR(64) DEFAULT 'all',
      directory VARCHAR(256) DEFAULT '',
      filename VARCHAR(256) DEFAULT '',
      remark VARCHAR(512) DEFAULT '',
      url VARCHAR(512) DEFAULT '',
      version INT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_file_device (file_id, device_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await tmpPool.query(`
    CREATE TABLE IF NOT EXISTS file_process (
      id INT AUTO_INCREMENT PRIMARY KEY,
      file_id VARCHAR(64) NOT NULL,
      device_id VARCHAR(64) NOT NULL,
      version INT DEFAULT 0,
      status ENUM('pending','downloading','preprocessing','processing','uploading_s3','done','error') DEFAULT 'pending',
      error_msg TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_fp (file_id, device_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await tmpPool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      device_id VARCHAR(64) DEFAULT '',
      level ENUM('info','warn','error') DEFAULT 'info',
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_device (device_id),
      INDEX idx_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await tmpPool.end();
  console.log("[DB] Database and tables initialized");
}

module.exports = { getPool, initDB };

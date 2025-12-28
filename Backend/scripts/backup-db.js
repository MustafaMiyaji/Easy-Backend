#!/usr/bin/env node

/**
 * MongoDB Backup Script
 *
 * This script creates automated backups of the MongoDB database using mongodump.
 * Backups are stored with timestamps and old backups are automatically cleaned up.
 *
 * Usage:
 *   node backup-db.js               # Create backup now
 *   node backup-db.js --restore     # List available backups for restoration
 *   node backup-db.js --restore <backup-name>  # Restore specific backup
 *
 * Requirements:
 *   - MongoDB tools (mongodump/mongorestore) must be installed
 *   - DB_CONNECTION_STRING in .env file
 */

const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const logger = require("../config/logger");

// Configuration
const BACKUP_DIR = path.join(__dirname, "..", "backups");
const DB_URI =
  process.env.DB_CONNECTION_STRING || "mongodb://127.0.0.1:27017/easy_app";
const RETENTION_DAYS = 7; // Keep backups for 7 days
const MAX_BACKUPS = 14; // Maximum number of backups to keep
const MAX_RETRIES = parseInt(process.env.BACKUP_MAX_RETRIES || "3", 10);
const RETRY_BASE_DELAY_MS = 3000;

// Conservative mongodump options to reduce connection load on Atlas
const MONGODUMP_OPTS = [
  "--readPreference=secondaryPreferred",
  "--numParallelCollections=1",
  "--gzip",
  "--ssl",
  "--quiet",
];

// Parse database name from connection string
function getDatabaseName(uri) {
  const match = uri.match(/\/([^\/?]+)(\?|$)/);
  return match ? match[1] : null;
}

// Prefer explicit DB_NAME env; fallback to parse from URI; leave undefined if absent
const DB_NAME = process.env.DB_NAME || getDatabaseName(DB_URI) || null;

// Ensure backup directory exists
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    logger.info(`Created backup directory: ${BACKUP_DIR}`);
  }
}

// Generate backup filename with timestamp
function generateBackupName() {
  const date = new Date();
  const timestamp = date
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\..+/, "")
    .replace("T", "_");
  const namePart = DB_NAME || "database";
  return `backup_${namePart}_${timestamp}`;
}

// Check if mongodump is installed
async function checkMongoDumpInstalled() {
  try {
    await execCommand("mongodump --version");
    return true;
  } catch (error) {
    return false;
  }
}

// Execute shell command with promise and timeout
function execCommand(command, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const child = exec(command, { shell: '/bin/bash', timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const fullError = new Error(`${error.message}\n${stderr || ''}`);
        fullError.stderr = stderr;
        fullError.code = error.code;
        reject(fullError);
        return;
      }
      resolve({ stdout, stderr });
    });
    // Also log any real-time output for debugging
    if (child.stdout) {
      child.stdout.on('data', (data) => {
        if (process.env.DEBUG_BACKUP) {
          logger.debug(`mongodump output: ${data}`);
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (data) => {
        logger.warn(`mongodump stderr: ${data}`);
      });
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Append connection options to URI for timeouts/selection
function withExtraUriOptions(uri) {
  const extra = "connectTimeoutMS=20000&socketTimeoutMS=600000&serverSelectionTimeoutMS=20000";
  return uri.includes("?") ? `${uri}&${extra}` : `${uri}?${extra}`;
}

// Build mongodump command string with tuned options
// NOTE: NOT using --db to dump all databases (safer full backup for restoration)
function buildDumpCommand(backupPath) {
  const dumpUri = withExtraUriOptions(DB_URI);
  const escapedUri = dumpUri.replace(/"/g, '\\"');
  const escapedOut = backupPath.replace(/"/g, '\\"');
  const args = [
    "mongodump",
    `--uri="${escapedUri}"`,
    `--out="${escapedOut}"`,
    ...MONGODUMP_OPTS,
  ];
  return args.join(" ");
}

// Run mongodump with retry/backoff to handle transient Atlas handshake errors
async function runDumpWithRetries(command) {
  logger.debug(`Executing mongodump: ${command}`);
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Backup attempt ${attempt}/${MAX_RETRIES}`);
      await execCommand(command);
      logger.info("✅ mongodump completed successfully");
      return;
    } catch (error) {
      lastError = error;
      const delay = RETRY_BASE_DELAY_MS * attempt;
      logger.warn(
        `Backup attempt ${attempt} failed: ${error.message || "unknown"}${
          error.stderr ? ` | stderr: ${error.stderr}` : ""
        }. Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

// Create database backup
async function createBackup() {
  try {
    // Check if mongodump is installed
    const isInstalled = await checkMongoDumpInstalled();
    if (!isInstalled) {
      const errorMsg = `
❌ MongoDB Database Tools not installed!

To use automatic backups, you need to install mongodump:

Windows:
1. Download from: https://www.mongodb.com/try/download/database-tools
2. Extract the zip file
3. Add the bin folder to your PATH environment variable
4. Restart terminal and verify: mongodump --version

Alternative (MongoDB Compass):
If you have MongoDB Compass installed, mongodump might be at:
C:\\Program Files\\MongoDB\\Tools\\100\\bin\\mongodump.exe
Add this path to your system PATH.

Linux/Mac:
brew install mongodb-database-tools
OR
sudo apt-get install mongodb-database-tools

Until mongodump is installed, automatic backups are DISABLED.
You can still backup manually using MongoDB Compass or Atlas.
`;
      logger.error(errorMsg);
      throw new Error(
        "mongodump not installed - see installation instructions above"
      );
    }

    ensureBackupDir();

    const backupName = generateBackupName();
    const backupPath = path.join(BACKUP_DIR, backupName);

    logger.info(`Starting database backup: ${backupName}`);
    logger.info(`Database: ${DB_NAME}`);
    logger.info(`Backup location: ${backupPath}`);

  // Build mongodump command with conservative options
  const command = buildDumpCommand(backupPath);

  // Execute backup with retries for transient connection issues
  await runDumpWithRetries(command);

    // Check if backup was successful - mongodump creates subdirectories for each database
    // So check if output directory exists AND has content (at least one subdirectory)
    const backupSuccess =
      fs.existsSync(backupPath) &&
      fs.readdirSync(backupPath).length > 0;

    if (backupSuccess) {
      const backupSize = getDirectorySize(backupPath);
      logger.info(`✅ Backup completed successfully`);
      logger.info(`   Backup name: ${backupName}`);
      logger.info(`   Size: ${formatBytes(backupSize)}`);

      // Cleanup old backups
      await cleanupOldBackups();

      return backupName;
    } else {
      throw new Error("Backup directory was not created or is empty");
    }
  } catch (error) {
    logger.error(`❌ Backup failed: ${error.message}`);
    throw error;
  }
}

// Get directory size recursively
function getDirectorySize(dirPath) {
  let totalSize = 0;

  function calculateSize(itemPath) {
    const stats = fs.statSync(itemPath);

    if (stats.isFile()) {
      totalSize += stats.size;
    } else if (stats.isDirectory()) {
      const items = fs.readdirSync(itemPath);
      items.forEach((item) => {
        calculateSize(path.join(itemPath, item));
      });
    }
  }

  calculateSize(dirPath);
  return totalSize;
}

// Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

// Clean up old backups
async function cleanupOldBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;

    const backups = fs
      .readdirSync(BACKUP_DIR)
      .filter((name) => name.startsWith("backup_"))
      .map((name) => {
        const backupPath = path.join(BACKUP_DIR, name);
        const stats = fs.statSync(backupPath);

        // Prefer parsing the timestamp from the folder name (more reliable than birthtime)
        let created = stats.mtime || stats.birthtime || new Date();
        try {
          const match = name.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
          if (match) {
            const [, year, month, day, hour, minute, second] = match;
            created = new Date(
              parseInt(year, 10),
              parseInt(month, 10) - 1,
              parseInt(day, 10),
              parseInt(hour, 10),
              parseInt(minute, 10),
              parseInt(second, 10)
            );
          }
        } catch (err) {
          // Fallback already set above
        }

        return {
          name,
          path: backupPath,
          created,
          size: getDirectorySize(backupPath),
        };
      })
      .sort((a, b) => b.created - a.created); // Sort newest first

    const now = new Date();
    let deleted = 0;

    // Delete backups older than retention days or exceeding max count
    for (let i = 0; i < backups.length; i++) {
      const backup = backups[i];
      const age = (now - backup.created) / (1000 * 60 * 60 * 24); // days

      if (age > RETENTION_DAYS || i >= MAX_BACKUPS) {
        logger.info(
          `Deleting old backup: ${backup.name} (${age.toFixed(1)} days old)`
        );
        fs.rmSync(backup.path, { recursive: true, force: true });
        deleted++;
      }
    }

    if (deleted > 0) {
      logger.info(`🗑️  Cleaned up ${deleted} old backup(s)`);
    }

    logger.info(`📊 Total backups: ${backups.length - deleted}`);
  } catch (error) {
    logger.error(`Cleanup error: ${error.message}`);
  }
}

// List all available backups
function listBackups() {
  ensureBackupDir();

  const backups = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith("backup_"))
    .map((name) => {
      const backupPath = path.join(BACKUP_DIR, name);
      const stats = fs.statSync(backupPath);
      return {
        name,
        created: stats.birthtime,
        size: getDirectorySize(backupPath),
      };
    })
    .sort((a, b) => b.created - a.created);

  if (backups.length === 0) {
    console.log("No backups found.");
    return [];
  }

  console.log("\n📦 Available Backups:\n");
  backups.forEach((backup, i) => {
    console.log(`${i + 1}. ${backup.name}`);
    console.log(`   Created: ${backup.created.toLocaleString()}`);
    console.log(`   Size: ${formatBytes(backup.size)}\n`);
  });

  return backups;
}

// Restore database from backup
async function restoreBackup(backupName) {
  try {
    const backupPath = path.join(BACKUP_DIR, backupName, DB_NAME);

    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup not found: ${backupName}`);
    }

    logger.warn(`⚠️  CAUTION: This will replace the current database!`);
    logger.info(`Restoring from backup: ${backupName}`);

    // Build mongorestore command (drop existing collections)
    const command = `mongorestore --uri="${DB_URI}" --drop "${backupPath}"`;

    // Execute restore
    await execCommand(command);

    logger.info(`✅ Database restored successfully from ${backupName}`);
  } catch (error) {
    logger.error(`❌ Restore failed: ${error.message}`);
    throw error;
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  try {
    if (args.includes("--restore")) {
      // Restore mode
      const backupIndex = args.indexOf("--restore");
      const backupName = args[backupIndex + 1];

      if (!backupName) {
        // List backups for selection
        listBackups();
        console.log("Usage: node backup-db.js --restore <backup-name>");
      } else {
        await restoreBackup(backupName);
      }
    } else if (args.includes("--list")) {
      // List mode
      listBackups();
    } else {
      // Default: Create backup
      await createBackup();
    }
  } catch (error) {
    logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

// Export for use as module
module.exports = {
  createBackup,
  restoreBackup,
  listBackups,
  cleanupOldBackups,
};

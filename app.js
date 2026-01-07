const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// ========================================
// WINSTON LOGGER
// ========================================
const logger = require("./config/logger");

// ========================================
// SENTRY ERROR MONITORING
// ========================================
const Sentry = require("@sentry/node");
const { ProfilingIntegration } = require("@sentry/profiling-node");

// Initialize Sentry BEFORE anything else
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    integrations: [new ProfilingIntegration()],
    // Performance Monitoring
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0, // 10% in prod, 100% in dev
    // Profiling
    profilesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  });
  logger.info("🔍 Sentry error monitoring initialized");
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const cron = require("node-cron");

const productsRouter = require("./routes/products");
const ordersRouter = require("./routes/orders");
const cartRouter = require("./routes/cart");
const restaurantsRouter = require("./routes/restaurants");
const restaurantManageRouter = require("./routes/restaurant_manage");
const clientsRouter = require("./routes/clients");
const sellerRouter = require("./routes/seller");
const adminRouter = require("./routes/admin");
const authRouter = require("./routes/auth");
const tokensRouter = require("./routes/tokens");
const usersRouter = require("./routes/users");
const deliveryRouter = require("./routes/delivery");
const uploadsRouter = require("./routes/uploads");
const reviewsRouter = require("./routes/reviews");
const wishlistRouter = require("./routes/wishlist");

const app = express();

// Trust proxy for Cloud Run (trust the first proxy - Google Load Balancer)
// Using 1 instead of true to be more specific for express-rate-limit
app.set("trust proxy", 1);

// ========================================
// SECURITY MIDDLEWARE (CRITICAL FIXES)
// ========================================

// 1. Security Headers - Helmet
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: [
          "'self'",
          "https://maps.googleapis.com",
          "https://firebaseinstallations.googleapis.com",
        ],
      },
    },
    crossOriginEmbedderPolicy: false, // Allow Firebase and Google Maps
  })
);

// 2. CORS - Restricted Origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : [
      "http://localhost:3000",
      "http://192.168.1.76:3000",
      "https://easy-backend-785621869568.asia-south1.run.app",
    ];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        logger.warn(`🚫 CORS blocked origin: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    maxAge: 86400, // 24 hours
  })
);

// 3. Global Rate Limiting (more generous for development, stricter for production)
const isDevelopment = process.env.NODE_ENV !== "production";
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window (shorter window, easier to recover)
  max: isDevelopment ? 500 : 300, // Dev: 500/min, Prod: 300/min (normal users won't hit this)
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  // Validate trust proxy configuration for Cloud Run
  validate: { trustProxy: false }, // Disable the validation warning
  // Skip rate limiting for SSE endpoints (they need persistent connections)
  skip: (req) => {
    return req.path.includes("/sse/") || req.path.includes("/stream");
  },
});
app.use("/api/", globalLimiter);

// 4. Auth Rate Limiting (20 failed attempts per 15 minutes)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === "test" ? 1000 : 20, // Increased from 5 to 20 for normal users
  skipSuccessfulRequests: true, // Only count failed attempts
  message: "Too many login attempts, please try again later.",
  validate: { trustProxy: false }, // Disable the validation warning
});

// Apply to auth routes
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);

// 5. Body Parser
app.use(express.json({ limit: "10mb" })); // Limit payload size
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// ========================================
// SENTRY REQUEST HANDLER (Must be BEFORE routes)
// ========================================
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

// --- Firebase Admin Initialization ---
// Looks for explicit service account json via GOOGLE_APPLICATION_CREDENTIALS.
// If not provided, attempts to load a local file name pattern in project root.
// (The actual JSON file should be gitignored and not committed.)
let adminSdkInitialized = false;
try {
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    let credentials = null;

    // Try to parse GOOGLE_APPLICATION_CREDENTIALS if it's JSON content (from Secret Manager)
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      try {
        // First try to treat it as JSON string (Cloud Run secret injection)
        const credsStr = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        if (credsStr.startsWith("{")) {
          credentials = JSON.parse(credsStr);
          logger.debug(
            "Parsed GOOGLE_APPLICATION_CREDENTIALS from JSON string"
          );
        } else {
          // If not JSON, try to require it as a file path
          credentials = require(credsStr);
        }
      } catch (parseError) {
        logger.warn(
          `Failed to parse GOOGLE_APPLICATION_CREDENTIALS: ${parseError.message}`
        );
      }
    }

    // Initialize with parsed credentials if available
    if (credentials) {
      admin.initializeApp({
        credential: admin.credential.cert(credentials),
      });
      adminSdkInitialized = true;
      logger.info("🔐 Firebase Admin initialized with credentials");
    } else {
      // Fallback: try to locate a file that matches firebase admin sdk naming
      const fs = require("fs");
      const path = require("path");
      const candidate = path.join(
        __dirname,
        process.env.FIREBASE_SERVICE_ACCOUNT || "serviceAccount.json"
      );
      if (fs.existsSync(candidate)) {
        admin.initializeApp({
          credential: admin.credential.cert(require(candidate)),
        });
        adminSdkInitialized = true;
        logger.info("🔐 Firebase Admin initialized from local file");
      } else {
        // Try scanning for any *firebase-adminsdk*.json under Backend directory (gitignored locally)
        const files = fs
          .readdirSync(__dirname)
          .filter(
            (f) =>
              f.toLowerCase().endsWith(".json") &&
              f.toLowerCase().includes("firebase-adminsdk")
          );
        if (files.length > 0) {
          const saPath = path.join(__dirname, files[0]);
          admin.initializeApp({
            credential: admin.credential.cert(require(saPath)),
          });
          adminSdkInitialized = true;
          logger.info(
            `🔐 Firebase Admin initialized from detected service account file: ${files[0]}`
          );
        } else {
          // Last resort: initialize with application default (works if running in GCP env)
          // Note: This will attempt to contact the GCP metadata server and will fail with ENOTFOUND locally.
          admin.initializeApp();
          adminSdkInitialized = true;
          logger.warn(
            "⚠️ Firebase Admin falling back to Application Default Credentials. Set GOOGLE_APPLICATION_CREDENTIALS or place a service account JSON in Backend/."
          );
        }
      }
    }
  } else {
    // Admin already initialized (happens if this file is required multiple times)
    adminSdkInitialized = true;
  }
  // Expose for later modules if needed
  global.firebaseAdmin = admin;
} catch (e) {
  logger.warn(
    "⚠️ Firebase Admin not initialized (library missing or invalid credentials) - token verification disabled. Error:",
    e.message
  );
}

// Simple middleware to optionally verify Firebase ID token and attach decoded user
async function verifyFirebaseIdToken(req, res, next) {
  if (!adminSdkInitialized) return next();
  const authHeader = req.headers.authorization || "";
  const m = authHeader.match(/^Bearer (.+)$/i);
  if (!m) return next();
  const token = m[1];
  try {
    const decoded = await global.firebaseAdmin.auth().verifyIdToken(token);
    req.firebaseUser = decoded; // attach for downstream handlers
  } catch (err) {
    // Silently ignore invalid tokens to keep public endpoints accessible
  }
  next();
}
app.use(verifyFirebaseIdToken);

// ========================================
// REDIS INITIALIZATION (OPTIONAL)
// ========================================
const { initRedis, isRedisAvailable } = require("./middleware/cache");

// Initialize Redis (non-blocking, won't crash if Redis is unavailable)
initRedis()
  .then(() => {
    if (isRedisAvailable()) {
      logger.info("✅ Redis caching enabled");
    } else {
      logger.warn("⚠️ Redis not available - caching disabled");
    }
  })
  .catch((err) => {
    logger.warn(
      "⚠️ Redis initialization failed - caching disabled:",
      err.message
    );
  });

// Health endpoints
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    firebaseAdmin: adminSdkInitialized,
    redis: isRedisAvailable(),
  });
});

// API routes
app.use("/api/products", productsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/cart", cartRouter);
app.use("/api/restaurants", restaurantsRouter);
app.use("/api/restaurant-manage", restaurantManageRouter);
app.use("/api/clients", clientsRouter);
// Seller routes include products, orders, and SSE stream under /api/seller
app.use("/api/seller", sellerRouter);
app.use("/api/admin", adminRouter);
app.use("/api/auth", authRouter);
app.use("/api/tokens", tokensRouter);
app.use("/api/users", usersRouter);
app.use("/api/delivery", deliveryRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/wishlist", wishlistRouter);

// ========================================
// APP VERSION ENDPOINT
// ========================================
app.get("/api/app-version", (req, res) => {
  // Return minimum required app version
  // Update these values when you want to force users to update
  res.json({
    minVersion: "1.0.5", // Minimum version name required
    minBuildNumber: 10, // Minimum build number required
    latestVersion: "1.0.5", // Latest version available
    latestBuildNumber: 10, // Latest build number
    updateRequired: false, // Set to true to force immediate update for all users
    updateMessage:
      "A new version is available with bug fixes and improvements.",
  });
});

// ========================================
// MANUAL BACKUP TRIGGER (Admin only - for testing)
// ========================================
app.post("/api/admin/backup-now", async (req, res) => {
  try {
    logger.info("📦 Manual backup triggered via API");
    // Use GCS-enabled backup script so daily backups are uploaded to Cloud Storage
    const { createBackup } = require("./scripts/backup-db-gcs");
    const backupName = await createBackup();
    res.json({
      success: true,
      message: "Backup completed successfully",
      backupName,
    });
  } catch (error) {
    logger.error("Manual backup failed:", error.message);
    res.status(500).json({
      success: false,
      error: "Backup failed: " + error.message,
    });
  }
});

// Endpoint to manually validate a token (debug): client sends Authorization: Bearer <idToken>
app.get("/api/auth/debug/verify-token", (req, res) => {
  if (!adminSdkInitialized)
    return res.status(503).json({ error: "Firebase Admin not initialized" });
  if (!req.firebaseUser)
    return res.status(401).json({ error: "No valid token provided" });
  res.json({ decoded: req.firebaseUser });
});

// ========================================
// SENTRY ERROR HANDLER (Must be AFTER routes, BEFORE other error handlers)
// ========================================
if (process.env.SENTRY_DSN) {
  app.use(
    Sentry.Handlers.errorHandler({
      shouldHandleError(error) {
        // Capture all errors with status code >= 500
        if (error.status >= 500) {
          return true;
        }
        // Also capture specific errors
        if (error.name === "UnauthorizedError" || error.name === "MongoError") {
          return true;
        }
        return false;
      },
    })
  );
}

// Generic error handler (fallback)
app.use((err, req, res, next) => {
  logger.logError(err, {
    url: req.originalUrl,
    method: req.method,
    ip: req.ip,
  });

  // Send error response
  res.status(err.status || 500).json({
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
});

const uri =
  process.env.DB_CONNECTION_STRING || "mongodb://127.0.0.1:27017/easy_app";
let port = Number(process.env.PORT || 8080);

async function start() {
  // Start MongoDB connection in the background (non-blocking)
  // This allows server to start even if MongoDB is temporarily unavailable
  const connectMongoDB = async () => {
    try {
      await mongoose.connect(uri, { 
        serverSelectionTimeoutMS: 10000,  // 10 second timeout for server selection
        connectTimeoutMS: 10000            // 10 second connection timeout
      });
      logger.info("✅ Connected to MongoDB");
    } catch (mongoErr) {
      logger.warn("⚠️ MongoDB connection failed (will retry):", mongoErr.message);
      // Retry after 5 seconds
      setTimeout(connectMongoDB, 5000);
    }
  };
  
  // Start connection attempt without waiting (non-blocking)
  connectMongoDB().catch(err => logger.error("MongoDB background connection error:", err));

  try {

    // Start cron job for checking order assignment timeouts (runs every 5 minutes)
    // Increased interval to prevent overlapping executions and reduce database load
    let cronJobRunning = false; // Prevent overlapping executions
    let lastCronRun = null;

    cron.schedule(
      "*/5 * * * *",
      async () => {
        // Skip if previous job still running
        if (cronJobRunning) {
          logger.warn(
            "⏰ Skipping cron job - previous execution still in progress"
          );
          return;
        }

        cronJobRunning = true;
        const startTime = Date.now();
        lastCronRun = new Date();

        try {
          const axios = require("axios");

          // PART 1: Check timeouts for assigned orders (existing functionality)
          const timeoutResponse = await axios.post(
            `http://localhost:${port}/api/delivery/check-timeouts`,
            {},
            { timeout: 25000 } // 25 second timeout (leave buffer before next cron)
          );
          const timeoutData = timeoutResponse.data;
          if (timeoutData.timedOutOrders > 0) {
            logger.info(
              `⏰ Timeout Check: ${timeoutData.timedOutOrders} orders found, ${timeoutData.reassignedCount} reassigned`
            );
          }

          // PART 2: Retry abandoned pending orders (new functionality)
          const retryResponse = await axios.post(
            `http://localhost:${port}/api/delivery/retry-pending-orders`,
            {},
            { timeout: 25000 } // 25 second timeout
          );
          const retryData = retryResponse.data;
          if (retryData.assigned > 0 || retryData.escalated > 0) {
            logger.info(
              `🔄 Pending Retry: ${retryData.assigned} assigned, ${retryData.escalated} escalated (${retryData.total_pending} total pending)`
            );
          }

          const duration = Date.now() - startTime;
          if (duration > 120000) {
            // Warn if taking more than 2 minutes
            logger.warn(`⏰ Cron job took ${(duration / 1000).toFixed(1)}s`);
          }
        } catch (error) {
          // Only log if it's not a connection error (server not ready yet)
          if (error.code !== "ECONNREFUSED") {
            logger.error("⏰ Cron job failed:", error.message);
          }
        } finally {
          cronJobRunning = false; // Always release lock
        }
      },
      {
        scheduled: true,
        timezone: "UTC",
      }
    );
    logger.info(
      "⏰ Cron job scheduled: Checking order timeouts & retrying pending orders every 5 minutes"
    );

    // ========================================
    // AUTOMATED DATABASE BACKUP (Daily at 2 AM)
    // ========================================
    const { createBackup } = require("./scripts/backup-db-gcs");

    cron.schedule("0 2 * * *", async () => {
      try {
        logger.info("🗄️  Starting automated daily database backup to GCS...");
        const result = await createBackup();
        logger.info(`✅ Automated backup completed: ${result.backupName}`);
        if (result.gcs) {
          logger.info(
            `📤 Backup uploaded to GCS: ${result.gcs.uploadCount} files`
          );
        }
      } catch (error) {
        logger.error("❌ Automated backup failed:", error);
        logger.error("❌ Backup error stack:", error.stack);
        // Send alert notification here if needed (email/SMS)
      }
    });
    logger.info(
      "🗄️  Automated backup scheduled: Daily at 2:00 AM (uploads to GCS)"
    );

    const startListen = () =>
      app
        .listen(port, () => {
          const os = require("os");
          const nets = os.networkInterfaces();
          let lan = null;
          for (const name of Object.keys(nets)) {
            for (const net of nets[name] || []) {
              if (net.family === "IPv4" && !net.internal) {
                lan = net.address;
                break;
              }
            }
            if (lan) break;
          }

          const localUrl = `http://localhost:${port}`;
          const lanUrl = lan ? `http://${lan}:${port}` : null;

          logger.info("🚀 Server running");
          logger.info(`   • Local:   ${localUrl}`);
          if (lanUrl) logger.info(`   • Network: ${lanUrl}`);
          else logger.info("   • Network: (no active IPv4 adapter detected)");
        })
        .on("error", (err) => {
          if (err && err.code === "EADDRINUSE") {
            const old = port;
            port = port + 1;
            logger.warn(`⚠️ Port ${old} in use. Retrying on port ${port}...`);
            setTimeout(() => startListen(), 250);
          } else {
            logger.error("❌ Failed to bind server:", err);
            process.exit(1);
          }
        });
    startListen();
  } catch (err) {
    logger.error("❌ Failed to start cron/backup jobs:", err);
    // Don't exit - server should still run even if cron fails to init
  }
}

// Export app for testing
module.exports = app;

// Only start server if not in test mode
if (require.main === module) {
  start();
}

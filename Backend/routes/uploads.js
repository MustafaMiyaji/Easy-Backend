const express = require("express");
const multer = require("multer");
const { GridFSBucket } = require("mongodb");
const mongoose = require("mongoose");
const { optimizeImage } = require("../middleware/imageOptimization");
const { getCDNUrl, setCacheHeaders } = require("../middleware/cdn");

const router = express.Router();
const MAX_SIZE = Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
});

// POST /api/uploads (multipart/form-data; field: file)
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "file is required" });
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(415).json({ error: "unsupported media type" });
    }

    // Optimize image before uploading
    let imageBuffer = req.file.buffer;
    const originalSize = imageBuffer.length;
    try {
      imageBuffer = await optimizeImage(imageBuffer, {
        width: 1200,
        height: 1200,
        quality: 90,
        format: "jpeg",
      });
      const optimizedSize = imageBuffer.length;
      const savedPercent = ((1 - optimizedSize / originalSize) * 100).toFixed(
        1
      );
      console.log(
        `📸 Image optimized: ${(originalSize / 1024).toFixed(2)}KB → ${(
          optimizedSize / 1024
        ).toFixed(2)}KB (saved ${savedPercent}%)`
      );
    } catch (err) {
      console.error("Image optimization failed, using original:", err);
      // Continue with original if optimization fails
    }

    const db = mongoose.connection.db;
    const bucket = new GridFSBucket(db, { bucketName: "uploads" });
    const filename = `${Date.now()}_${(
      req.file.originalname || "image"
    ).replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
    const contentType = req.file.mimetype || "application/octet-stream";
    const uploadStream = bucket.openUploadStream(filename, { contentType });
    uploadStream.on("error", (err) => {
      console.error("GridFS upload error", err);
      res.status(500).json({ error: "failed to upload" });
    });
    uploadStream.on("finish", () => {
      // finish does not pass the file doc; use the stream's id
      const id = uploadStream.id?.toString?.() || `${uploadStream.id}`;
      const endpointPath = `/api/uploads/${id}`;
      const url = getCDNUrl(endpointPath);
      res.json({
        ok: true,
        id,
        filename,
        contentType,
        url,
        optimized: true,
      });
    });
    // Write after listeners are attached (use optimized buffer)
    uploadStream.end(imageBuffer);
  } catch (e) {
    console.error("upload route error", e);
    res.status(500).json({ error: "upload failed" });
  }
});

// GET /api/uploads/:id - streams the image back with CDN headers
router.get("/:id", setCacheHeaders("images"), async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const id = new ObjectId(req.params.id);
    const db = mongoose.connection.db;
    const bucket = new GridFSBucket(db, { bucketName: "uploads" });
    const dl = bucket.openDownloadStream(id);
    dl.on("file", (file) => {
      if (file?.contentType) res.setHeader("Content-Type", file.contentType);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
    });
    dl.on("error", () => res.status(404).json({ error: "not found" }));
    dl.pipe(res);
  } catch (e) {
    res.status(400).json({ error: "invalid id" });
  }
});

module.exports = router;

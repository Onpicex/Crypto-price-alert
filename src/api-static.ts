import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

// Simple static file server
export function serveStatic(req, res, next) {
  let filePath = req.path;
  
  // Default to index.html
  if (filePath === "/" || filePath === "") {
    filePath = "/index.html";
  }
  
  const fullPath = path.join(PUBLIC_DIR, filePath);
  
  // Security: prevent directory traversal
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return res.status(403).send("Forbidden");
  }
  
  // Check if file exists
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).send("Not found");
  }
  
  // Determine content type
  const ext = path.extname(fullPath).toLowerCase();
  const contentTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };
  
  const contentType = contentTypes[ext] || "application/octet-stream";
  
  // Read and serve
  const content = fs.readFileSync(fullPath);
  res.setHeader("Content-Type", contentType);
  res.send(content);
}

const fs = require("fs");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

function serveStatic(req, res, next) {
  let filePath = req.path;
  
  if (filePath === "/" || filePath === "") {
    filePath = "/index.html";
  }
  
  const fullPath = path.join(PUBLIC_DIR, filePath);
  
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return res.status(403).send("Forbidden");
  }
  
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return res.status(404).send("Not found");
  }
  
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
  
  const content = fs.readFileSync(fullPath);
  res.setHeader("Content-Type", contentType);
  res.send(content);
}

module.exports = { serveStatic };

// Minimal static server for local previews: node serve.cjs <folder> <port>
const http = require("http")
const fs = require("fs")
const path = require("path")
const root = path.resolve(process.argv[2])
const port = Number(process.argv[3] || 4792)
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" }
http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html"
    const file = path.join(root, rel)
    if (!file.startsWith(root)) {
      res.writeHead(403)
      return res.end()
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" })
      res.end(data)
    })
  })
  .listen(port, "127.0.0.1", () => console.log("serving " + root + " on " + port))

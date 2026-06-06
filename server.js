const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend assets cleanly from directories
app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/js", express.static(path.join(__dirname, "js")));

// Bind and route any API endpoints dynamically to their corresponding file in /api
app.all("/api/:route", async (req, res) => {
  const routeName = req.params.route;
  try {
    const handlerPath = path.join(__dirname, "api", `${routeName}.js`);
    
    // Clear cache in development mode so code changes hot-reload
    if (process.env.NODE_ENV !== "production") {
      delete require.cache[require.resolve(handlerPath)];
    }

    const handler = require(handlerPath);
    if (typeof handler === "function") {
      await handler(req, res);
    } else if (handler && typeof handler.default === "function") {
      await handler.default(req, res);
    } else {
      res.status(404).json({ error: `API route /api/${routeName} has no handler callback.` });
    }
  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") {
      res.status(404).json({ error: `API route /api/${routeName} not found.` });
    } else {
      console.error(`Error processing API route /api/${routeName}:`, err);
      res.status(500).json({ error: err.message || "Internal Server Error" });
    }
  }
});

// Serve root-level files like favicon or specific assets
app.use(express.static(path.join(__dirname)));

// Single Page Application fallback - always route traffic to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});

require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const axios = require("axios");
const { Server } = require("socket.io");

// ============================================
// SETUP
// ============================================

const app = express();

app.use(cors({ origin: "*" }));

// BGP DEBUG ROUTE PARSER
app.use("/bgp-debug", express.text({ type: "*/*" }));

app.use(express.json({ limit: "10mb" }));

mongoose
  .connect("mongodb://127.0.0.1:27017/noc")
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ============================================
// SCHEMA & MODEL — Events (existing)
// ============================================

const EventSchema = new mongoose.Schema(
  {
    device_id: Number,
    hostname: String,
    alert: String,
    alert_key: String,
    type: String,
    date: String,
    last_seen: {
      type: Date,
      default: Date.now,
    },
    history: {
      type: [Date],
      default: [],
    },
    count: {
      type: Number,
      default: 1,
    },
    status: {
      type: String,
      default: "down",
    },
  },
  {
    timestamps: true,
  }
);

EventSchema.index(
  {
    device_id: 1,
    type: 1,
    alert_key: 1,
    date: 1,
  },
  {
    unique: true,
  }
);

const Event = mongoose.model("Event", EventSchema);

// ============================================
// SCHEMA & MODEL — BGP Alerts (new)
// ============================================

const BgpAlertSchema = new mongoose.Schema(
  {
    hostname: String,
    ip: String,
    location: String,
    alert: String,
    severity: String,
    device_uptime: String,
    peers: [
      {
        peer_id: String,
        peer_address: String,
        admin_status: String,
        remote_as: String,
        asn_name: String,
        peer_state: String,
        peer_uptime: Number,
        last_error_code: String,
        last_error_subcode: String,
        description: String,
      },
    ],
    last_seen: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

BgpAlertSchema.index({ hostname: 1 }, { unique: true });

const BgpAlert = mongoose.model("BgpAlert", BgpAlertSchema);

// ============================================
// HELPERS
// ============================================

const todayStr = () =>
  new Date().toISOString().slice(0, 10);

const isRecoveryAlert = (alertText = "") => {
  const lower = alertText.toLowerCase();

  return (
    lower.includes("recovered") ||
    lower.includes("resolved") ||
    lower.includes("back to normal") ||
    lower.includes("cleared")
  );
};

// ============================================
// HTTP + SOCKET.IO
// ============================================

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

// ============================================
// LOGIN API
// ============================================

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.NOC_USER &&
    password === process.env.NOC_PASS
  ) {
    return res.json({
      success: true,
    });
  }

  return res.status(401).json({
    success: false,
    message: "Invalid username or password",
  });
});

// ============================================
// LIBRENMS ALERT PROXY
// ============================================

app.get("/alerts", async (_req, res) => {
  try {
    const response = await axios.get(
      process.env.LIBRENMS_URL,
      {
        headers: {
          "X-Auth-Token":
            process.env.LIBRENMS_TOKEN,
        },
        timeout: 15000,
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error(
      "❌ LibreNMS fetch error:",
      err.message
    );

    res.status(500).json({
      error: err.message,
    });
  }
});

// ============================================
// EVENT ROUTES (existing)
// ============================================

// POST /event

app.post("/event", async (req, res) => {
  const {
    device_id,
    hostname,
    alert,
    type,
  } = req.body;

  try {
    const now = new Date();

    const alert_key = (alert || "")
      .toLowerCase()
      .trim()
      .slice(0, 100);

    const recovery = isRecoveryAlert(alert);

    const existing = await Event.findOne({
      device_id,
      type,
      alert_key,
      date: todayStr(),
    });

    if (existing) {
      if (recovery) {
        existing.status = "up";
        existing.last_seen = now;

        await existing.save();

        io.emit("event-update", existing);

        return res.json(existing);
      }

      const lastTime =
        existing.history.at(-1);

      const elapsed = lastTime
        ? now - new Date(lastTime)
        : 60000;

      if (elapsed > 30000) {
        existing.count += 1;
        existing.history.push(now);
        existing.last_seen = now;
      }

      existing.status = "down";

      await existing.save();

      io.emit("new-event", existing);

      return res.json(existing);
    }

    const event = new Event({
      device_id,
      hostname,
      alert,
      alert_key,
      type,
      date: todayStr(),
      history: recovery ? [] : [now],
      count: recovery ? 0 : 1,
      status: recovery ? "up" : "down",
    });

    await event.save();

    io.emit("new-event", event);

    res.json(event);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: "Duplicate event, ignored",
      });
    }

    console.error("❌ Event error:", err);

    res.status(500).json({
      error: err.message,
    });
  }
});

// GET /events/today

app.get("/events/today", async (_req, res) => {
  try {
    const events = await Event.find({
      date: todayStr(),
    })
      .sort({ last_seen: -1 })
      .lean();

    res.json(events);
  } catch (err) {
    console.error(
      "❌ Events fetch error:",
      err
    );

    res.status(500).json({
      error: err.message,
    });
  }
});

// DELETE /events/cleanup

app.delete(
  "/events/cleanup",
  async (_req, res) => {
    try {
      const { deletedCount } =
        await Event.deleteMany({
          date: {
            $lt: todayStr(),
          },
        });

      console.log(
        `🧹 Cleaned ${deletedCount} old events`
      );

      res.json({
        ok: true,
        deleted: deletedCount,
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
      });
    }
  }
);

// ============================================
// BGP ALERT ROUTES (new)
// ============================================

// POST /bgp — receives BGP alert from LibreNMS template
app.post("/bgp", async (req, res) => {
  console.log("===== BGP ALERT =====");
  console.log(JSON.stringify(req.body, null, 2));

  const {
    hostname,
    ip,
    location,
    alert,
    severity,
    uptime,
    peers = [],
  } = req.body;

  try {
    // Only keep peers that are NOT established (i.e. down peers)
    // Also treat status="0" as recovered (LibreNMS recovery payloads)
    const isResolved = req.body.status === "0";

    const downPeers = isResolved ? [] : peers.filter(
      (p) => p.peer_state && p.peer_state.toLowerCase() !== "established"
    );

    if (downPeers.length === 0) {
      // All peers are back up — force delete and notify
      const deleted = await BgpAlert.findOneAndDelete({ hostname });
      console.log(`✅ BGP recovered for ${hostname}, card removed (found: ${!!deleted})`);
      io.emit("bgp-update");
      return res.sendStatus(200);
    }

    // Delete first, then re-insert to avoid stale peer data
    await BgpAlert.deleteOne({ hostname });
    await BgpAlert.create({
      hostname,
      ip,
      location,
      alert,
      severity,
      device_uptime: uptime,
      peers: downPeers,
      last_seen: new Date(),
    });

    console.log(`🔴 BGP alert saved for ${hostname} — ${downPeers.length} peer(s) down`);
    io.emit("bgp-update");
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ BGP alert error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /bgp/active — returns all active BGP alerts for the frontend
app.get("/bgp/active", async (_req, res) => {
  try {
    const alerts = await BgpAlert.find().sort({ last_seen: -1 }).lean();
    res.json(alerts);
  } catch (err) {
    console.error("❌ BGP active fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /bgp/cleanup — manually clear all BGP alerts (optional utility)
app.delete("/bgp/cleanup", async (_req, res) => {
  try {
    const { deletedCount } = await BgpAlert.deleteMany({});
    console.log(`🧹 Cleared ${deletedCount} BGP alerts`);
    res.json({ ok: true, deleted: deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// DEBUG ROUTES (existing)
// ============================================

app.post("/bgp-debug", (req, res) => {
  console.log("===== RAW BODY =====");
  console.log(req.body);
  res.sendStatus(200);
});



app.get("/tes", (req, res) => {
    console.log("GET /tes berhasil");
    res.send("OK");
});

// ============================================
// HEALTH
// ============================================

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// SHUTDOWN
// ============================================

process.on("SIGTERM", () => {
  console.log("🛑 Shutting down...");

  server.close(() => {
    mongoose.connection.close(
      false,
      () => process.exit(0)
    );
  });
});

// ============================================
// START
// ============================================

const PORT =
  process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(
    `🚀 NOC Backend running on port ${PORT}`
  );
});
import { createPortal } from "react-dom";
import { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";
import {
  Clock,
  Wifi,
  Fan,
  Power,
  Thermometer,
  Cpu,
  RefreshCw,
  ServerCrash,
  LogOut,
} from "lucide-react";

// ============================================
// CONFIG
// ============================================

const BACKEND = "http://103.163.160.245:3001";

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return "—";
  const s = Number(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

const RULE_MAP = {
  "BGP SESSION DOWN": 30,       // ← was ICMP DOWN: 1
  "SNMP DOWN": 2,
  "REBOOT TODAY": 3,
  "FAILED FAN": 23,
  "TEMP ABOVE 75 C": 22,
  "CPU ABOVE 75%": 28,
  "FAILED PSU": 24,
  "DEVICE DOWN TODAY": 26,      // ← now tracks BGP down events
  "DEVICE SNMP DOWN TODAY": 27,
};

// Visual config per alert card: icon + subtitle + grid grouping.
// Editing this object changes how a card looks — it does not touch the
// data logic below, which is untouched from the original app.
const CARD_META = {
  "SNMP DOWN":              { icon: Wifi,        subtitle: "",      group: "general" },
  "FAILED FAN":             { icon: Fan,         subtitle: "",      group: "general" },
  "FAILED PSU":             { icon: Power,       subtitle: "",      group: "general" },
  "TEMP ABOVE 75 C":        { icon: Thermometer, subtitle: "",      group: "general" },
  "CPU ABOVE 75%":          { icon: Cpu,         subtitle: "",      group: "general" },
  "DEVICE REBOOTED TODAY":  { icon: RefreshCw,   subtitle: "Today", group: "today" },
  "BGP DOWN TODAY":         { icon: ServerCrash, subtitle: "Today", group: "today" },
  "DEVICE SNMP DOWN TODAY": { icon: Wifi,        subtitle: "Today", group: "today" },
};

// ============================================
// LOGIN
// ============================================
function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    setError("");
    setIsLoading(true);

    try {
      const res = await fetch(`${BACKEND}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username,
          password,
        }),
      });

      if (res.ok) {
        localStorage.setItem("noc_logged_in", "true");
        onLogin(true);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.message || "Invalid username or password");
      }
    } catch (err) {
      console.error("Login error:", err);
      setError("Unable to connect to server");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0A0F1A] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white tracking-tight">
            NOC <span className="text-yellow-400">DASHBOARD</span>
          </h1>
          <p className="text-gray-500 mt-2">LibreNMS Dashboard Login</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-[#111827] p-8 rounded-2xl border border-white/10 shadow-2xl"
        >
          <div className="space-y-5">
            <div>
              <label className="block text-gray-400 text-sm mb-2">
                Username
              </label>

              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-[#0A0F1A] border border-white/10 text-white px-4 py-3 rounded-xl focus:border-yellow-500 focus:outline-none transition-colors"
                placeholder="Enter username"
                required
              />
            </div>

            <div>
              <label className="block text-gray-400 text-sm mb-2">
                Password
              </label>

              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-[#0A0F1A] border border-white/10 text-white px-4 py-3 rounded-xl focus:border-yellow-500 focus:outline-none transition-colors"
                placeholder="Enter password"
                required
              />
            </div>

            {error && (
              <div className="bg-red-600/20 border border-red-500 text-red-400 px-4 py-3 rounded-xl text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold py-3 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? "Signing in..." : "Sign In"}
            </button>
          </div>
        </form>

        <p className="text-center text-gray-600 text-xs mt-6">
          Authorized personnel only
        </p>
      </div>
    </div>
  );
}

// ============================================
// MAIN APP
// ============================================
export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoadingCheck, setIsLoadingCheck] = useState(true);
  const [data, setData] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [notifications, setNotifications] = useState([]);
  const [highlightDevices, setHighlightDevices] = useState(new Set());
  const [highlightCards, setHighlightCards] = useState(new Set());
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [showLoader, setShowLoader] = useState(false);
  const [bgpData, setBgpData] = useState([]);

  const prevAlertsRef = useRef(new Map());
  const previousDataHashRef = useRef("");
  const isFetchingRef = useRef(false);
  const audioRef = useRef(null);
  const resolvedAudioRef = useRef(null);
  const currentDateRef = useRef(new Date().toDateString());

  // ── Auth check ──
  useEffect(() => {
    setIsLoggedIn(localStorage.getItem("noc_logged_in") === "true");
    setIsLoadingCheck(false);
  }, []);

  // ── Audio setup ──
  useEffect(() => {
    audioRef.current = new Audio("/alert.mp3");
    resolvedAudioRef.current = new Audio("/alert2.mp3");

    const unlock = () => {
      audioRef.current?.play().catch(() => {});
      resolvedAudioRef.current?.play().catch(() => {});
      window.removeEventListener("click", unlock);
    };
    window.addEventListener("click", unlock);
    return () => window.removeEventListener("click", unlock);
  }, []);



  // ── Midnight reset ──
  useEffect(() => {
    const id = setInterval(() => {
      const today = new Date().toDateString();
      if (today !== currentDateRef.current) {
        currentDateRef.current = today;
      }
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Fetch today's events from backend ──
  // NOTE: "deviceDown" type now corresponds to BGP Session Down events
  const fetchTodayEvents = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/events/today`);
      const events = await res.json();

      const bgpDown = [];   // ← was deviceDown, now bgpDown
      const snmpDown = [];

      for (const e of events) {
        const item = {
          device_id: e.device_id,
          hostname: e.hostname,
          time: new Date(e.last_seen).toLocaleTimeString(),
          count: e.count || 1,
          history: (e.history || []).map((t) => new Date(t).toLocaleTimeString()),
        };
        // Keep using "deviceDown" as the backend type string for backward compat,
        // but it now represents BGP session down events
        if (e.type === "deviceDown") bgpDown.push(item);
        if (e.type === "snmpDown") snmpDown.push(item);
      }

      return { bgpDown, snmpDown };
    } catch (err) {
      console.error("Today's events error:", err);
      return { bgpDown: [], snmpDown: [] };
    }
  }, []);

  // ── Log a down event to backend ──
  const logEvent = useCallback(async (device_id, hostname, alert, type) => {
    try {
      await fetch(`${BACKEND}/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id, hostname, alert, type }),
      });
    } catch (err) {
      console.error("Log error:", err);
    }
  }, []);

  // ── Fetch active BGP alerts ──
  const fetchBgpAlerts = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND}/bgp/active`);
      const alerts = await res.json();
      setBgpData(alerts);
    } catch (err) {
      console.error("BGP fetch error:", err);
    }
  }, []);

  // ── Socket.IO ──
  useEffect(() => {
    const socket = io(BACKEND, { transports: ["websocket", "polling"], reconnection: true });
    socket.on("new-event", () => fetchTodayEvents());
    socket.on("bgp-update", () => fetchBgpAlerts());
    return () => socket.disconnect();
  }, [fetchTodayEvents, fetchBgpAlerts]);

  // ── Main polling function ──
  const fetchAlerts = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    if (isInitialLoad) setShowLoader(true);

    try {
      const res = await fetch(`${BACKEND}/alerts`);
      const json = await res.json();
      const alerts = json.alerts || [];

      const currentHash = alerts.map((a) => `${a.device_id}-${a.rule_id}`).sort().join(",");
      const unchanged = !isInitialLoad && currentHash === previousDataHashRef.current;
      previousDataHashRef.current = currentHash;

      // Sort alerts into buckets by rule ID
      const buckets = { BGP: [], SNMP: [], FAN: [], PSU: [], TEMP: [], CPU: [], REBOOT: [] };
      //                 ^^^  ← was ICMP

      for (const a of alerts) {
        const entry = { host: a.hostname, device_id: a.device_id };
        const name = (a.name || "").toLowerCase();

        if (a.rule_id === RULE_MAP["BGP SESSION DOWN"]) buckets.BGP.push(entry);   // ← rule_id 30
        if (a.rule_id === RULE_MAP["SNMP DOWN"])        buckets.SNMP.push(entry);
        if (a.rule_id === RULE_MAP["FAILED FAN"])       buckets.FAN.push(entry);
        if (a.rule_id === RULE_MAP["FAILED PSU"])       buckets.PSU.push(entry);
        if (a.rule_id === RULE_MAP["TEMP ABOVE 75 C"])  buckets.TEMP.push(entry);
        if (a.rule_id === RULE_MAP["CPU ABOVE 75%"])    buckets.CPU.push(entry);
        if (name.includes("reboot"))                    buckets.REBOOT.push(entry);
      }

      // Deduplicate each bucket by device_id
      for (const key of Object.keys(buckets)) {
        const seen = new Map();
        buckets[key].forEach((d) => seen.set(d.device_id, d));
        buckets[key] = Array.from(seen.values());
      }

      // Build current alert map for diffing
      const currentAlerts = new Map(
        alerts.map((a) => [
          `${a.device_id}-${a.rule_id}`,
          { device_id: a.device_id, hostname: a.hostname, name: a.name, rule_id: a.rule_id },
        ])
      );

      const prevAlerts = prevAlertsRef.current;
      const newAlertKeys = [...currentAlerts.keys()].filter((k) => !prevAlerts.has(k));
      const resolvedAlertKeys = [...prevAlerts.keys()].filter((k) => !currentAlerts.has(k));

      // Log new down events (only after initial load, skip reboots)
      if (!isInitialLoad) {
        const logPromises = newAlertKeys
          .map((k) => currentAlerts.get(k))
          .filter((a) => a && a.rule_id !== RULE_MAP["REBOOT TODAY"])
          .flatMap((a) => {
            const tasks = [];
            // BGP Session Down → log as "deviceDown" type (backend unchanged)
            if (a.rule_id === RULE_MAP["BGP SESSION DOWN"] || a.rule_id === RULE_MAP["DEVICE DOWN TODAY"])
              tasks.push(logEvent(a.device_id, a.hostname, a.name, "deviceDown"));
            if (a.rule_id === RULE_MAP["SNMP DOWN"] || a.rule_id === RULE_MAP["DEVICE SNMP DOWN TODAY"])
              tasks.push(logEvent(a.device_id, a.hostname, a.name, "snmpDown"));
            return tasks;
          });

        await Promise.all(logPromises);
      }

      const todayData = await fetchTodayEvents();

      const result = [
        // note change to bgp_hidden, cause peer bgp dependent, but we don't want to show this box
        { label: "BGP SESSION DOWN",      devices: buckets.BGP,           category: "bgp_hidden",  rule_id: RULE_MAP["BGP SESSION DOWN"] },
        //        ^^^^^^^^^^^^^^^^^^^                      ^^^                                              ^^^^^^^^^^^^^^^^^^^^^^^
        { label: "SNMP DOWN",              devices: buckets.SNMP,          category: "network",  rule_id: RULE_MAP["SNMP DOWN"] },
        { label: "FAILED FAN",             devices: buckets.FAN,           category: "hardware", rule_id: RULE_MAP["FAILED FAN"] },
        { label: "FAILED PSU",             devices: buckets.PSU,           category: "hardware", rule_id: RULE_MAP["FAILED PSU"] },
        { label: "TEMP ABOVE 75 C",        devices: buckets.TEMP,          category: "hardware", rule_id: RULE_MAP["TEMP ABOVE 75 C"] },
        { label: "CPU ABOVE 75%",          devices: buckets.CPU,           category: "hardware", rule_id: RULE_MAP["CPU ABOVE 75%"] },
        { label: "DEVICE REBOOTED TODAY",  devices: buckets.REBOOT,        category: "today",    rule_id: RULE_MAP["REBOOT TODAY"] },
        { label: "BGP DOWN TODAY",         devices: todayData.bgpDown,     category: "today",    rule_id: RULE_MAP["DEVICE DOWN TODAY"] },
        //        ^^^^^^^^^^^^^                                  ^^^^^^^^
        { label: "DEVICE SNMP DOWN TODAY", devices: todayData.snmpDown,    category: "today",    rule_id: RULE_MAP["DEVICE SNMP DOWN TODAY"] },
      ];

      // Notifications & highlights for new/resolved alerts
      if (!isInitialLoad) {
        const now = new Date();
        const newNotifs = newAlertKeys
          .filter((k) => currentAlerts.get(k)?.rule_id !== RULE_MAP["REBOOT TODAY"])
          .map((k) => ({
            id: Date.now() + Math.random(),
            device: currentAlerts.get(k)?.hostname ?? "Unknown",
            alert: currentAlerts.get(k)?.name ?? "New alert",
            time: now.toLocaleTimeString(),
            type: "new",
          }));

        const resolvedNotifs = resolvedAlertKeys.map((k) => ({
          id: Date.now() + Math.random(),
          device: prevAlerts.get(k)?.hostname ?? "Unknown",
          alert: prevAlerts.get(k)?.name ?? "Alert resolved",
          time: now.toLocaleTimeString(),
          type: "resolved",
        }));

        if (newAlertKeys.length > 0) {
          audioRef.current?.play().catch(() => {});

          const newDeviceIds = new Set(
            newAlertKeys
              .map((k) => currentAlerts.get(k))
              .filter((a) => a && a.rule_id !== RULE_MAP["REBOOT TODAY"])
              .map((a) => Number(a.device_id))
          );
          const newCardLabels = new Set(
            result
              .filter((g) => g.devices.some((d) => newDeviceIds.has(Number(d.device_id))))
              .map((g) => g.label)
          );

          setHighlightDevices(newDeviceIds);
          setHighlightCards(newCardLabels);
          setTimeout(() => {
            setHighlightDevices(new Set());
            setHighlightCards(new Set());
          }, 10_000);
        }

        if (resolvedNotifs.length > 0) setTimeout(() => resolvedAudioRef.current?.play().catch(() => {}), 300);

        if (newNotifs.length > 0 || resolvedNotifs.length > 0) {
          setNotifications((prev) => {
            const merged = [...newNotifs, ...resolvedNotifs, ...prev].slice(0, 7);
            merged.forEach((n) =>
              setTimeout(() => setNotifications((c) => c.filter((x) => x.id !== n.id)), 10_000)
            );
            return merged;
          });
        }
      }

      prevAlertsRef.current = currentAlerts;

      if (!unchanged) setData(result);
      setLastUpdate(new Date());
    } catch (err) {
      console.error("Fetch error:", err);
    } finally {
      isFetchingRef.current = false;
      if (isInitialLoad) {
        setIsInitialLoad(false);
        setShowLoader(false);
      }
    }
  }, [isInitialLoad, fetchTodayEvents, logEvent]);

  // ── Polling: every 5 seconds ──
  useEffect(() => {
    fetchAlerts();
    const id = setInterval(fetchAlerts, 5_000);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  useEffect(() => {
    fetchBgpAlerts();
    const id = setInterval(fetchBgpAlerts, 5_000);
    return () => clearInterval(id);
  }, [fetchBgpAlerts]);

  const handleLogout = () => {
    localStorage.removeItem("noc_logged_in");
    setIsLoggedIn(false);
  };

  // Direct lookup so each card can be placed in a specific spot/width
  // in the layout below, instead of looping through a generic list.
  const getCard = (label) => data.find((d) => d.label === label);

  const activeBgpHostnames = new Set(
    data.find((d) => d.label === "BGP SESSION DOWN")?.devices.map((d) => d.host) ?? []
  );
  const visibleBgpCards = bgpData.filter((d) => activeBgpHostnames.has(d.hostname));

  if (isLoadingCheck) {
    return (
      <div className="min-h-screen bg-[#0A0F1A] flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-yellow-400" />
      </div>
    );
  }

  if (!isLoggedIn) return <Login onLogin={setIsLoggedIn} />;

  return (
    <div className="min-h-screen bg-[#0A0F1A]">
      <TopBar lastUpdate={lastUpdate} onLogout={handleLogout} />

      {/* Initial load overlay */}
      {showLoader && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-[#1A2335] p-6 rounded-2xl border border-yellow-500/30 text-center shadow-2xl">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-yellow-400 mx-auto mb-4" />
            <div className="text-white font-semibold">Fetching alerts...</div>
            <div className="text-gray-400 text-sm mt-1">LibreNMS API</div>
          </div>
        </div>
      )}

      {/* New alert toasts — top right */}
      <div className="fixed top-5 right-5 space-y-2 z-50 flex flex-col items-end max-w-sm w-full">
        {notifications.filter((n) => n.type === "new").slice().reverse().map((n) => (
          <Toast key={n.id} notif={n} color="orange" label="⚠ NEW"
            onDismiss={() => setNotifications((p) => p.filter((x) => x.id !== n.id))} />
        ))}
      </div>

      {/* Resolved alert toasts — top left */}
      <div className="fixed top-5 left-5 space-y-2 z-50 flex flex-col items-start max-w-sm w-full">
        {notifications.filter((n) => n.type === "resolved").slice().reverse().map((n) => (
          <Toast key={n.id} notif={n} color="green" label="✓ RESOLVED"
            onDismiss={() => setNotifications((p) => p.filter((x) => x.id !== n.id))} />
        ))}
      </div>

      <div className="p-6 md:p-8 w-full">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-5">
          {/* BGP — full width row */}
          <div className="md:col-span-12 grid gap-5">
            {visibleBgpCards.length === 0 ? (
              <AllClearCard label="All BGP sessions established" />
            ) : (
              visibleBgpCards.map((device, i) => <BgpCard key={i} device={device} />)
            )}
          </div>

          {/* SNMP DOWN — full width row */}
          <div className="md:col-span-12">
            <AlertCard
              {...getCard("SNMP DOWN")}
              meta={CARD_META["SNMP DOWN"]}
              highlight={highlightCards.has("SNMP DOWN")}
              highlightDevices={highlightDevices}
            />
          </div>

          {/* TEMP ABOVE 75 C / CPU ABOVE 75% — 50 / 50, purple when active */}
          <div className="md:col-span-6">
            <AlertCard
              {...getCard("TEMP ABOVE 75 C")}
              meta={CARD_META["TEMP ABOVE 75 C"]}
              highlight={highlightCards.has("TEMP ABOVE 75 C")}
              highlightDevices={highlightDevices}
              alertColor="purple"
            />
          </div>
          <div className="md:col-span-6">
            <AlertCard
              {...getCard("CPU ABOVE 75%")}
              meta={CARD_META["CPU ABOVE 75%"]}
              highlight={highlightCards.has("CPU ABOVE 75%")}
              highlightDevices={highlightDevices}
              alertColor="purple"
            />
          </div>

          {/* FAILED FAN / FAILED PSU — 50 / 50 */}
          <div className="md:col-span-6">
            <AlertCard
              {...getCard("FAILED FAN")}
              meta={CARD_META["FAILED FAN"]}
              highlight={highlightCards.has("FAILED FAN")}
              highlightDevices={highlightDevices}
            />
          </div>
          <div className="md:col-span-6">
            <AlertCard
              {...getCard("FAILED PSU")}
              meta={CARD_META["FAILED PSU"]}
              highlight={highlightCards.has("FAILED PSU")}
              highlightDevices={highlightDevices}
            />
          </div>

          {/* DEVICE REBOOTED TODAY / BGP DOWN TODAY / DEVICE SNMP DOWN TODAY — 33 / 33 / 33 */}
          <div className="md:col-span-4">
            <AlertCard
              {...getCard("DEVICE REBOOTED TODAY")}
              meta={CARD_META["DEVICE REBOOTED TODAY"]}
              highlight={highlightCards.has("DEVICE REBOOTED TODAY")}
              highlightDevices={highlightDevices}
            />
          </div>
          <div className="md:col-span-4">
            <AlertCard
              {...getCard("BGP DOWN TODAY")}
              meta={CARD_META["BGP DOWN TODAY"]}
              highlight={highlightCards.has("BGP DOWN TODAY")}
              highlightDevices={highlightDevices}
            />
          </div>
          <div className="md:col-span-4">
            <AlertCard
              {...getCard("DEVICE SNMP DOWN TODAY")}
              meta={CARD_META["DEVICE SNMP DOWN TODAY"]}
              highlight={highlightCards.has("DEVICE SNMP DOWN TODAY")}
              highlightDevices={highlightDevices}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================
// TOP BAR
// ============================================
function TopBar({ lastUpdate, onLogout }) {
  return (
    <div className="sticky top-0 z-30 bg-[#0A0F1A]/95 backdrop-blur border-b border-yellow-500/20 px-6 md:px-8 py-4 flex items-center justify-between">
      <div className="flex items-baseline gap-1.5">
        <span className="text-lg font-bold text-white tracking-tight">NOC</span>
        <span className="text-lg font-bold text-yellow-400 tracking-tight">DASHBOARD</span>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden sm:flex items-center gap-1.5 text-gray-400 text-sm">
          <Clock size={14} />
          <span>Last updated:</span>
          <span className="font-mono text-gray-300">{lastUpdate.toLocaleTimeString()}</span>
        </div>

        <div className="flex items-center gap-1.5 text-yellow-400 text-xs font-bold tracking-wide">
          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
          LIVE
        </div>

        <button
          onClick={onLogout}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-red-400 border border-white/10 hover:border-red-400/40 rounded-lg px-3 py-1.5 transition-colors"
        >
          <LogOut size={13} />
          Logout
        </button>
      </div>
    </div>
  );
}

// ============================================
// SMALL REUSABLE COMPONENTS
// ============================================

function AllClearCard({ label }) {
  return (
    <div className="bg-green-600 border border-green-500 rounded-2xl p-4 text-white shadow-lg flex items-center gap-2 text-sm">
      <span>✓</span>
      <span>{label}</span>
    </div>
  );
}

function Toast({ notif, color, label, onDismiss }) {
  const bg = color === "green" ? "bg-green-600 border-l-4 border-green-400" : "bg-orange-600 border-r-4 border-yellow-400";
  return (
    <div className={`w-full px-4 py-2 rounded-lg shadow-xl relative text-sm max-w-sm text-white ${bg}`}>
      <button onClick={onDismiss}
        className="absolute top-1.5 right-1.5 hover:bg-white/20 rounded-full w-5 h-5 flex items-center justify-center text-xs">
        ✕
      </button>
      <div className="pr-6">
        <div className="font-bold text-xs mb-0.5">{label}</div>
        <div className="font-semibold text-sm truncate">[{notif.device}]</div>
        <div className="text-xs truncate max-w-[200px]">{notif.alert}</div>
        <div className="text-xs opacity-70 mt-1 font-mono">{notif.time}</div>
      </div>
    </div>
  );
}

// ============================================
// ALERT CARD
// ============================================
function AlertCard({ label, devices = [], rule_id, highlight, highlightDevices, meta, alertColor = "red" }) {
  const [activeTooltip, setActiveTooltip] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });
  const badgeRefs = useRef({});
  const cardRef = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (cardRef.current && !cardRef.current.contains(e.target)) setActiveTooltip(null);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleBadgeClick = (e, index, deviceId) => {
    e.preventDefault();
    e.stopPropagation();

    const el = badgeRefs.current[deviceId];
    if (el) {
      const rect = el.getBoundingClientRect();
      const tooltipH = 220;
      const tooltipW = 300;
      const showAbove = window.innerHeight - rect.bottom < tooltipH;
      const rawLeft = rect.left + rect.width / 2;
      const clampedLeft = Math.min(Math.max(rawLeft, tooltipW / 2 + 8), window.innerWidth - tooltipW / 2 - 8);
      setTooltipPosition({ top: showAbove ? rect.top - tooltipH - 5 : rect.bottom + 5, left: clampedLeft });
    }

    setActiveTooltip(activeTooltip === index ? null : index);
  };

  const hasAlert = devices.length > 0;
  const Icon = meta?.icon;
  const subtitle = meta?.subtitle ?? "";

  const cardStyle = !hasAlert
    ? "bg-green-600 hover:bg-green-700 border-green-500/50"
    : alertColor === "purple"
    ? "bg-purple-600 hover:bg-purple-700 border-purple-500/50"
    : "bg-red-600 hover:bg-red-700 border-red-500/50";

  return (
    <div
      ref={cardRef}
      className={`${cardStyle} border rounded-2xl p-5 text-white shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:shadow-xl min-h-[176px] flex flex-col ${
        highlight ? "ring-2 ring-yellow-300 ring-offset-2 ring-offset-[#0A0F1A] animate-pulse" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {Icon && (
            <div className="w-12 h-12 rounded-2xl bg-black/20 ring-1 ring-white/10 flex items-center justify-center shrink-0">
              <Icon size={22} strokeWidth={2} />
            </div>
          )}
          <div className="min-w-0">
            {rule_id ? (
              <a
                href={`https://mon.as.net.id/alerts/rule_id=${rule_id}`}
                target="_blank"
                rel="noreferrer"
                className="font-bold text-[13px] uppercase tracking-wide hover:text-yellow-200 transition-colors truncate block"
              >
                {label}
              </a>
            ) : (
              <span className="font-bold text-[13px] uppercase tracking-wide block">{label}</span>
            )}
            {subtitle && <span className="text-xs text-white/60">{subtitle}</span>}
          </div>
        </div>
        <div className="text-3xl font-bold tabular-nums shrink-0">{devices.length}</div>
      </div>

      <div className="mt-4 pt-3 border-t border-white/15 flex-1 flex flex-wrap items-start content-start gap-1.5 max-h-[160px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-transparent">
        {!hasAlert && (
          <span className="text-xs text-white/60">No active devices</span>
        )}
        {hasAlert &&
          devices.map((d, i) => {
            const isHighlighted = highlightDevices.has(d.device_id);
            const name = d.hostname || d.host;
            return (
              <div
                key={`${d.device_id}-${i}`}
                className={`group flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-lg border transition-all duration-200 hover:-translate-y-0.5 cursor-pointer ${
                  isHighlighted
                    ? "bg-yellow-400 border-yellow-300 text-black shadow-lg"
                    : "bg-black/25 border-white/10 hover:bg-black/40 hover:border-white/25 text-white"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isHighlighted ? "bg-black/60" : "bg-white/40 group-hover:bg-white/70"
                  }`}
                />
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    const isBgp = rule_id === RULE_MAP["BGP SESSION DOWN"] || rule_id === RULE_MAP["DEVICE DOWN TODAY"];
                    const url = isBgp
                      ? `https://mon.as.net.id/device/device=${d.device_id}/tab=routing/proto=bgp/`
                      : `https://mon.as.net.id/device/${d.device_id}`;
                    window.open(url, "_blank");
                  }}
                  className="font-mono text-xs font-semibold tracking-wide cursor-pointer hover:underline"
                  title={`View ${name}`}
                >
                  {name}
                </span>
                {d.time && (
                  <span className={`text-[10px] font-mono ${isHighlighted ? "text-black/60" : "text-white/50"}`}>
                    {d.time}
                  </span>
                )}
                {d.count && (
                  <span
                    ref={(el) => (badgeRefs.current[d.device_id] = el)}
                    onClick={(e) => handleBadgeClick(e, i, d.device_id)}
                    className="flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-yellow-400 text-black text-[10px] font-bold cursor-pointer hover:bg-yellow-300 transition-colors"
                    title={`Count: ${d.count}`}
                  >
                    {d.count}
                  </span>
                )}
              </div>
            );
          })}
        </div>

      {/* Tooltip portal */}
      {activeTooltip !== null && devices[activeTooltip] &&
        createPortal(
          <div
            className="fixed bg-gray-900 text-white text-xs p-3 rounded-lg shadow-2xl z-[99999] min-w-[220px] max-w-[300px] border border-gray-700"
            style={{ top: tooltipPosition.top, left: tooltipPosition.left, transform: "translateX(-50%)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-bold mb-2 text-yellow-400 border-b border-gray-700 pb-1 flex items-center justify-between">
              <span>📋 {devices[activeTooltip]?.hostname || devices[activeTooltip]?.host}</span>
              <button className="text-gray-400 hover:text-white text-xs" onClick={() => setActiveTooltip(null)}>✕</button>
            </div>
            <div className="space-y-1 max-h-[200px] overflow-y-auto">
              {devices[activeTooltip]?.history?.length > 0 ? (
                devices[activeTooltip].history.map((t, idx) => (
                  <div key={idx} className="font-mono text-[11px] text-gray-300 flex items-center gap-1">
                    <span>⏱️</span><span>{t}</span>
                  </div>
                ))
              ) : (
                <div className="text-gray-400 text-center py-2">No history</div>
              )}
            </div>
            <div className="mt-2 pt-1 text-center border-t border-gray-700">
              <span className="text-[10px] text-gray-400">Count: {devices[activeTooltip]?.count || 1}</span>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
// ============================================
// BGP CARD
// ============================================
function BgpCard({ device }) {
  const peerStateColor = (state = "") => {
    const s = state.toLowerCase();
    if (s === "established") return "text-green-400";
    if (s === "active")      return "text-yellow-400";
    if (s === "connect")     return "text-orange-400";
    if (s === "idle")        return "text-red-400";
    return "text-gray-400";
  };

  const errorLabel = (code, sub) => {
    if (code === "0" && sub === "0") return "—";
    return `${code}/${sub}`;
  };

  return (
    <div className="bg-red-600 border border-red-500/50 rounded-2xl p-5 text-white shadow-lg">
      {/* Device header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
            <ServerCrash size={20} />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-sm tracking-wide truncate">{device.hostname}</div>
            <div className="text-xs text-white/60 font-mono mt-0.5">{device.ip}</div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="bg-yellow-400 text-black font-bold rounded-full px-2.5 py-0.5 text-sm">
            {device.peers.length} peer{device.peers.length !== 1 ? "s" : ""} down
          </div>
          <div className="text-xs text-white/50 font-mono mt-1">
            {new Date(device.last_seen).toLocaleTimeString()}
          </div>
        </div>
      </div>

      {/* Peers table */}
      <div className="overflow-x-auto mt-4 pt-3 border-t border-white/15">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-white/50 border-b border-white/10">
              <th className="text-left py-1.5 pr-3 font-medium">Peer IP</th>
              <th className="text-left py-1.5 pr-3 font-medium">ASN</th>
              <th className="text-left py-1.5 pr-3 font-medium">ASN Name</th>
              <th className="text-left py-1.5 pr-3 font-medium">State</th>
              <th className="text-left py-1.5 pr-3 font-medium">Down For</th>
              <th className="text-left py-1.5 font-medium">Err</th>
            </tr>
          </thead>
          <tbody>
            {device.peers.map((peer, i) => (
              <tr key={i} className="border-b border-white/10 last:border-0 hover:bg-white/5">
                <td className="py-1.5 pr-3 font-mono">{peer.peer_address}</td>
                <td className="py-1.5 pr-3 font-mono">{peer.remote_as}</td>
                <td className="py-1.5 pr-3 max-w-[200px] truncate" title={peer.asn_name}>
                  {peer.asn_name?.split(" - ")[0] || "—"}
                </td>
                <td className={`py-1.5 pr-3 font-semibold uppercase ${peerStateColor(peer.peer_state)}`}>
                  {peer.peer_state}
                </td>
                <td className="py-1.5 pr-3 font-mono">
                  {formatUptime(peer.peer_uptime)}
                </td>
                <td className="py-1.5 font-mono">
                  {errorLabel(peer.last_error_code, peer.last_error_subcode)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
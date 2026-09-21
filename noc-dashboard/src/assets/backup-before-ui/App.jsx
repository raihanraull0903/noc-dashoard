import { createPortal } from "react-dom";
import { useEffect, useState, useRef, useCallback } from "react";
import io from "socket.io-client";

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
          <h1 className="text-4xl font-bold text-white">
            ASNET <span className="text-yellow-400">NOC</span>
          </h1>
          <p className="text-gray-400 mt-2">LibreNMS Dashboard Login</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-[#1A2335] p-8 rounded-xl border border-yellow-500/30 shadow-2xl"
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
                className="w-full bg-[#0A0F1A] border border-gray-700 text-white px-4 py-3 rounded-lg focus:border-yellow-500 focus:outline-none transition-colors"
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
                className="w-full bg-[#0A0F1A] border border-gray-700 text-white px-4 py-3 rounded-lg focus:border-yellow-500 focus:outline-none transition-colors"
                placeholder="Enter password"
                required
              />
            </div>

            {error && (
              <div className="bg-red-600/20 border border-red-500 text-red-400 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-bold py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? "Signing in..." : "Sign In"}
            </button>
          </div>
        </form>

        <p className="text-center text-gray-500 text-xs mt-6">
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

  const network  = data.filter((i) => i.category === "network");
  const hardware = data.filter((i) => i.category === "hardware");
  const today    = data.filter((i) => i.category === "today");

  if (isLoadingCheck) {
    return (
      <div className="min-h-screen bg-[#0A0F1A] flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-yellow-400" />
      </div>
    );
  }

  if (!isLoggedIn) return <Login onLogin={setIsLoggedIn} />;

  return (
    <div className="min-h-screen bg-[#0A0F1A] p-5">
      {/* Initial load overlay */}
      {showLoader && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-[#1A2335] p-6 rounded-xl border border-yellow-500/50 text-center shadow-2xl">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-yellow-400 mx-auto mb-4" />
            <div className="text-white font-semibold">Fetching alerts...</div>
            <div className="text-gray-400 text-sm mt-1">LibreNMS API</div>
          </div>
        </div>
      )}

      {/* New alert toasts — top right */}
      <div className="fixed top-5 right-5 space-y-2 z-50 flex flex-col items-end max-w-sm w-full">
        {notifications.filter((n) => n.type === "new").slice().reverse().map((n) => (
          <Toast key={n.id} notif={n} color="orange" border="yellow" label="⚠ NEW"
            onDismiss={() => setNotifications((p) => p.filter((x) => x.id !== n.id))} />
        ))}
      </div>

      {/* Resolved alert toasts — top left */}
      <div className="fixed top-5 left-5 space-y-2 z-50 flex flex-col items-start max-w-sm w-full">
        {notifications.filter((n) => n.type === "resolved").slice().reverse().map((n) => (
          <Toast key={n.id} notif={n} color="emerald" border="emerald" label="✓ RESOLVED"
            onDismiss={() => setNotifications((p) => p.filter((x) => x.id !== n.id))} />
        ))}
      </div>

      {/* Header */}
      <div className="mb-6">
        <div className="flex relative items-center border-b border-yellow-500/30 pb-3">
          <h1 className="text-3xl font-bold text-white">
            ASNET <span className="text-yellow-400">NOC Dashboard</span> - DEMO
          </h1>
          <div className="absolute right-0 bottom-2 bg-[#1A2335] px-4 py-2 rounded-lg border border-gray-700">
            <span className="text-gray-400 text-sm">Last update:</span>
            <span className="text-yellow-400 font-mono ml-2 text-sm">{lastUpdate.toLocaleTimeString()}</span>
          </div>
        </div>
      </div>

      {/* BGP Alerts */}
      <SectionHeader title="BGP Alerts" color="red" />
      <div className="grid md:grid-cols-3 gap-5 mb-8">
        {(() => {
          // Only show BGP cards whose hostname is currently in the LibreNMS active alerts
          const activeBgpHostnames = new Set(
            data
              .find(d => d.label === "BGP SESSION DOWN")
              ?.devices.map(d => d.host) ?? []
          );
          const visibleCards = bgpData.filter(d => activeBgpHostnames.has(d.hostname));
          return visibleCards.length === 0 ? (
            <div className="bg-green-600 border border-green-500 rounded-xl p-4 text-white shadow-lg">
              <div className="flex items-center gap-1.5 text-sm text-white/80">
                <span>✓</span><span>All BGP sessions established</span>
              </div>
            </div>
          ) : (
            visibleCards.map((device, i) => (
              <BgpCard key={i} device={device} />
            ))
          );
        })()}
      </div>

      {/* Network Alerts */}
      <SectionHeader title="Network Alerts" color="yellow"/>
      <div className="grid md:grid-cols-1 gap-5 mb-8">
        {network.map((item, i) => (
          <AlertCard key={i} {...item} highlight={highlightCards.has(item.label)} highlightDevices={highlightDevices} />
        ))}
      </div>

      {/* Hardware Alerts */}
      <SectionHeader title="Hardware Alerts" color="cyan"/>
      <div className="grid md:grid-cols-2 gap-5 mb-8">
        {hardware.map((item, i) => (
          <AlertCard key={i} {...item} highlight={highlightCards.has(item.label)} highlightDevices={highlightDevices} />
        ))}
      </div>

      {/* Today's Events */}
      <SectionHeader title="Today's Events" color="yellow"/>
      <div className="grid md:grid-cols-3 gap-5">
        {today.map((item, i) => (
          <AlertCard key={i} {...item} highlight={highlightCards.has(item.label)} highlightDevices={highlightDevices} />
        ))}
      </div>

      {/* Logout button */}
      <div className="flex justify-end mt-10 mb-6">
        <button
          onClick={handleLogout}
          className="bg-red-600 hover:bg-red-700 text-white px-8 py-2.5 rounded-lg text-sm font-medium transition-colors">
          Logout
        </button>
      </div>
    </div>
  );
}

// ============================================
// SMALL REUSABLE COMPONENTS
// ============================================

function SectionHeader({ title, color, sub }) {
  const accent = color === "cyan" ? "text-cyan-400" : color === "red" ? "text-red-400" : "text-yellow-400";
  const bar    = color === "cyan" ? "bg-cyan-500"   : color === "red" ? "bg-red-500"   : "bg-yellow-500";
  return (
    <div className="mb-4 mt-6">
      <h2 className={`text-xl font-semibold ${accent} flex items-center gap-2`}>
        <span className={`w-1 h-5 ${bar} rounded-full`} />
        {title}
      </h2>
      <p className="text-gray-500 text-sm ml-3 mt-0.5">{sub}</p>
    </div>
  );
}

function Toast({ notif, color, border, label, onDismiss }) {
  const bg = color === "emerald" ? "bg-emerald-600 border-l-4 border-emerald-400" : "bg-orange-600 border-r-4 border-yellow-400";
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
function AlertCard({ label, devices = [], rule_id, highlight, highlightDevices }) {
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
  const cardStyle = hasAlert
    ? "bg-red-600 hover:bg-red-700 border-red-500"
    : "bg-green-600 hover:bg-green-700 border-green-500";

  return (
    <div
      ref={cardRef}
      className={`${cardStyle} border rounded-xl p-4 text-white shadow-lg transition-all duration-200 hover:scale-[1.01] hover:shadow-xl ${
        highlight ? "ring-3 ring-yellow-400 ring-offset-2 ring-offset-[#0A0F1A] animate-pulse" : ""
      }`}
    >
      <div className="flex justify-between items-center mb-3">
        <div className="flex-1">
          {rule_id ? (
            <a
              href={`https://mon.as.net.id/alerts/rule_id=${rule_id}`}
              target="_blank"
              rel="noreferrer"
              className="font-bold text-md hover:text-yellow-200 transition-colors inline-flex items-center gap-1.5 group"
            >
              {label} <span className="text-xs opacity-70 group-hover:opacity-100">↗</span>
            </a>
          ) : (
            <span className="font-bold text-md">{label}</span>
          )}
        </div>
        {hasAlert && (
          <div className="bg-yellow-400 text-black font-bold rounded-full min-w-[28px] h-7 flex items-center justify-center px-2 text-sm shadow">
            {devices.length}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-1.5 max-h-[250px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-gray-600 scrollbar-track-transparent">
        {!hasAlert ? (
          <div className="flex items-center gap-1.5 text-sm text-white/80 bg-white/15 rounded-lg px-3 py-1.5">
            <span>✓</span><span>No events</span>
          </div>
        ) : (
          devices.map((d, i) => {
            const isHighlighted = highlightDevices.has(d.device_id);
            const name = d.hostname || d.host;
            return (
              <div
                key={`${d.device_id}-${i}`}
                className={`inline-flex px-2.5 py-1 rounded-md text-sm font-medium transition-all duration-200 hover:scale-105 hover:shadow-md cursor-pointer ${
                  isHighlighted
                    ? "bg-yellow-400 text-black font-bold shadow-lg ring-1 ring-yellow-200"
                    : "bg-black/30 hover:bg-black/40"
                }`}
              >
                <div className="flex items-center gap-1">
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      const isBgp = rule_id === RULE_MAP["BGP SESSION DOWN"] || rule_id === RULE_MAP["DEVICE DOWN TODAY"];
                      const url = isBgp
                        ? `https://mon.as.net.id/device/device=${d.device_id}/tab=routing/proto=bgp/`
                        : `https://mon.as.net.id/device/${d.device_id}`;
                      window.open(url, "_blank");
                    }}
                    className="cursor-pointer hover:underline"
                    title={`View ${name}`}
                  >
                    {name}
                  </span>
                  {d.time && <span className="text-xs opacity-70">[{d.time}]</span>}
                  {d.count && (
                    <span
                      ref={(el) => (badgeRefs.current[d.device_id] = el)}
                      onClick={(e) => handleBadgeClick(e, i, d.device_id)}
                      className="ml-1 bg-yellow-400 text-black text-xs px-1.5 py-0.5 rounded cursor-pointer hover:bg-yellow-500"
                      title={`Count: ${d.count}`}
                    >
                      {d.count}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
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
    <div className="bg-red-600 border border-red-500 rounded-xl p-4 text-white shadow-lg">
      {/* Device header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-bold text-lg">{device.hostname}</div>
          <div className="text-xs text-white/60 font-mono mt-0.5">{device.ip}</div>
        </div>
        <div className="text-right">
          <div className="bg-yellow-400 text-black font-bold rounded-full px-2.5 py-0.5 text-sm">
            {device.peers.length} peer{device.peers.length !== 1 ? "s" : ""} down
          </div>
          <div className="text-xs text-white/50 font-mono mt-1">
            {new Date(device.last_seen).toLocaleTimeString()}
          </div>
        </div>
      </div>

      {/* Peers table */}
      <div className="overflow-x-auto">
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
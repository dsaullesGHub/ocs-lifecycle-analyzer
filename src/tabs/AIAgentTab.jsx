// AIAgentTab - Chat interface powered by Claude with full data context
import { useState, useRef, useEffect, useCallback } from "react";

const CV = { navy: "#2B4170", red: "#E8523F", cream: "#F5EDE0", teal: "#00A3BE", purple: "#7B5EA7", orange: "#F5A623", green: "#4EBC6A", navyLight: "#E8EDF5", creamDark: "#EDE0CE" };
const fmt$ = (v) => v == null ? "---" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtN = (v) => v == null ? "---" : v.toLocaleString();
const mKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const OCS_LOCATIONS = {
  S7: "NACS - Fort Wayne, IN", S4: "Interstate Franklin - Franklin, IN", S9: "Americold Indy - Indianapolis, IN",
  C3: "Americold Rochelle - Rochelle, IL", S: "Americold Atlanta - Atlanta, GA", C1: "US Cold - McDonough, GA",
  S1: "P&B Cold Storage", S2: "Americold Wakefern - Gouldsboro, PA", S5: "Americold Hatfield - Hatfield, PA",
  S8: "Americold Allentown - Allentown, PA", S6: "Americold Perryville - Perryville, MD",
  "7B": "Mesa Cold Storage - Tolleson, AZ", O1: "Interstate Kingman - Golden Valley, AZ",
};

function buildDataContext(lifecycles, invoices, rates, locStats, oppsData) {
  const sections = [];

  // Overview
  if (lifecycles && lifecycles.length > 0) {
    const total = lifecycles.length;
    const open = lifecycles.filter(l => l.open).length;
    const preEx = lifecycles.filter(l => l.preExisting).length;
    const closed = total - open - preEx;
    const totalCost = lifecycles.reduce((s, l) => s + (l.totalCost || 0), 0);
    const dates = lifecycles.filter(l => l.entryDate).map(l => l.entryDate);
    const minDate = dates.length ? new Date(Math.min(...dates.map(d => d.getTime()))) : null;
    const maxDate = dates.length ? new Date(Math.max(...dates.map(d => d.getTime()))) : null;

    sections.push(`DATA OVERVIEW:
- Total pallet lifecycles: ${fmtN(total)}
- Open (currently in storage): ${fmtN(open)}
- Closed (shipped out): ${fmtN(closed)}
- Pre-existing (no entry date): ${fmtN(preEx)}
- Total modeled cost: ${fmt$(totalCost)}
- Data window: ${minDate ? minDate.toISOString().slice(0, 10) : "?"} to ${maxDate ? maxDate.toISOString().slice(0, 10) : "?"}`);
  }

  // Location stats
  if (locStats) {
    const locLines = Object.entries(locStats)
      .filter(([, s]) => s.total > 0)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([loc, s]) => {
        const name = OCS_LOCATIONS[loc] || loc;
        return `  ${loc} (${name}): ${fmtN(s.total)} lifecycles, ${s.open} open, avg dwell ${s.avgDwell ? s.avgDwell.toFixed(0) + "d" : "N/A"}, ${s.mats} materials, cost ${fmt$(s.cost)}`;
      });
    sections.push(`LOCATION BREAKDOWN:\n${locLines.join("\n")}`);
  }

  // Rate cards
  if (rates) {
    const rateLines = Object.entries(rates).map(([loc, r]) =>
      `  ${loc}: handling $${r.handling}, initial storage $${r.initialStorage}, renewal $${r.renewalStorage}, cycle ${r.cycleDays}d`
    );
    sections.push(`RATE CARDS:\n${rateLines.join("\n")}`);
  }

  // Monthly throughput
  if (lifecycles && lifecycles.length > 0) {
    const months = {};
    for (const lc of lifecycles) {
      if (lc.preExisting) continue;
      if (lc.entryDate) { const k = mKey(lc.entryDate); if (!months[k]) months[k] = { entries: 0, exits: 0, cost: 0 }; months[k].entries++; months[k].cost += lc.totalCost || 0; }
      if (lc.exitDate) { const k = mKey(lc.exitDate); if (!months[k]) months[k] = { entries: 0, exits: 0, cost: 0 }; months[k].exits++; }
    }
    const monthLines = Object.entries(months).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `  ${k}: ${v.entries} in, ${v.exits} out, net ${v.entries - v.exits > 0 ? "+" : ""}${v.entries - v.exits}, cost ${fmt$(v.cost)}`);
    sections.push(`MONTHLY THROUGHPUT:\n${monthLines.join("\n")}`);
  }

  // Material summary (top 20)
  if (lifecycles && lifecycles.length > 0) {
    const mats = {};
    for (const lc of lifecycles) {
      if (!mats[lc.material]) mats[lc.material] = { total: 0, open: 0, cost: 0, dwells: [], locs: new Set() };
      mats[lc.material].total++; if (lc.open) mats[lc.material].open++;
      mats[lc.material].cost += lc.totalCost || 0;
      if (lc.dwell != null) mats[lc.material].dwells.push(lc.dwell);
      mats[lc.material].locs.add(lc.loc);
    }
    const matLines = Object.entries(mats).sort((a, b) => b[1].total - a[1].total).slice(0, 20)
      .map(([mat, d]) => {
        const avg = d.dwells.length ? (d.dwells.reduce((a, b) => a + b, 0) / d.dwells.length).toFixed(0) : "?";
        return `  ${mat}: ${d.total} lifecycles, ${d.open} open, avg dwell ${avg}d, cost ${fmt$(d.cost)}, locations: ${[...d.locs].join(",")}`;
      });
    sections.push(`TOP 20 MATERIALS:\n${matLines.join("\n")}`);
  }

  // Opportunities
  if (oppsData && oppsData.length > 0) {
    const oppLines = oppsData.map(o => {
      let line = `  [${o.severity.toUpperCase()}] ${o.title}`;
      if (o.metric != null) line += ` - ${fmt$(o.metric)} ${o.metricLabel || ""}`;
      if (o.recommendation) line += `\n    Recommendation: ${o.recommendation}`;
      if (o.trend && o.trend.length >= 3) {
        const last3 = o.trend.slice(-3);
        const first3 = o.trend.slice(0, 3);
        const recentAvg = last3.reduce((s, t) => s + t.count, 0) / last3.length;
        const earlyAvg = first3.reduce((s, t) => s + t.count, 0) / first3.length;
        line += `\n    Trend: early avg ${earlyAvg.toFixed(0)}/mo, recent avg ${recentAvg.toFixed(0)}/mo (${recentAvg < earlyAvg ? "improving" : "worsening"})`;
      }
      return line;
    });
    sections.push(`OPPORTUNITIES AND FINDINGS:\n${oppLines.join("\n")}`);
  }

  // Invoices
  if (invoices && invoices.length > 0) {
    const invLines = invoices.map(inv =>
      `  ${inv.vendor} #${inv.invoiceNumber} (${inv.billingPeriod || inv.invoiceDate}): ${inv.location}, storage ${fmt$(inv.storage)}, handling ${fmt$(inv.handling)}, assessorials ${fmt$(inv.assessorials)}, total ${fmt$(inv.invoicedTotal || inv.total)}, ${inv.palletsBilled} pallets`
    );
    sections.push(`PROCESSED INVOICES (${invoices.length}):\n${invLines.join("\n")}`);
  }

  return sections.join("\n\n");
}

const SYSTEM_PROMPT = `You are the OCS Intelligence Agent for Cafe Valley Bakery. You have access to detailed outside cold storage data including pallet lifecycle tracking, cost modeling, invoice processing, and opportunity analysis.

Your role:
- Answer questions about the data with specific numbers and citations
- Identify patterns, trends, and anomalies
- Provide actionable recommendations grounded in the data
- Compare locations, vendors, materials, and time periods when relevant
- Flag areas of concern and quantify the financial impact
- Reference industry benchmarks for frozen distribution (30-day median dwell target, 2-3% rate increase norms, etc.)

Communication style:
- Data-driven, concise, forward-looking
- Show your math when making calculations
- Use tables or structured formats when comparing items
- Do not use em dashes
- Lead with the answer, then provide supporting detail
- Flag assumptions explicitly

The user is an SVP of Supply Chain. Assume executive-level analytical capability. Do not oversimplify.`;

export default function AIAgentTab({ lifecycles, invoices, rates, locStats, oppsData, apiKey, onApiKeyChange }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;
    if (!apiKey) { setError("Enter your Anthropic API key to use the AI agent."); return; }

    const userMsg = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setError("");

    try {
      const dataContext = buildDataContext(lifecycles, invoices, rates, locStats, oppsData);

      // Build conversation for API, injecting data context into the first user message
      const apiMessages = newMessages.map((m, i) => {
        if (i === 0 && m.role === "user") {
          return { role: "user", content: `Here is the current data loaded in the OCS platform:\n\n${dataContext}\n\nUser question: ${m.content}` };
        }
        // For subsequent messages, just include a reminder of data availability
        if (m.role === "user" && i > 0) {
          return { role: "user", content: m.content };
        }
        return m;
      });

      // If this is the first message, inject context. If subsequent, add a condensed reminder.
      if (newMessages.length > 2) {
        // Only send last 10 messages to stay within context limits, with data summary in system
        const recentMessages = apiMessages.slice(-10);
        if (recentMessages[0]?.role === "assistant") {
          recentMessages.unshift({ role: "user", content: `[Data context refreshed]\n\n${dataContext}\n\nPlease continue our conversation.` });
        }
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          system: SYSTEM_PROMPT,
          messages: apiMessages.slice(-10),
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API error (${response.status}): ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      const assistantText = data.content?.find(c => c.type === "text")?.text || "No response received.";
      setMessages([...newMessages, { role: "assistant", content: assistantText }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [input, messages, loading, apiKey, lifecycles, invoices, rates, locStats, oppsData]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const clearChat = () => { setMessages([]); setError(""); };

  const hasData = lifecycles && lifecycles.length > 0;

  const suggestedQuestions = [
    "What are the top 3 cost reduction opportunities across all OCS locations?",
    "Which materials have the highest dwell times and what is the cost impact?",
    "Compare NACS vs Americold on cost per pallet and inventory velocity.",
    "Are we trending better or worse on short-dwell waste this year vs last?",
    "What would happen if we consolidated all Americold volume to Rochelle?",
    "Which locations have the most pallets crossing the 30-day renewal threshold?",
    "Give me an executive summary of our OCS portfolio health.",
    "What are the biggest discrepancies between invoiced and modeled costs?",
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 130px)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800 }}>OCS Intelligence Agent</h2>
          <p style={{ margin: 0, fontSize: 12, color: "#888" }}>
            Ask questions about your OCS data. The agent has full context on lifecycles, costs, invoices, and opportunities.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {messages.length > 0 && (
            <button onClick={clearChat} style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${CV.creamDark}`, cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#999", background: "#fff" }}>Clear Chat</button>
          )}
        </div>
      </div>

      {/* API key input if not set */}
      {!apiKey && (
        <div style={{ background: "#fff", borderRadius: 10, padding: "16px 20px", border: `1px solid ${CV.creamDark}`, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: CV.navy, marginBottom: 6 }}>ANTHROPIC API KEY</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="password" placeholder="sk-ant-..." value="" onChange={e => onApiKeyChange(e.target.value)}
              style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: `1px solid ${CV.creamDark}`, fontSize: 12, fontFamily: "monospace" }} />
          </div>
          <div style={{ fontSize: 10, color: "#999", marginTop: 4 }}>Required to use the AI agent. Your key is used directly from the browser and never stored.</div>
        </div>
      )}

      {/* Data status */}
      {!hasData && (
        <div style={{ background: "#FEF3E2", borderRadius: 10, padding: "12px 16px", marginBottom: 12, fontSize: 12, color: CV.orange }}>
          No lifecycle data loaded. Load WMS files first for the agent to have data context.
        </div>
      )}

      {/* Chat area */}
      <div style={{ flex: 1, overflowY: "auto", background: "#fff", borderRadius: 12, border: `1px solid ${CV.creamDark}`, padding: "16px", marginBottom: 12 }}>
        {messages.length === 0 && (
          <div style={{ padding: "20px 0" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: CV.navy, marginBottom: 12 }}>Try asking:</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {suggestedQuestions.map((q, i) => (
                <button key={i} onClick={() => { setInput(q); inputRef.current?.focus(); }}
                  style={{ textAlign: "left", padding: "10px 14px", borderRadius: 8, border: `1px solid ${CV.creamDark}`, cursor: "pointer", fontSize: 12, color: CV.navy, background: CV.cream, lineHeight: 1.4 }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 16, display: "flex", flexDirection: "column",
            alignItems: msg.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#999", marginBottom: 4, textTransform: "uppercase" }}>
              {msg.role === "user" ? "You" : "OCS Agent"}
            </div>
            <div style={{
              maxWidth: "85%", padding: "12px 16px", borderRadius: 12,
              background: msg.role === "user" ? CV.navy : CV.cream,
              color: msg.role === "user" ? "#fff" : CV.navy,
              fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap",
            }}>
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 0" }}>
            <div style={{ width: 16, height: 16, border: `2px solid ${CV.creamDark}`, borderTopColor: CV.navy, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
            <span style={{ fontSize: 12, color: "#888" }}>Analyzing your data...</span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {error && <div style={{ padding: "8px 12px", background: "#FEEEEC", borderRadius: 8, fontSize: 12, color: CV.red, marginBottom: 8 }}>{error}</div>}

      {/* Input area */}
      <div style={{ display: "flex", gap: 8 }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={apiKey ? "Ask about your OCS data..." : "Enter API key above to start"}
          disabled={!apiKey || loading}
          rows={2}
          style={{
            flex: 1, padding: "10px 14px", borderRadius: 10,
            border: `1px solid ${CV.creamDark}`, fontSize: 13,
            fontFamily: "'Segoe UI', system-ui, sans-serif",
            resize: "none", outline: "none",
          }}
        />
        <button onClick={sendMessage} disabled={!apiKey || loading || !input.trim()}
          style={{
            padding: "10px 20px", borderRadius: 10, border: "none",
            cursor: !apiKey || loading || !input.trim() ? "default" : "pointer",
            fontSize: 13, fontWeight: 700, color: "#fff",
            background: !apiKey || loading || !input.trim() ? "#ccc" : CV.navy,
            alignSelf: "flex-end",
          }}>
          {loading ? "..." : "Ask"}
        </button>
      </div>
    </div>
  );
}

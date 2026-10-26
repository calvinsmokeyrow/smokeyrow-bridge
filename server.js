// Smokey Row QuickBooks Desktop Enterprise bridge
// Receives wholesale orders from the Base44 app over HTTPS and pushes them
// into QuickBooks as sales orders via the QuickBooks Web Connector (QBWC).
//
// Plain Node.js (18+), zero npm dependencies.
//   1. Edit config.json  (API key + Web Connector password)
//   2. Run:  node server.js
//   3. Point the .qwc file and the app's QuickBooks settings at this server.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const DATA_PATH = path.join(__dirname, "data.json");

let state = { orders: {} };
if (fs.existsSync(DATA_PATH)) {
  try {
    state = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    if (!state.orders) state = { orders: {} };
  } catch {
    state = { orders: {} };
  }
}
const save = () => fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));

// ---------- helpers ----------

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// QuickBooks list names use ":" for hierarchy — never pass a raw colon through
function qbName(s) {
  return esc(String(s ?? "").replace(/:/g, "-"));
}

function textParam(body, tag) {
  const m = body.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">"));
  if (!m) return "";
  return m[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

// ---------- qbXML ----------

function buildSalesOrderRq(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = items
    .map(
      (i) => `
        <SalesOrderLineAdd>
          <ItemRef><FullName>${qbName(i.product_name)}</FullName></ItemRef>
          <Qty>${Number(i.quantity) || 0}</Qty>
          <Rate>${Number(i.unit_price || 0).toFixed(2)}</Rate>
        </SalesOrderLineAdd>`
    )
    .join("");

  const addrLines = String(order.customer?.delivery_location || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((l, i) => `<Addr${i + 1}>${esc(l.slice(0, 41))}</Addr${i + 1}>`)
    .join("");

  const today = new Date().toISOString().slice(0, 10);
  const refNumber = "W-" + String(order.request_id).replace(/-/g, "").slice(-7).toUpperCase();

  return `
    <SalesOrderAddRq requestID="${esc(order.request_id)}">
      <SalesOrderAdd>
        <Customer><FullName>${qbName(order.customer?.name)}</FullName></Customer>
        <TxnDate>${today}</TxnDate>
        <RefNumber>${refNumber}</RefNumber>
        ${addrLines ? `<ShipAddress>${addrLines}</ShipAddress>` : ""}
        <Memo>${esc(String(order.notes || "").slice(0, 4000))}</Memo>
${lines}
      </SalesOrderAdd>
    </SalesOrderAddRq>`;
}

function buildQbxmlRequest(payloads) {
  const requests = payloads.map(buildSalesOrderRq).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="13.0"?>
<QBXML>
  <QBXMLMsgsRq onError="continueOnError">
${requests}
  </QBXMLMsgsRq>
</QBXML>`;
}

// ---------- QBWC SOAP endpoint ----------

const NS = "http://developer.intuit.com/";
const OPS = [
  "serverVersion",
  "clientVersion",
  "authenticate",
  "sendRequestXML",
  "receiveResponseXML",
  "connectionError",
  "getLastError",
  "closeConnection",
  "getInteractiveURL",
  "interactiveDone",
  "interactiveRejected",
  "interactiveMode",
];

function soapEnvelope(inner) {
  return `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<SOAP-ENV:Body>${inner}</SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function handleSoap(body, res) {
  const send = (inner) => {
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(soapEnvelope(inner));
  };

  let op = null;
  for (const name of OPS) {
    if (body.includes("<" + name)) {
      op = name;
      break;
    }
  }
  if (!op) {
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    return res.end(soapEnvelope(""));
  }

  switch (op) {
    case "serverVersion":
      return send(`<serverVersionResponse xmlns="${NS}"><serverVersionResult>1.0.0</serverVersionResult></serverVersionResponse>`);

    case "clientVersion":
      return send(`<clientVersionResponse xmlns="${NS}"><clientVersionResult></clientVersionResult></clientVersionResponse>`);

    case "authenticate": {
      const pass = textParam(body, "strPassword");
      // recover orders stuck in-flight from an interrupted session
      for (const o of Object.values(state.orders)) {
        if (o.status === "in-flight" && o.sent_at && Date.now() - new Date(o.sent_at).getTime() > 15 * 60 * 1000) {
          o.status = "queued";
        }
      }
      save();
      if (pass !== config.qbwc_password) {
        return send(`<authenticateResponse xmlns="${NS}"><authenticateResult><string>none</string><string>none</string></authenticateResult></authenticateResponse>`);
      }
      const hasWork = Object.values(state.orders).some((o) => o.status === "queued");
      const ticket = crypto.randomUUID();
      return send(
        `<authenticateResponse xmlns="${NS}"><authenticateResult><string>${ticket}</string><string>${hasWork ? "" : "none"}</string></authenticateResult></authenticateResponse>`
      );
    }

    case "sendRequestXML": {
      const queued = Object.values(state.orders)
        .filter((o) => o.status === "queued")
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      if (queued.length === 0) {
        return send(`<sendRequestXMLResponse xmlns="${NS}"><sendRequestXMLResult></sendRequestXMLResult></sendRequestXMLResponse>`);
      }
      const batch = queued.slice(0, 10);
      for (const o of batch) {
        o.status = "in-flight";
        o.sent_at = new Date().toISOString();
      }
      save();
      const qbxml = buildQbxmlRequest(batch.map((o) => o.payload));
      return send(`<sendRequestXMLResponse xmlns="${NS}"><sendRequestXMLResult>${esc(qbxml)}</sendRequestXMLResult></sendRequestXMLResponse>`);
    }

    case "receiveResponseXML": {
      const hresult = textParam(body, "hresult");
      const message = textParam(body, "message");
      const response = textParam(body, "response");

      if (hresult) {
        for (const o of Object.values(state.orders)) {
          if (o.status === "in-flight") {
            o.status = "failed";
            o.error = message || hresult;
            o.updated_at = new Date().toISOString();
          }
        }
        save();
        return send(`<receiveResponseXMLResponse xmlns="${NS}"><receiveResponseXMLResult>100</receiveResponseXMLResult></receiveResponseXMLResponse>`);
      }

      for (const m of response.matchAll(/<SalesOrderAddRs([^>]*)>([\s\S]*?)<\/SalesOrderAddRs>/g)) {
        const attrs = m[1];
        const content = m[2];
        const id = (attrs.match(/requestID="([^"]*)"/) || [])[1];
        if (!id || !state.orders[id]) continue;
        const statusCode = (attrs.match(/statusCode="(\d+)"/) || [])[1];
        const statusMessage = (attrs.match(/statusMessage="([^"]*)"/) || [])[1] || "QuickBooks rejected the sales order";
        const txnId = (content.match(/<TxnID>([\s\S]*?)<\/TxnID>/) || [])[1] || "";
        const refNumber = (content.match(/<RefNumber>([\s\S]*?)<\/RefNumber>/) || [])[1] || "";
        const o = state.orders[id];
        if (statusCode === "0") {
          o.status = "synced";
          o.txn_id = refNumber || txnId;
          o.error = "";
        } else {
          o.status = "failed";
          o.error = statusMessage;
        }
        o.updated_at = new Date().toISOString();
      }
      save();

      const remaining = Object.values(state.orders).filter((o) => o.status === "queued" || o.status === "in-flight").length;
      return send(
        `<receiveResponseXMLResponse xmlns="${NS}"><receiveResponseXMLResult>${remaining > 0 ? "0" : "100"}</receiveResponseXMLResult></receiveResponseXMLResponse>`
      );
    }

    case "getLastError":
      return send(`<getLastErrorResponse xmlns="${NS}"><getLastErrorResult></getLastErrorResult></getLastErrorResponse>`);

    case "connectionError":
      return send(`<connectionErrorResponse xmlns="${NS}"><connectionErrorResult>done</connectionErrorResult></connectionErrorResponse>`);

    case "closeConnection":
      return send(`<closeConnectionResponse xmlns="${NS}"><closeConnectionResult>OK</closeConnectionResult></closeConnectionResponse>`);

    default:
      res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
      return res.end(soapEnvelope(""));
  }
}

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let raw = "";
  for await (const chunk of req) raw += chunk;

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  };

  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  // The Web Connector talks SOAP here
  if (url.pathname === "/qbwc") return handleSoap(raw, res);

  // App-facing endpoints — require the shared API key
  if (req.headers["x-api-key"] !== config.api_key) {
    return json(401, { ok: false, message: "Invalid API key" });
  }

  if (url.pathname === "/orders" && req.method === "POST") {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(400, { ok: false, message: "Invalid JSON body" });
    }
    const id = payload && payload.request_id;
    if (!id) return json(400, { ok: false, message: "Missing request_id" });

    const existing = state.orders[id];
    if (existing && existing.status === "synced") {
      return json(200, { ok: true, status: "duplicate", txn_id: existing.txn_id, message: "Already in QuickBooks" });
    }
    if (existing && existing.status === "queued") {
      return json(200, { ok: true, status: "queued", message: "Already queued for QuickBooks" });
    }

    state.orders[id] = {
      status: "queued",
      payload,
      txn_id: "",
      error: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    save();
    return json(200, { ok: true, status: "queued", message: "Order queued for QuickBooks" });
  }

  if (url.pathname === "/status" && req.method === "POST") {
    let ids = [];
    try {
      ids = (JSON.parse(raw).ids || []).slice(0, 50);
    } catch {
      ids = [];
    }
    const out = {};
    for (const id of ids) {
      const o = state.orders[id];
      out[id] = o
        ? { status: o.status === "in-flight" ? "queued" : o.status, txn_id: o.txn_id || "", error: o.error || "" }
        : null;
    }
    return json(200, out);
  }

  if (url.pathname === "/test" && req.method === "POST") {
    const waiting = Object.values(state.orders).filter((o) => o.status === "queued" || o.status === "in-flight").length;
    return json(200, {
      ok: true,
      message: `Bridge is up. ${waiting} order(s) waiting for the QuickBooks Web Connector.`,
    });
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(config.port || 8647, () => {
  console.log(`Smokey Row QuickBooks bridge listening on port ${config.port || 8647}`);
  console.log(`Web Connector endpoint: http://localhost:${config.port || 8647}/qbwc`);
});
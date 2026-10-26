# Smokey Row QuickBooks Bridge

This small service connects your wholesale app to QuickBooks Desktop
Enterprise. The app queues confirmed orders here, and the QuickBooks Web
Connector (the "Web Connector" window you already have open) picks them up
every few minutes and creates a **sales order** in your company file.

## What you need

- Node.js 18 or later installed on the machine that runs the bridge
  (usually the same machine as QuickBooks). Get it from https://nodejs.org.
- The QuickBooks Web Connector (comes with QuickBooks Desktop).
- A test company file open in QuickBooks while you're testing.

## Setup

1. **Copy this folder** (`quickbooks-bridge`) to the machine that will run it.

2. **Edit `config.json`**:
   - `api_key` — make up a long random string. You'll paste the same value in
     the app under Orders → QuickBooks → Bridge API Key.
   - `qbwc_password` — make up a password. The Web Connector asks for it
     whenever it connects.

3. **Start the bridge** (double-click `start-bridge.bat`, or run):
   ```
   node server.js
   ```

4. **Give it an HTTPS URL** so the app (a secure https site) and the Web
   Connector can reach it. The simplest way on a Windows machine is a tunnel:
   ```
   ngrok http 8647
   ```
   Copy the https URL it prints (e.g. `https://ab12cd34.ngrok-free.app`).
   For testing only, `http://localhost:8647` also works in the app while
   you browse with Chrome on the same machine.

5. **Edit `SmokeyRowBridge.qwc`** and replace
   `REPLACE-WITH-YOUR-BRIDGE-URL` with your URL from step 4.

6. **In the app**: Orders → QuickBooks button → set
   - Bridge URL: your URL from step 4 (e.g. `https://ab12cd34.ngrok-free.app`)
   - Bridge API Key: the `api_key` from `config.json`
   - Enable QuickBooks sync → Save → **Test connection** should succeed.

7. **In the Web Connector** (already open):
   - "Add an Application" → pick `SmokeyRowBridge.qwc` → Open.
   - Confirm it's OK to run → when it asks for a password, enter the
     `qbwc_password` from `config.json` (check "Save password").
   - Select the row and click **Update Selected** to force a first run.
   - Leave the schedule at every 5 minutes.

8. **Test it end to end**: confirm an order in the app. It shows
   "Sending to QuickBooks…". Within ~5 minutes the Web Connector creates the
   sales order and the app shows "In QuickBooks · W-XXXXXXX". If QuickBooks
   rejects it, the app shows the reason on the order with a Retry button.

## How QuickBooks must be prepared

- The **customer name** on the order must match a customer in your QuickBooks
  customer list (e.g. "Smokey Row Café"). If it's missing, the order fails
  with QuickBooks' message telling you the customer wasn't found — add the
  customer, then hit Retry in the app.
- Each **product name** must match an item in your QuickBooks item list.
- QuickBooks Desktop must be open with the company file while the Web
  Connector runs.

## Production notes

- The bridge saves its queue to `data.json` in this folder, so queued orders
  survive a restart.
- Keep the bridge running whenever orders may come in (Task Scheduler or a
  service wrapper like nssm works well).
- A free ngrok URL changes every restart — for production use a fixed tunnel
  (ngrok paid plan, Cloudflare Tunnel, or hosting the bridge on a small
  always-on server/PC).
- Re-syncing is safe: an order already in QuickBooks is never queued twice.
# Changelog

## 1.9.0

- **Routing test**, a new tab: up to 4 vendors and 4 clients at once, to test prefix routing.
  - Each vendor has its own port, system_id, the prefixes it should get, and its own behaviour (response delay, DLR delay, failed DLRs, TPS limit)
  - Each client is a separate customer account with its own sessions, window, TPS and a weighted prefix mix (`9053XXXXXXXX:70, 9054XXXXXXXX:30`); a saved profile can fill in its server and login
  - The client's number travels in the end-to-end marker, so each vendor counts messages per client and prefix
  - Report: client × prefix × vendor table with counts and end-to-end p95; misrouted messages with examples; lost and duplicate messages; DLRs that went to another customer than the sender; rate per client and per vendor; CSV, JSON and PDF
- Load test: recipients can be weighted (`number:weight`); without weights they take turns as before
- `tools/mini-router.js`: a small prefix router for trying the routing test without a platform, with optional misroutes, lost messages and wrong-customer DLRs

## 1.8.0

- **Window advice.** The client cannot send faster than sessions × window ÷ response time. One field test sent 9,500 TPS for a 10,000 target: 12 sessions × window 100 at 125 ms is 9,600. Now:
  - New setting *Gateway window*: the gateway account's per-session window limit (0 = unknown)
  - Under the settings, a line shows the window limit and the window needed for the target, from the last test's response p95. It warns when the window or the gateway account's window has to be raised
  - During a test, sending below the target for 3 s while every session has a full window gives an event with the needed window (target × p95 ÷ sessions + 20%). If that is above the gateway window, it says to raise the gateway account's window setting too. Also a report finding, and in the CSV
  - A start event when the client window is above the gateway window
- **Average after ramp-up**: the average TPS now leaves out the ramp-up. The average including it is still shown, in the report and in the CSV. Before, the ramp-up lowered the average (5 s of ramp-up in a 60 s test: about −4%)
- CSV: `window_full` per second
- Measured on 2 vCPU, 12 sessions, ~123 ms responses, DLRs on: 10,000 TPS with window 200 or 400 → 10,000/s; 20,000 TPS with window 400 → 19,975/s (client CPU 36%); 20,000 TPS with window 200 → 18,870/s, flagged with a needed window of 270

## 1.7.0

- **Built-in vendor under gateway load**: built to take 6,000–8,000 TPS from a gateway like a real vendor. See "Built-in vendor under load" in the README
  - submit_sm_resp no longer waits behind DLRs: responses go out first on every connection; DLRs are sent in short time slices and only while the socket is not backed up. Journal writes and compaction moved to a worker thread (before: 100–150 ms pauses, seconds with ~1M pending)
  - Retries use exponential back-off with jitter, 1 s → 30 s by default, so DLRs rejected together do not return together. MSGQFUL (0x14), THROTTLED (0x58) and other temporary errors are retried until delivered; permanent errors (0x01, 0x02, 0x03, 0x0A, 0x0B, 0x0C by default, configurable) are not retried and are counted as permanentFailed
  - Before, retries of a system_id were limited to 500/s and blocked fresh DLRs behind them, and the pending queue was capped at 1M, after which new DLRs were dropped. Now retries are not rate limited, pending DLRs are held up to 5M and nothing is dropped unless a configured limit says so (attempt limit, off by default; max age, 72 h)
  - DLR rate limit, total and per bind (off by default); the window still applies
  - DLR delay: fixed, or uniform, normal or exponential around the mean
  - Metrics: a one-line summary every 5 s in the vendor log, and `GET /metrics` / `POST /metrics/reset` on 127.0.0.1 (port = vendor port + 1000): submit_sm_resp p50/p95/p99, submit and DLR TPS, queue depth, retry waiting, rejections by code, dropped, permanentFailed, expired, CPU, heap, event-loop delay
  - New settings in the vendor panel under *Advanced DLR settings*
- Test gateway: *reject every Nth DLR* with a chosen status, to recreate a gateway that answers MSGQFUL
- `tools/vendor-load-check.js`: the acceptance run (8,000 TPS × 10 min, 10 binds, window 200), with or without 1 in 3 DLRs rejected
- Acceptance on 2 vCPU: 8,000 TPS × 10 min, 10 binds, window 200 — submit_sm_resp p99 32.5 ms at the client (1.34 ms inside the vendor), 4,779,270 of 4,779,270 DLRs, none dropped. With every third DLR rejected with MSGQFUL: p99 13.8 ms (0.83 ms), 2,388,078 rejections retried, 4,776,158 of 4,776,158 DLRs delivered, none dropped

## 1.6.0

- **DLR redelivery** in the built-in vendor, like a real SMSC. Before, a DLR the vendor could not send right away was simply lost (in one load test a gateway restart cost 7,329 DLRs). Now:
  - A DLR that cannot be delivered is kept per system_id: no RX/TRX bind for that system_id, the connection dropped before the deliver_sm_resp, an error deliver_sm_resp, or none within 30 s
  - DLRs go to any RX/TRX bind of the system_id that submitted the message, not only to the connection it came in on
  - When the system_id binds again, pending DLRs go out oldest first at a set rate (500/s by default) within the window (1,000 unconfirmed per connection); new DLRs follow in order and then flow at full speed. One log line per reconnect: "Started delivering N pending DLRs to <system_id>"
  - A DLR leaves the queue only on deliver_sm_resp status 0; errors and time-outs are retried after 1, 2, 4 … 60 s
  - A redelivered DLR is identical to the first attempt: same id in the receipt text and in `receipted_message_id` (0x001E), same stat, err, submit date and done date. The submit date is now the real submit time
  - Pending DLRs survive a vendor restart, also a hard kill: an append-only journal in the data folder (`dlr-queue-<port>.log`), compacted as it grows. Kept for 72 hours by default, then dropped and counted as expired
  - Counters: pending per system_id, redelivered, retried, expired, dropped. Settings in the vendor panel: DLR redelivery on/off (on by default), redelivery rate, retention
- Fix: the vendor did not recognise deliver_sm_resp (command id compared as a signed number); it is now used to confirm DLRs
- `tools/dlr-redelivery-check.js`: 10,000 submits, gateway away for 30 s, with and without a vendor restart or crash in between; every DLR arrives once with the right message_id
- Normal flow unchanged: 10,000 TPS with DLRs on 2 vCPU, also with the journal on

## 1.5.1

- Fix: the built-in vendor's message_ids could repeat. They were a 6-hex-digit counter that started again from `100000` whenever the vendor process restarted, so a gateway could match a DLR to the wrong submit. Ids now look like `19A31B2C4F07A3C-1F4`: the start time in ms plus 16 random bits, renewed on every start, then a counter that never wraps. About 20 characters, inside SMPP 3.4's 65-byte limit; the dash keeps gateways from converting the id between hex and decimal
- The DLR uses the same id in the receipt text (`id:`) and in the `receipted_message_id` TLV (0x001E), as before; a test now checks both against submit_sm_resp
- New vendor setting *Reuse message_id every N* (test scenario, 0 = off by default) to see how a platform copes with repeated ids
- Test: 1,000,000 submits with a vendor restart in between, plus a vendor in a second process, produce no duplicate message_id

## 1.5.0

- **Vendor messages**: a new tab lists the last 1,000 messages that reached the built-in vendor, decoded: account (system_id), sender, recipient, data_coding with its alphabet (GSM7, UCS2, Latin-1, IA5, binary; GSM 03.38 coding groups such as 0x10 / 0xF0 too), concatenated part from the UDH, text with control characters shown, and the raw short_message in hex. Search, auto refresh, CSV export, clear
- The vendor keeps the raw bytes and decodes only when the list is opened, so throughput at 10,000 TPS is unchanged

## 1.4.0 — first public release

- Interface in English and Turkish, with a language switch
- Desktop builds for macOS, Windows and Linux; Docker image on GitHub Container Registry
- Automated tests (`npm test`) for the client, load engine, analysis and translations
- Fix: step-change events could repeat in the report timeline
- Fix: Docker data folder ownership is corrected on start
- Fix: a load test no longer hangs when the platform never answers a bind; it continues with the sessions that bound

## 1.3.0

- Performance reports: latency onset, saturation point and cause, peak capacity, latency drift, acceptance criteria with pass/fail
- Step (staircase) load tests
- Report archive, report page with charts, PDF / CSV / JSON export
- Vendor processing capacity setting to simulate a slow operator

## 1.2.0

- Web server edition with password login, shared state across browsers, Docker image
- Vendor settings persist across restarts

## 1.1.0

- Load test mode: parallel binds, window, token-bucket rate control, throttle back-off, live charts
- Built-in vendor reachable from the network, end-to-end tracking (loss, duplicates, latency)

## 1.0.0

- Desktop SMPP client: bind, submit_sm (GSM-7 / Latin-1 / UCS-2, UDH / message_payload), DLR and MO, PDU log, profiles

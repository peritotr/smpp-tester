# Changelog

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

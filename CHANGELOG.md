# Changelog

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

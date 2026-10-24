# Changelog

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

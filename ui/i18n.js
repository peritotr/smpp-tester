// Minimal i18n: English source strings are the keys; other languages map them to translations.
// Works in the browser (window.I18N) and in Node (module.exports, English only).
//
// Markup:  <span data-i18n>English text</span>            → text content is translated
//          <input placeholder="…" data-i18n-attr="placeholder,title">  → listed attributes are translated
// Code:    I18N.t('Sent {n} messages', { n: 5 })
//          I18N.msg({ key, p, text } | string)            → translates messages coming from the backend
//
// To add a language: add a dictionary to DICTS, an entry to LOCALES and an <option> to the language selects.
// `node tools/i18n-keys.js` lists strings that are missing from the Turkish dictionary.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.I18N = factory(root);
})(typeof self !== 'undefined' ? self : this, function (win) {
  // Technical terms that stay the same in every language
  const SAME = ['DLR', 'Throttle', 'p50', 'p95', 'p99', 'TPS', 'Window', 'OK'];

  const TR = {
    // ---- General ----
    'Server': 'Sunucu', 'Save': 'Kaydet', 'Delete': 'Sil', 'Cancel': 'İptal', 'Rename': 'Ad', 'Refresh': 'Yenile',
    'Start': 'Başlat', 'Stop': 'Durdur', 'Send': 'Gönder', 'Export': 'Dışa aktar', 'Clear': 'Temizle', 'Yes': 'Evet', 'No': 'Hayır',
    'Log out': 'Çıkış', 'Date': 'Tarih', 'Name': 'Ad', 'Type': 'Tür', 'Time': 'Saat', 'Text': 'Metin', 'From': 'Kimden', 'To': 'Kime',
    'Content': 'İçerik', 'Status': 'Durum', 'Result': 'Sonuç', 'Issues': 'Sorun', 'Target': 'Hedef', 'Capacity': 'Kapasite',
    'Passed': 'Geçti', 'Failed': 'Kaldı', 'none': 'yok', 'pending': 'bekliyor', 'step': 'basamak', 'State': 'Durum',
    'Password': 'Şifre', 'Advanced': 'Gelişmiş', 'Connect': 'Bağlan', 'Disconnect': 'Kes', 'Send enquire_link': 'enquire_link gönder',
    // ---- Connection ----
    '— Profile —': '— Profil —', 'Save profile': 'Profili kaydet', 'Delete profile': 'Profili sil', 'Profile name': 'Profil adı',
    'Delete "{name}"?': '"{name}" silinsin mi?', 'Verify certificate': 'Sertifikayı doğrula', 'Interface ver.': 'Arayüz sürümü',
    'Enquire (s)': 'Enquire (sn)', 'Connect timeout (s)': 'Bağlantı zaman aşımı (sn)',
    'disconnected': 'bağlı değil', 'connecting…': 'bağlanıyor…', 'binding…': 'bind…', 'bound': 'bağlı', 'error': 'hata',
    'Bind rejected: {status}': 'Bind reddedildi: {status}', 'Host is empty': 'Host boş', 'Not bound': 'Bağlı değil', 'Socket write error': 'Soket yazma hatası',
    // ---- Vendor ----
    'Vendor (built-in SMSC)': 'Vendor (dahili SMSC)',
    // ---- Vendor messages ----
    'Vendor messages': "Vendor'a gelenler", 'Account': 'Hesap', 'Auto refresh': 'Otomatik yenile', 'Message ID': 'Mesaj ID', 'Part': 'Parça',
    'Search number, account, message ID or text': 'Numara, hesap, mesaj ID veya metin ara',
    'data_coding of the submit_sm, with the alphabet it means': "submit_sm'deki data_coding ve karşılık geldiği alfabe",
    '(binary, see hex)': '(binary, hex\'e bak)', 'No message matches.': 'Eşleşen mesaj yok.',
    'No messages yet. Point your platform at the vendor and send one.': "Henüz mesaj yok. Platformunu vendor'a yönlendirip bir mesaj gönder.",
    'Raw short_message (hex)': 'Ham short_message (hex)',
    'Received since the vendor started: {n} · last {kept} kept here': 'Vendor başladığından beri gelen: {n} · son {kept} tanesi burada',
    'Sender TON {s} · recipient TON {d} · data_coding {dcs} · {b} bytes{udh} · DLR requested: {reg}': 'Gönderen TON {s} · alıcı TON {d} · data_coding {dcs} · {b} bayt{udh} · DLR istendi: {reg}',
    'The vendor is not running. Start it on the left; messages your platform sends to it appear here.': "Vendor çalışmıyor. Soldan başlat; platformunun ona gönderdiği mesajlar burada görünür.",
    'by encoding: {list}': 'kodlamaya göre: {list}', 'no': 'hayır', 'yes': 'evet', '{n} match': '{n} eşleşme',
    'A mock vendor/supplier your platform connects to. Accepts messages and generates DLRs. Also useful for trying the tool without an external server.':
      'Platformunun bağlanacağı sahte vendor/supplier. Gelen mesajları kabul eder, DLR üretir. Dış sunucu olmadan denemek için de kullanılabilir.',
    'Listen on': 'Dinleme', 'This machine only (127.0.0.1)': 'Sadece bu makine (127.0.0.1)', 'Network (0.0.0.0)': 'Ağdan erişilebilir (0.0.0.0)',
    'DLR delay (ms)': 'DLR gecikme (ms)', 'Leave empty to accept any bind': 'Boş bırakılırsa her bind kabul edilir', '(any)': '(herkes)',
    'Vendor password': 'Vendor şifre', 'DLR failure %': 'DLR hata oranı %', 'TPS limit': 'TPS limiti',
    'Above this rate ESME_RTHROTTLED is returned (0 = unlimited)': 'Bu değerin üstünde ESME_RTHROTTLED döner (0 = sınırsız)',
    'Response delay (ms)': 'Yanıt gecikmesi (ms)', 'Processing capacity (TPS)': 'İşleme kapasitesi (TPS)',
    'The vendor processes at most this many messages per second; the rest wait in a queue and responses slow down (0 = unlimited). Simulates a slow operator.':
      'Vendor saniyede en fazla bu kadar mesaj işler; fazlası kuyrukta bekler ve yanıt gecikir (0 = sınırsız). Yavaş bir operatörü taklit eder.',
    'MO text': 'MO metni', 'Send MO': 'MO gönder', 'Add this as a vendor on your platform:': 'Platformunda vendor olarak tanımla:',
    'No IP found': 'IP bulunamadı', 'system_id/password: any': 'system_id/şifre: herhangi biri', 'this machine only': 'sadece bu makineden',
    'public IP': 'genel IP',
    'The vendor is not running or has no transceiver/receiver session bound.': 'Vendor çalışmıyor veya ona bağlı (transceiver/receiver) oturum yok.',
    'Bound {conns} · received {rx}/s · throttled {thr}/s · DLR {dlr}/s · pending DLR {pend}': 'Bağlı {conns} · alınan {rx}/sn · throttle {thr}/sn · DLR {dlr}/sn · bekleyen DLR {pend}',
    'queue {n}': 'kuyruk {n}', 'Vendor listening on {host}:{port}': 'Vendor {host}:{port} dinliyor',
    'Vendor listening on {host}:{port} (limit {tps} TPS)': 'Vendor {host}:{port} dinliyor (limit {tps} TPS)', 'Vendor stopped': 'Vendor durduruldu',
    'Port {port} is already in use': 'Port {port} kullanımda', 'No permission for port {port} (choose a port above 1024)': 'Port {port} için izin yok (1024 üstü bir port seç)',
    // ---- Single test ----
    'Single test': 'Tekil test', 'Load test': 'Yük testi', 'Reports': 'Raporlar', 'Sender': 'Gönderen', 'Recipient': 'Alıcı',
    '5 Alphanumeric': '5 Alfanümerik', '1 International': '1 Uluslararası', '0 Unknown': '0 Bilinmiyor', '2 National': '2 Ulusal', '6 Abbreviated': '6 Kısaltılmış',
    'Message text… ({n} is replaced with the sequence number in batch sends)': 'Mesaj metni… (toplu gönderimde {n} sıra numarasıyla değişir)',
    'Encoding': 'Kodlama', 'Auto': 'Otomatik', 'Long message': 'Uzun mesaj', 'UDH (concatenated)': 'UDH (parçalı)', "Don't split": 'Bölme',
    'Request DLR': 'DLR iste', 'Count': 'Adet', 'Sent': 'Gönderilen', 'Inbox (DLR / MO)': 'Gelen (DLR / MO)', 'PDU log': 'PDU log',
    'Hide enquire_link': 'enquire_link gizle', 'Enc.': 'Kod', 'Parts': 'Parça',
    'chars': 'kar.', 'septets': 'septet', 'bytes': 'bayt', '{n} part(s)': '{n} parça',
    'Text does not fit the GSM 03.38 alphabet': 'Metin GSM 03.38 alfabesine sığmıyor', 'Text is not Latin-1': 'Metin Latin-1 değil',
    'Done: {ok} OK, {fail} failed · {secs} s · {rate} msg/s': 'Bitti: {ok} OK, {fail} hata · {secs} sn · {rate} msg/sn',
    'Sent {sent} · Accepted {acc} · Rejected {rej} · DLR ✓{ok} ✗{fail}': 'Gönderilen {sent} · Kabul {acc} · Red {rej} · DLR ✓{ok} ✗{fail}',
    'unmatched id {id}': 'eşleşmeyen id {id}',
    // ---- Load test form ----
    'Recipient (X = random digit)': 'Alıcı (X = rastgele rakam)',
    'Each X is replaced with a random digit per message. Separate several recipients with commas.': "X'ler her mesajda rastgele rakamla değişir. Virgülle birden fazla alıcı yazılabilir.",
    'Test name': 'Test adı', "Shown in the reports list, e.g. 'v2.3 — 10k target'": "Raporlar listesinde görünür, ör. 'v2.3 — 10k hedef'", '(optional)': '(opsiyonel)',
    'Message': 'Mesaj', 'Sessions': 'Oturum', 'Number of parallel binds (sessions)': 'Paralel bind (oturum) sayısı',
    'Max submit_sm in flight per session without a response': 'Oturum başına yanıt beklenmeden havada tutulabilecek submit_sm sayısı',
    'Target TPS': 'Hedef TPS', 'Test type': 'Test tipi',
    'Step: climbs from the start TPS to the target in steps; the best way to find the load at which latency starts': "Kademeli: başlangıç TPS'ten hedef TPS'e basamak basamak çıkar; gecikmenin hangi yükte başladığını bulmanın en iyi yolu",
    'Constant — duration': 'Sabit — süre', 'Constant — count': 'Sabit — adet', 'Step': 'Kademeli', 'Constant': 'Sabit',
    'Duration (s)': 'Süre (sn)', 'Start TPS': 'Başlangıç TPS', 'TPS of the first step': "İlk basamağın TPS'i", 'Increment (TPS)': 'Artış (TPS)',
    'TPS added at each step': 'Her basamakta eklenen TPS', 'Step (s)': 'Basamak (sn)', 'Duration of each step': 'Her basamağın süresi',
    'Time to ramp up to the target TPS': "Hedef TPS'e kademeli çıkış süresi", 'Response limit (s)': 'Yanıt limiti (sn)',
    'A submit_sm without a response within this time counts as a timeout': 'submit_sm_resp bu süre içinde gelmezse zaman aşımı sayılır',
    'DLR wait (s)': 'DLR bekleme (sn)', 'Measure end-to-end (client → platform → vendor)': 'Uçtan uca ölç (client → platform → vendor)',
    'A #T… marker is appended to the message; the built-in vendor picks it up to measure end-to-end latency, loss and duplicates': 'Mesaja #T… işareti eklenir; dahili vendor yakalayıp uçtan uca gecikme, kayıp ve çift teslimi ölçer',
    'Slow down and retry on throttle': "Throttle'da yavaşla ve tekrar dene",
    'On ESME_RTHROTTLED / ESME_RMSGQFUL, slow down and resend the message': 'ESME_RTHROTTLED / ESME_RMSGQFUL gelince hızı düşür ve mesajı tekrar gönder',
    'Acceptance criteria': 'Kabul ölçütleri', 'Response p95 ≤ (ms)': 'Yanıt p95 ≤ (ms)', 'Response p99 ≤ (ms)': 'Yanıt p99 ≤ (ms)',
    'End-to-end p95 ≤ (ms)': 'Uçtan uca p95 ≤ (ms)', 'Errors ≤ %': 'Hata ≤ %', 'Loss ≤ %': 'Kayıp ≤ %', 'Min TPS': 'En az TPS',
    'Defaults to the target TPS when empty': 'Boş bırakılırsa hedef TPS', 'target': 'hedef',
    'Open report': 'Raporu aç', 'Open report · Passed': 'Raporu aç · Geçti', 'Open report · Failed': 'Raporu aç · Kaldı',
    'Export CSV': 'CSV dışa aktar', 'Start test': 'Testi başlat',
    // ---- Load test live view ----
    'Current send rate': 'Anlık gönderim', 'Current success rate': 'Anlık başarılı', 'Average': 'Ortalama',
    'Response p50 / p95 / p99': 'Yanıt p50 / p95 / p99', 'Accepted': 'Başarılı', 'Errors': 'Hata', 'Timeouts': 'Zaman aşımı',
    'In flight': 'Havada (inflight)', 'DLR latency p50 / p95': 'DLR gecikme p50 / p95', 'Reached vendor': "Vendor'a ulaşan",
    'Not yet arrived / lost': 'Henüz ulaşmayan / kayıp', 'Duplicates': 'Çift teslim', 'End-to-end p50 / p95 / p99': 'Uçtan uca p50 / p95 / p99',
    'submit_sm_resp latency (ms)': 'submit_sm_resp gecikmesi (ms)', 'Error codes': 'Hata kodları', 'DLR statuses': 'DLR durumları', 'Notes': 'Notlar',
    'Connection details come from the Server section on the left. TPS = submit_sm PDUs per second. Long text is sent in a single PDU using message_payload.':
      "Bağlantı bilgileri soldaki Sunucu bölümünden alınır. TPS = saniyedeki submit_sm PDU sayısı. Uzun metin tek PDU'da message_payload ile gider.",
    'No errors': 'Hata yok', '({n} retried)': '({n} tekrar)', '{n} unmatched': '{n} eşleşmeyen', '{n} pending': '{n} bekleyen',
    'End-to-end p95': 'Uçtan uca p95',
    '{n} steps · {from} → {to} TPS · ~{min} min total': '{n} basamak · {from} → {to} TPS · toplam ~{min} dk',
    'Enter the server details on the left first.': 'Önce soldan sunucu bilgilerini gir.',
    'Sessions × window looks low for the target TPS; if responses are slow the target may not be reached. Start anyway?':
      'Oturum × Window, hedef TPS için düşük görünüyor; yanıt gecikmesi yüksekse hedefe ulaşılamayabilir. Yine de başlatılsın mı?',
    'End-to-end measurement needs the vendor on the left to be running and your platform to route messages to it. The vendor is stopped. Start anyway?':
      "Uçtan uca ölçüm için soldaki Vendor'ın çalışıyor olması ve platformunun mesajları ona yönlendirmesi gerekir. Vendor şu an kapalı. Yine de başlatılsın mı?",
    'Starting…': 'Başlatılıyor…', 'Stopping… (press again to finish without waiting)': 'Durduruluyor… (tekrar basarsan beklemeden biter)',
    'Error': 'Hata', 'Test finished': 'Test tamamlandı', 'Last test finished': 'Son test tamamlandı', 'Running': 'Çalışıyor',
    'Binding {n} sessions…': '{n} oturum bağlanıyor…', 'Sending': 'Gönderiliyor', 'Waiting for responses and DLRs…': 'Yanıt ve DLR bekleniyor…',
    'Waiting for responses…': 'Yanıtlar bekleniyor…', 'Done': 'Bitti', 'Stopped while binding': 'Bind aşamasında durduruldu', 'Stopped': 'Durduruldu',
    'No session could bind': 'Hiçbir oturum bağlanamadı', 'A test is already running': 'Zaten çalışan bir test var', 'Recipient is empty': 'Alıcı boş',
    'The load engine process exited': 'Yük süreci kapandı', 'Lost connection to the server': 'Sunucu bağlantısı koptu',
    'Lost connection to the server, reconnecting…': 'Sunucu bağlantısı koptu, yeniden bağlanılıyor…',
    'Session {n}: no bind response within {s} s (the platform bind limit may be reached)': 'Oturum {n}: {s} sn içinde bind yanıtı gelmedi (platformun bind sınırı dolmuş olabilir)',
    'Session {n}: {msg}': 'Oturum {n}: {msg}', 'Session {n} error: {msg}': 'Oturum {n} hata: {msg}', 'Session {n} bind rejected: {status}': 'Oturum {n} bind reddedildi: {status}',
    'MO received from {from}': 'MO alındı: {from}',
    // ---- CSV ----
    'SMPP Tester load test': 'SMPP Tester yük testi', 'Retries': 'Tekrar', 'Average TPS': 'Ortalama TPS', 'Response ms': 'Yanıt ms',
    'other': 'diğer', 'unmatched': 'eşleşmeyen', 'End-to-end': 'Uçtan uca', 'reached vendor': "vendor'a ulaşan", 'missing': 'ulaşmayan',
    'duplicates': 'çift', 'WARNING': 'UYARI', 'ISSUE': 'SORUN',
    // ---- Reports list ----
    'A report is saved automatically when each load test finishes. Click a row to open it.': 'Her yük testi bitince raporu otomatik kaydedilir. Satıra tıkla, rapor açılır.',
    'Latency onset': 'Gecikme başladı', 'No reports yet.': 'Henüz rapor yok.',
    'No reports yet. They appear here when a load test finishes.': 'Henüz rapor yok. Yük testi bitince burada görünür.', 'Delete this report?': 'Bu rapor silinsin mi?',
    // ---- Report page ----
    'SMPP Tester · Test report': 'SMPP Tester · Test raporu', 'Download CSV': 'CSV indir', 'Download JSON': 'JSON indir', 'Save as PDF': 'PDF olarak kaydet',
    'Loading report…': 'Rapor yükleniyor…', 'Report not found': 'Rapor bulunamadı', 'It may have been deleted.': 'Silinmiş olabilir.',
    'Step load test': 'Kademeli yük testi', 'PASSED': 'GEÇTİ', 'FAILED': 'KALDI', 'No criteria': 'Ölçüt yok',
    'The platform ran without a latency increase <b>up to {good} TPS</b>; it saturated at the <b>{knee} TPS</b> step.': "Platform <b>{good} TPS'e kadar</b> gecikme artışı olmadan çalıştı; <b>{knee} TPS</b> basamağında doydu.",
    'The platform ran without a latency increase <b>up to {good} TPS</b>; latency rose at the <b>{knee} TPS</b> step.': "Platform <b>{good} TPS'e kadar</b> gecikme artışı olmadan çalıştı; <b>{knee} TPS</b> basamağında gecikme arttı.",
    'The platform ran without a latency increase or saturation <b>up to {max} TPS</b>, the highest load tested.': "Platform test edilen en yüksek yük olan <b>{max} TPS'e kadar</b> gecikme artışı ve doyma olmadan çalıştı.",
    'Target {target} TPS; the platform sustained at most <b>{cap} TPS</b>': 'Hedef {target} TPS; platform en fazla <b>{cap} TPS</b> sürdürdü',
    ', and latency started rising at <b>~{tps} TPS</b>': ", gecikme <b>~{tps} TPS</b>'te artmaya başladı",
    'The platform sustained the target <b>{tps} TPS</b> without issues{dur}; p95 response {p95} ms.': "Platform hedeflenen <b>{tps} TPS</b>'i{dur} sorunsuz sürdürdü; p95 yanıt {p95} ms.",
    ' for {s} s': ' {s} sn boyunca',
    'Peak capacity': 'En yüksek kapasite', 'TPS · 10 s avg.': 'TPS · 10 sn ort.', 'Latency onset step': 'Gecikme başladığı basamak',
    'Latency onset load': 'Gecikme başladığı yük', 'Sustained': 'Sürdürülen', 'TPS · steady state': 'TPS · kararlı bölüm',
    'Baseline latency (p95)': 'Taban gecikme (p95)', 'ms · at low load': 'ms · düşük yükte', 'not measured': 'ölçülmedi',
    'Error rate': 'Hata oranı', 'Lost / duplicate': 'Kayıp / çift', 'messages': 'mesaj', 'Findings': 'Bulgular',
    'Criterion': 'Ölçüt', 'Limit': 'Sınır', 'Measured': 'Ölçülen',
    'Load: target vs. actual TPS': 'Yük: hedef ve gerçekleşen TPS',
    'Vertical lines: {steps}latency onset (yellow), saturation (red), session drops.': 'Dikey çizgiler: {steps}gecikmenin başladığı an (sarı), doyma (kırmızı), oturum kopmaları.',
    'step changes (thin), ': 'basamak geçişleri (ince), ',
    'Response latency (submit_sm_resp)': 'Yanıt gecikmesi (submit_sm_resp)',
    'Dotted line: baseline p95 at low load ({ms} ms).': 'Noktalı çizgi: düşük yükteki taban p95 ({ms} ms).',
    'Dashed red: acceptance limit ({ms} ms).': 'Kesik kırmızı: kabul sınırı ({ms} ms).',
    'Latency vs. load': 'Gecikme – yük ilişkisi',
    'Each dot is one second: accepted TPS on the x axis, p95 latency on the y axis. Where the curve bends is the load at which the platform starts adding latency':
      'Her nokta bir saniye: yatayda o saniyede kabul edilen TPS, dikeyde p95 gecikme. Eğrinin kırıldığı yer, platformun gecikme üretmeye başladığı yüktür',
    'Steps': 'Basamaklar', 'Accepted TPS': 'Başarılı TPS', 'Clean': 'Sorunsuz', 'Latency up': 'Gecikme arttı', 'Saturated': 'Doydu', 'Throttle / errors': 'Throttle / hata',
    'The first seconds of each step are excluded as settling time. A step counts as saturated when accepted TPS is below 95% of its target.':
      "Her basamağın ilk saniyeleri oturma süresi olarak hesaba katılmadı. Başarılı TPS, hedefin %95'inin altındaysa basamak \"doydu\" sayılır.",
    'Counters': 'Sayaçlar', 'submit_sm sent': 'Gönderilen submit_sm', 'Accepted (ESME_ROK)': 'Kabul edilen (ESME_ROK)', 'Throttle / retried': 'Throttle / tekrar',
    'DLR (total)': 'DLR (toplam)', 'Unmatched DLRs': 'Eşleşmeyen DLR', 'Events': 'Olaylar', 'No events': 'Olay yok',
    'Latency started rising (p95 {ms} ms)': 'Gecikme artmaya başladı (p95 {ms} ms)', 'Accepted TPS fell below the target': 'Başarılı TPS hedefin altına düştü',
    'Test settings': 'Test ayarları', 'Step: {from} → {to} TPS, {n} steps × {s} s': 'Kademeli: {from} → {to} TPS, {n} basamak × {s} sn',
    'Constant: {tps} TPS, {amount}': 'Sabit: {tps} TPS, {amount}', '{n} messages': '{n} mesaj', 'Sessions × window': 'Oturum × window',
    'Response limit / DLR wait': 'Yanıt limiti / DLR bekleme', 'Retry on throttle': "Throttle'da tekrar", 'Sender → recipient': 'Gönderen → alıcı',
    'Message / encoding': 'Mesaj / kodlama', 'DLR / end-to-end': 'DLR / uçtan uca', 'failures': 'hata', 'limit': 'limit', 'capacity': 'kapasite',
    'Latency onset: p95 exceeding 2× the low-load baseline (at least +20 ms){crit} for 3 consecutive seconds. Saturation: accepted TPS staying below 90% of the target for 3 seconds.':
      "Gecikme başlangıcı: p95'in düşük yükteki tabanın 2 katını (en az +20 ms){crit} art arda 3 saniye aşması. Doyma: başarılı TPS'in hedefin %90'ının altında 3 saniye kalması.",
    ' or the acceptance limit': ' veya kabul sınırını',
    'Latency onset · ~{tps} TPS': 'Gecikme başladı · ~{tps} TPS', 'Saturation · {tps} TPS': 'Doyma · {tps} TPS', 'log scale': 'logaritmik ölçek',
    'p95 (median)': 'p95 (medyan)', 'p99 (median)': 'p99 (medyan)', 'p95 per second': 'Saniyelik p95',
    // ---- Analysis: criteria and findings ----
    'Response p95': 'Yanıt p95', 'Response p99': 'Yanıt p99', 'Loss': 'Kayıp', 'Sustained TPS': 'Sürdürülen TPS',
    'Nothing was sent during the test; there is no data to analyse.': 'Testte gönderim yapılmadı; analiz edilecek veri yok.',
    'throttle: the platform hit the customer TPS limit': 'throttle: platform müşteri TPS limitine takıldı',
    'session loss: some binds dropped': "oturum kaybı: bazı bind'lar koptu",
    'backpressure: platform responses slowed down and the window filled up': 'geri basınç: platform yanıtları yavaşladı, window doldu',
    'errors: the platform is rejecting submit_sm': "hatalar: platform submit_sm'leri reddediyor",
    'the test server could not send at the target rate (CPU or network)': 'test sunucusu hedef hızda gönderemedi (CPU veya ağ)',
    'Platform is clean up to {good} TPS; it saturated at the {knee} TPS step (accepted {ok} TPS).': "Platform {good} TPS'e kadar sorunsuz; {knee} TPS basamağında doydu (başarılı {ok} TPS).",
    'Platform is clean up to {good} TPS; latency rose at the {knee} TPS step (p95 {p95} ms, baseline {base} ms).': "Platform {good} TPS'e kadar sorunsuz; {knee} TPS basamağında gecikme arttı (p95 {p95} ms, taban {base} ms).",
    'All steps (up to {max} TPS) passed without a latency increase or saturation.': "Tüm basamaklar ({max} TPS'e kadar) gecikme artışı ve doyma olmadan geçti.",
    'when the target rose to {target} TPS (accepted ~{tps} TPS)': "hedef {target} TPS'e çıkınca (başarılı ~{tps} TPS)",
    'at about {tps} TPS': "yaklaşık {tps} TPS'te",
    'Latency started rising at {time}, {where}: p95 went from a {base} ms baseline to {p95} ms': "Gecikme {time}'de, {where} artmaya başladı: p95 {base} ms tabandan {p95} ms'ye çıktı",
    '(step {n})': '(basamak {n})',
    'Response latency stayed at its baseline throughout the test (p95 ≈ {p95} ms).': 'Yanıt gecikmesi test boyunca tabanında kaldı (p95 ≈ {p95} ms).',
    'End-to-end latency rose at {time}, at ~{tps} TPS (p95 {base} → {p95} ms): the platform accepts messages but forwards them to the vendor late.':
      "Uçtan uca gecikme {time}'de, ~{tps} TPS'te yükseldi (p95 {base} → {p95} ms): platform kabul ediyor ama vendor'a iletmesi gecikiyor.",
    'At {time} accepted TPS fell below the target ({ok} / {target} TPS). Likely cause: {cause}.': "{time}'de başarılı TPS hedefin altına düştü ({ok} / {target} TPS). Olası neden: {cause}.",
    'The target rate was reached and held (best 10 s average {tps} TPS).': 'Hedef hıza ulaşıldı ve korundu (en yüksek 10 sn ortalaması {tps} TPS).',
    'Latency grows over time under steady load: p95 rose ~{d} ms per minute ({from} → {to} ms). This may point to a growing queue or a resource leak.':
      'Kararlı yükte gecikme zamanla artıyor: p95 dakikada ~{d} ms yükseldi ({from} → {to} ms). Kuyruk birikmesi veya kaynak sızıntısına işaret edebilir.',
    'Latency stayed flat for {min} minutes under steady load.': 'Kararlı yükte gecikme {min} dakika boyunca sabit kaldı.',
    'Accepted TPS fluctuates (variation {cv}%); the platform or network responds unevenly.': 'Başarılı TPS dalgalı (değişkenlik %{cv}); platform veya ağ düzensiz yanıt veriyor.',
    '{n} throttle responses received (first at {time}).': "{n} throttle yanıtı geldi (ilki {time}'de).",
    '{n} submit_sm never got a response (timeout).': "{n} submit_sm'e hiç yanıt gelmedi (zaman aşımı).",
    '{failed}/{total} sessions could not bind; the test continued with {ok}.': '{failed}/{total} oturum bağlanamadı; test {ok} oturumla devam etti.',
    "Check the platform's bind limit or stale binds left from earlier runs.": "Platformun bind sınırını veya önceki denemelerden asılı kalmış bind'ları kontrol et.",
    '{n} session(s) dropped during the test (first at {time}).': "{n} oturum test sırasında koptu (ilki {time}'de).",
    'Error responses: {list}.': 'Hata yanıtları: {list}.',
    '{n} messages ({pct}%) never reached the vendor.': "{n} mesaj (%{pct}) vendor'a ulaşmadı.",
    'All {n} accepted messages reached the vendor.': "Kabul edilen {n} mesajın tamamı vendor'a ulaştı.",
    '{n} messages were delivered to the vendor more than once.': "{n} mesaj vendor'a birden fazla kez teslim edildi.",
    '{n} DLRs could not be matched to a sent message (the message_id format may differ).': '{n} DLR gönderilen bir mesajla eşleştirilemedi (message_id biçimi farklı olabilir).',
    '{n} messages had no DLR yet when the test ended.': "Test bitiminde {n} mesajın DLR'ı henüz gelmemişti.",
    // ---- Engine timeline events ----
    '{n} sessions bound, sending started': '{n} oturum bağlandı, gönderim başladı', 'Step {i}/{n}: {tps} TPS': 'Basamak {i}/{n}: {tps} TPS',
    'Session {n} disconnected': 'Oturum {n} bağlantısı koptu', 'First throttle ({status})': 'İlk throttle ({status})', 'First {status} error': 'İlk {status} hatası',
    'First response timeout': 'İlk yanıt zaman aşımı', 'Sending finished, waiting for responses and DLRs': 'Gönderim bitti, yanıt ve DLR bekleniyor',
  };

  const DICTS = { en: {}, tr: TR };
  const LOCALES = { en: 'en-US', tr: 'tr-TR' };
  const listeners = [];
  const store = {
    get() { try { return win && win.localStorage.getItem('lang'); } catch { return null; } },
    set(v) { try { win && win.localStorage.setItem('lang', v); } catch {} },
  };
  const detect = () => (win && win.navigator && /^tr\b/i.test(win.navigator.language || '')) ? 'tr' : 'en';
  let lang = (store.get() in DICTS) ? store.get() : (win ? detect() : 'en');

  const fill = (s, p) => p ? String(s).replace(/\{(\w+)\}/g, (m, k) => p[k] !== undefined ? p[k] : m) : String(s);
  function t(s, p) { const d = DICTS[lang]; return fill(d && d[s] !== undefined ? d[s] : s, p); }
  // Backend messages: { key, p, text } objects, plain strings, or undefined
  function msg(m) {
    if (m == null) return '';
    if (typeof m === 'string') return t(m);
    if (m.key) return t(m.key, m.p);
    return m.text != null ? t(m.text) : String(m);
  }
  function apply(rootEl) {
    if (!win) return;
    const doc = rootEl || win.document;
    doc.querySelectorAll('[data-i18n]').forEach(el => {
      if (el.dataset.i18nSrc === undefined) el.dataset.i18nSrc = el.textContent.replace(/\s+/g, ' ').trim();
      el.textContent = t(el.dataset.i18nSrc);
    });
    doc.querySelectorAll('[data-i18n-attr]').forEach(el => {
      for (const a of el.dataset.i18nAttr.split(',').map(x => x.trim())) {
        const k = 'i18nSrc' + a[0].toUpperCase() + a.slice(1);
        if (el.dataset[k] === undefined) el.dataset[k] = el.getAttribute(a) || '';
        if (el.dataset[k]) el.setAttribute(a, t(el.dataset[k]));
      }
    });
    win.document.documentElement.lang = lang;
  }
  function setLang(l) {
    if (!(l in DICTS) || l === lang) return;
    lang = l; store.set(l); apply();
    listeners.forEach(fn => { try { fn(lang); } catch (e) { console.error(e); } });
  }
  return {
    t, msg, apply, setLang, same: SAME,
    onChange: fn => listeners.push(fn),
    dict: l => DICTS[l] || {},
    get lang() { return lang; },
    get locale() { return LOCALES[lang] || 'en-US'; },
  };
});

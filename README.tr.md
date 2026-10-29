<div align="center">

<img src="build/icon.png" width="96" alt="SMPP Tester">

# SMPP Tester

**SMS platformunun nerede yavaşlamaya başladığını müşterilerinden önce sen gör.**

SMPP test istemcisi, 10.000 TPS'lik yük üreticisi ve sahte SMSC tek araçta.<br>
Platformunun **iki ucunu birden** oynar ve performans raporunu senin yerine yazar.

[English](README.md) · [Sunucu kurulum rehberi (EN)](docs/server-setup.md) · [Değişiklikler](CHANGELOG.md)

</div>

![Yük testi ekranı](docs/screenshots/load-test.png)

## Ne işe yarar

Bir SMSC, SMS gateway veya aggregator hub geliştiriyor ya da işletiyorsan şu soruların cevabı lazım:

- Platform gerçekte kaç TPS taşıyor, gecikme hangi yükte artmaya başlıyor?
- Kabul edilen her mesaj vendor'a ulaşıyor mu, tek sefer mi ulaşıyor?
- DLR'lar ne kadar sürede dönüyor, yük altında bu süre değişiyor mu?
- Vendor throttle verirse, yavaşlarsa ya da bağlantı koparsa ne oluyor?

SMPP Tester platformunun **iki ucunu aynı anda** oynayabilir. Bir yanda trafik basan müşteri (ESME), öbür yanda yönlendirilen trafiği alıp DLR dönen vendor (SMSC) olur. İki tarafı da gördüğü için platformun içindeki uçtan uca gecikmeyi, kaybı ve çift teslimi ölçebilir.

```
SMPP Tester (client) ──submit_sm──▶  PLATFORMUN  ──submit_sm──▶  SMPP Tester (vendor)
          ◀────────── DLR ─────────               ◀──── DLR ─────
```

## Özellikler

- **Tekil test:** Tüm bağlantı ayarları ve kayıtlı profiller var, şifreler şifrelenerek saklanır. Mesajlar GSM-7, Latin-1 veya UCS-2 olarak gönderilir. Uzun mesajlar UDH ya da `message_payload` ile parçalanır. Gönderilen mesajlar, DLR ve MO kutusu ile PDU logu ayrı ayrı görünür.
- **Yük testi:** Paralel bind, window ve hedef TPS ayarlanabilir. **Kademeli test** modu var. Throttle gelince yavaşlayıp tekrar dener. Canlı TPS ve p50/p95/p99 grafikleri gösterilir. 2 vCPU'lu bir makinede 10.000 TPS'i DLR'larla birlikte sürdürür.
- **Dahili vendor:** Platformun buna supplier olarak bağlanır. DLR gecikmesi, hata oranı, TPS limiti, yanıt gecikmesi ve işleme kapasitesi ayarlanabilir; işleme kapasitesi yavaş bir operatörü taklit eder. MO gönderebilir. **Uçtan uca takip** ile kayıp, çift teslim ve platform içi gecikme ölçülür.
- **Vendor'a gelenler:** Vendor'a ulaşan son 1.000 mesaj çözülmüş olarak listelenir: hesap, gönderen, alıcı, `data_coding` ve karşılık geldiği alfabe (GSM7, UCS2, Latin-1 …), uzun mesajlarda parça bilgisi (UDH), metin ve ham baytlar (hex). Numara ya da metinle aranabilir, CSV'ye aktarılabilir. "Mesajım ulaştı mı, hangi metinle ve hangi kodlamayla?" sorusunun cevabı.
- **Performans raporları:** Her testten sonra otomatik kaydedilir, PDF, CSV veya JSON olarak alınabilir. **Gecikmenin başladığı an ve yük**, **doyma noktası** ve nedeni, kapasite ve gecikme kayması otomatik bulunur. Kabul ölçütlerine göre **GEÇTİ / KALDI** kararı verir.
- **Arayüz İngilizce ve Türkçe** (sol üstten değiştirilir).

## Nasıl çalışır

Klasik yük araçları platformun yalnızca bir tarafını görür. Mesajı ne kadar hızlı kabul ettiğini söyleyebilirler, ama sonra ne olduğunu göremezler. SMPP Tester iki taraftadır. Her mesaja görünmez bir işaret koyar ve mesajı platformun içinden takip eder. Böylece **uçtan uca gecikmeyi, kaybı ve çift teslimi** ölçer.

Test bitince sana sayı yığını yerine düz bir cümle verir. Örneğin: *"Platform 6.000 TPS'e kadar sorunsuz; 7.000 TPS basamağında gecikme arttı; olası neden: geri basınç."* Bu cümleyi destekleyen grafikler de raporda yer alır.

**Teknolojiler:**
- **Node.js:** SMPP çekirdeği. Protokol için [node-smpp](https://github.com/farhadi/node-smpp) kullanılıyor; yük motoru ve vendor için bayt seviyesinde hızlı yollar yazıldı.
- **Electron:** Masaüstü uygulaması (macOS / Windows / Linux).
- **HTTP + WebSocket:** Sunucu sürümü, Docker ile çalışır.
- **Arayüz:** Çatısız HTML/CSS/JS, grafikler canvas ile çiziliyor.

Yük motoru ve vendor ayrı süreçlerde çalışır, bu yüzden arayüz ölçümü bozmaz. Mesaj şablonu bir kez kodlanır, her mesajda yalnızca değişen baytlar yazılır. Hız token bucket ile kontrol edilir, gecikme logaritmik histogramlarda tutulur. Bu sayede 2 vCPU'da 10.000 TPS'e ulaşılır. Çalışma anında yalnızca **iki bağımlılık** var: `smpp` ve `ws`. Ayrıntılar İngilizce README'deki *Under the hood* bölümünde.

## Kurulum

**Masaüstü:** [Releases](https://github.com/peritotr/smpp-tester/releases) sayfasından işletim sistemine uygun dosyayı indir.
- **macOS:** Uygulama imzasız. İlk açılışta **Sistem Ayarları → Gizlilik ve Güvenlik → Yine de Aç** de.
- **Windows:** SmartScreen uyarısında **Ek bilgi → Yine de çalıştır** de.

**Kaynaktan çalıştırmak için:**

```bash
git clone https://github.com/peritotr/smpp-tester.git && cd smpp-tester
npm install && npm start
```

**Sunucu (Docker):** Platformla aynı veri merkezinde, ama ayrı bir Linux sunucuda çalıştır.

```bash
mkdir smpp-tester && cd smpp-tester
curl -fsSLO https://raw.githubusercontent.com/peritotr/smpp-tester/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/peritotr/smpp-tester/main/.env.example -o .env
nano .env                    # UI_PASSWORD'ü belirle
docker compose up -d
ssh -L 8080:127.0.0.1:8080 kullanici@sunucu   # kendi bilgisayarında; sonra http://localhost:8080
```

Sunucu boyutu, güvenlik duvarı, HTTPS, platform tanımları ve test planı için: [docs/server-setup.md](docs/server-setup.md).

## Platformunu test etmek

1. Sol altta **Vendor**'ı başlat: dinleme *Ağdan erişilebilir*, port `2776`, bir system_id ve şifre gir.
2. Platformunda bu IP:port'a **transceiver** tipinde bir vendor bağlantısı tanımla. Test numara aralığını yalnızca bu vendor'a yönlendir.
3. Platformunda TPS limiti hedefin üstünde olan bir test müşterisi oluştur.
4. Sol üstte bu müşteriyle platformuna bağlan ve tek bir mesajla yolu dene.
5. **Yük testi → Kademeli** sekmesinde başlangıcı 500, artışı 500, hedefi 10.000, basamağı 60 sn yap ve *Uçtan uca ölç* seçeneğini işaretle. Test bitince raporu aç.

**Window seçimi:** Bir oturumun taşıyabileceği yük yaklaşık `window ÷ yanıt süresi` kadardır. Window'u oturum başına en az `2 × hedef TPS × yanıt süresi (sn) ÷ oturum sayısı` olarak ayarla. *Havada (inflight)* sayacı sürekli `oturum × window` değerine dayanıyorsa window dolmuş demektir. Bu, platformun yavaş yanıt verdiğini gösterir.

## Lisans

[MIT](LICENSE) © Levent Karamanlı

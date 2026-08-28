# Taven — specifikace v1.3

**Nahrazuje v1.2.** Čísla přesunuta do `taven-parametry.md`, rozhodnutí a jejich důvody do `taven-rozhodovaci-log.md`.
**Název:** pracovně Taven, záloha Taviro — **podmíněno clearance** (§14.1).
**Datum:** 2026-08-24

---

## §0 Jak s dokumentem pracovat

### 0.1 Tři artefakty

| Soubor | Mění se | Pravidlo |
|---|---|---|
| `taven-parametry.md` | týdně | jen čísla, bez ceremonie |
| **`taven-specifikace.md`** (tento) | při změně rozhodnutí | tělo; každá změna přidá záznam do logu |
| `taven-rozhodovaci-log.md` | jen přibývá | **append-only**, nikdy se needituje |

Rozdělení existuje proto, že jednorázový velký dokument se přestane udržovat ve chvíli, kdy se v něm mění cena filamentu.

### 0.2 Kdy se dokument reviduje

Událostí, ne kalendářem:

- konec shakedown měsíce
- konec reklamní kampaně
- každých 25 objednávek
- kdykoli padne některé kritérium

Mezi tím se nesahá. Hodina nad specifikací musí něco vrátit a při dvanácti objednávkách ročně nevrátí.

### 0.3 Struktura fází

Každá fáze má **obě větve**, ne jen tu úspěšnou. „Stop" není konec, je to zjištění — a z každého zjištění vede pokračování.

---

# ČÁST I — PRODUKT

## §1 Teze a fáze

### 1.1 Východisko

Bambu Lab H2S se dvěma AMS a jedním AMS HT, pořízená kvůli velikosti build plate pro vlastní projekty, není plně vytížená. **Cílem je zpeněžit existující kapacitu**, ne postavit platformu ani nahradit vývojářský příjem.

Z toho plyne pořadí i sazba práce: 300 Kč/h operátorská, protože jde o zpeněžení stojícího stroje a poloprázdného večera.

### 1.2 Diferenciace

Nekonkuruje se cenou, ale **třením**.

Kalkulačky s okamžitou cenou v ČR existují (IWant3D, ICRAM, MAWORKS, hwcave, TisknuTO, M3Dtisk), ale všichni se zastaví před **závaznou** cenou — vydají orientační odhad a pošlou to na ruční potvrzení e-mailem. Někteří z odmítání automatu dělají marketingový argument.

Nabídka Tavenu: **nahraj soubor, uvidíš závaznou cenu, zaplať, hotovo.** Cena o desítky korun vyšší je za bezbariérovost obhajitelná prémie — tak funguje každý e-shop proti telefonické objednávce.

Druhá diferenciace je **rozsah vstupu**: konkurence vyžaduje STL. Značná část lidí soubor nemá — mají rozbitý díl, fotku a posuvku. Modelářská služba tuhle skupinu obsluhuje, je nekomoditní a nedistribuovatelná do sítě.

### 1.3 Fáze v0 — validace

**Cíl:** ověřit diferenciaci, ne obecnou poptávku po tisku.

Landing s poptávkovým formulářem by ověřil jen, že v Česku existuje poptávka po zakázkovém tisku — což víme, obsluhuje ji dvacet firem. Validační verze proto obsahuje **celou cestu** `upload → preflight → slice → závazná cena → objednávka → platba`.

Vědomě přijatý důsledek: **cena odpovědi „ne" je vyšší.** Proto je v0 osekaná na kost a proto má tvrdý strop na reklamní spend.

| Obsahuje | Neobsahuje |
|---|---|
| landing se dvěma vchody | maker portál jako samostatná aplikace |
| upload, náhled, preflight | AI cokoli |
| konfigurace čtyř parametrů | node agent, automatizovaná produkce |
| OrcaSlicer, cena, meze automatu | routing, nabídkové vlny, tiery, certifikace |
| checkout a platba | výplaty |
| poptávkový formulář → `QuoteRequest` v systému | vlákno zpráv v portálu |
| jednoduchý interní seznam objednávek | plná administrace |

**Všechno za objednávkou může být manuální.** G-code se stáhne ručně, štítek se řeší mimo systém, fotky e-mailem.

Meze automatu jsou v v0 **čistě geometrické**, bez AI — nejen levnější, ale i lepší pro měření: podíl souborů procházejících automatem je deterministický a auditovatelný.

### 1.4 Fáze v1 — provozuschopná služba

Staví se **jen pokud v0 splnila kritéria**.

Přidává: produkční flow v systému (stavy, G-code přes podepsané URL, povinná fotodokumentace, štítek, podání), sledování pro zákazníka, plnou administraci, notifikace, verzovaný ceník, profilovou matici s testovacím slicem, fázovanou objednávku se zkušebním kusem a volitelný zákaznický účet s historií objednávek a funkcí `Objednat znovu` podle §7.10. Checkout ani tokenizované sledování účet nadále nevyžadují.

Makerské funkce jsou **logicky definované, fyzicky součástí administrace**.

### 1.5 Za v1

Nikoli automaticky síť. Viz **rozhodovací brána §11**.

### 1.6 Mimo rozsah

Katalog modelů, komunitní funkce, API pro e-shopy, generování modelů z textu nebo fotek AI, jiné technologie než FDM, expanze mimo ČR.

---

## §2 Režimy provozu a kritéria

### 2.1 Dva režimy, které se nesmí míchat

| | **Provoz** | **Validace** |
|---|---|---|
| Spend | nulový, organika (FB, Discord, inzeráty) | strop dle parametrů |
| Účel | vytížit stroj, nasbírat zkušenost | zjistit CAC a konverzi |
| Objem | 1–2 zakázky měsíčně | koncentrovaně, krátce |
| Kritéria | **neaplikují se** | platí |

Při jedné zakázce měsíčně se **nedozvíš nic** — nezměříš first-pass yield, konverzi po cenových pásmech ani podíl souborů v automatu. Dvanáct objednávek ročně nedá signál.

Nejhorší varianta je rok organického provozu s deseti zakázkami, po kterém vznikne pocit „nějak to funguje" a žádné číslo, podle kterého by se dalo rozhodnout o síti, druhém stroji nebo ukončení.

### 2.2 Contribution margin

```
CM = cena_celkem
     − materiál
     − variabilní strojové náklady (elektřina + opotřebení)
     − handling
     − doprava (hrubá)
     − poplatek platební brány
     − obalový materiál
```

**Reklama se do CM nezapočítává** — sleduje se zvlášť jako CAC, jinak nelze oddělit „produkt je špatný" od „kanál je drahý".

**Vlastní práce musí být oceněná.** Bez toho vypadá byznys ziskově, zatímco jde o špatně placenou práci.

### 2.3 Kritéria a jejich obě větve

**Shakedown (1 měsíc, bez reklamy)**

Účel není zjistit poptávku — to při organice nejde. Účel je najít rozbité e-maily, špatně generované štítky, falešné poplachy v preflightu a to, co se rozbije při první reálné platbě. Poslat pět tisíc cizích lidí do neodladěného checkoutu je nejdražší způsob, jak tyhle chyby najít.

```
Shakedown
 ├─ flow funguje od konce do konce  → kampaň
 └─ ne                              → opravit a opakovat; kampaň se nespouští
```

**Kampaň (strop spendu dle parametrů)**

Kampaň **neměří „valid / invalid", ale „first-order profitable / not"**. Byznys s CM 120 Kč, CAC 170 Kč a třetinou zákazníků, kteří objednají podruhé organicky, je zdravý — jen se nezaplatí z první objednávky.

```
CAC ≤ CM první objednávky
 ├─ ano → placená akvizice funguje okamžitě; v1, brána §11
 └─ ne  → nevyhozeno, ale posunuto na payback přes repeat rate a LTV
          zjištění: jednorázový B2C zákazník za čtyři stovky se nedá koupit z jedné objednávky
          ├─ opakovanost je vysoká? → CAC se rozpustí přes životnost zákazníka;
          │                           pokračovat, ale počítat LTV, ne první objednávku
          ├─ organika a SEO?        → pomalejší, ale CAC ~0; klín „překreslení
          │                           a tisk náhradního dílu"
          ├─ jiný segment?          → B2B a opakované dávky, kde jsou objednávky
          │                           za tisíce a handling se rozpustí
          └─ nic z toho             → hobby režim natrvalo (§2.4)
```

**Pozor na očekávanou hodnotu.** Při CM kolem 110 Kč koupí pětitisícový rozpočet řádově 300–600 prokliků, z toho 6–18 objednávek, tedy CAC mezi 280 a 830 Kč. **Kritérium `CAC ≤ CM` ta kampaň s velkou pravděpodobností nesplní** — a není to chyba testu, je to vlastnost byznysu s objednávkami za čtyři stovky.

Proto je otázka **„jaký podíl zákazníků se vrací"** hlavní otázkou **škálovatelné placené akvizice** — ne celého projektu.

Rozdíl je podstatný. Může vyjít vysoký podíl organiky, drahý CAC z vyhledávání, nízká opakovanost, zdravá contribution margin **a stroj se přesto rozumně vytěžuje.** Pro původní cíl z §1.1 je to plně platný výsledek; jen z toho nebude byznys, který se dá škálovat nákupem návštěvnosti. Přesně proto existuje hobby režim (§2.4) jako navržený konec, ne jako neúspěch.

**Podíl souborů procházejících automatem**

```
> 60 %  → produkt, který v ČR nikdo nemá
30–60 % → funguje, ale meze automatu potřebují ladit
< 30 %  → měl trh pravdu; automat je slepá ulička,
          zbývá služba s ručním nacením jako u konkurence
```

**First-pass yield (od v1)**

```
≥ 90 % → lze škálovat
< 90 % → každá desátá objednávka znamená přetisk, dvojí dopravu
         a naštvaného zákazníka — sežere marži z devíti ostatních.
         Před sítí se to musí vyřešit, jinak se to v síti znásobí.
```

### 2.4 Hobby režim jako navržený konec

Není to útěcha, je to přijatelný koncový stav — a klade **omezení na architekturu**: v idle musí být fixní náklady téměř nulové (viz parametry §12). Projekt v hobby režimu nezabije rozhodnutí, ale otrávenost z měsíčních nákladů bez odezvy.

V hobby režimu se featury dál stavět mohou. Platí na ně jen test návratnosti z rozhodovacího logu.

---

## §3 Obchodní a právní rámec

### 3.1 Role

Platforma je **prodávající**, ne zprostředkovatel. Zákazník uzavírá smlouvu s ní, ona fakturuje, ručí za jakost a řeší reklamace.

**Vedlejší důsledek, který je zároveň obranou:** maker zákazníka nikdy nevidí, takže maker, který odejde, si neodnáší jediného zákazníka. Musel by si postavit vlastní poptávku od nuly — tedy udělat přesně to, čemu se vyhýbá a proč je v síti.

### 3.2 DPH

Neplátce. Do obratu vstupuje **celá hodnota objednávky**, ne marže. Limity a strop v objednávkách viz parametry §14, **sledovat měsíčně od první objednávky**.

Přechod na plátcovství není úprava parametru — v ten den buď zdražíš o 21 %, nebo si o 21 % seškrábeš marži. Neplátcovství je výhoda v B2C a nevýhoda v B2B; cílení na opakované B2B dávky s ním nejde dohromady.

### 3.3 Platby

| Případ | Režim |
|---|---|
| Automatická nabídka | **100 % předem** |
| Individuální nabídka, modelářská práce | záloha, doplatek před odesláním |

Tisknutý díl na míru nemá pro nikoho jiného hodnotu. Zvyklost trhu to potvrzuje.

Platba není jeden sloupec na objednávce. `Order` má kolekci `Payment`, každý se samostatnou částkou, rolí `full` / `deposit` / `balance`, stavem brány a identifikátorem transakce. Automatická nabídka má jednu `full` platbu; individuální nabídka nejméně `deposit` a `balance`. Cenový snapshot zároveň drží immutable `PaymentSchedule` se všemi plánovanými capture a jejich fee pravidly, aby cena zahrnula fixní poplatek každé transakce. Vrácení peněz se váže ke konkrétní zachycené platbě, aby šlo smířit částečné i úplné refundace. `payment_status` objednávky (`unpaid` / `partially_paid` / `paid` / `partially_refunded` / `refunded`) se odvozuje z těchto transakcí, není ručně přepisovaný stav. Stejně odvozené jsou `amount_due` a `refundable_balance` vůči právě platnému cenovému snapshotu; právě jejich nula určuje finanční vypořádání částečně splněné objednávky.

Každý `Payment` bez ohledu na roli ukládá `capture_authorized` a `capture_cutoff_at`. Při vytvoření `full | deposit` intentu je `capture_authorized = true`, `capture_cutoff_at = null` a immutable `checkout_capture_expires_at = created_at + checkout_capture_window_minutes`; `balance` používá příslušný balance/revision business deadline. Webhook capture, timeout, explicitní storno i settlement zamykají stejný řádek Payment, Order a příslušné phase/slot records, takže po uzavření capture okna nelze pozdní úspěch použít k obnovení objednávky či revize ani přepsání immutable settlementu; je pouze podkladem pro okamžitou plnou kompenzační refundaci.

`CloseInitialCaptureWindow(reason = checkout_expired | checkout_cancelled)` pro `full | deposit` pod těmito zámky atomicky nastaví `capture_authorized = false`, `capture_cutoff_at = now`, přepne dosud `pending` Payment na `voided`, zapíše idempotentní outbox void provider intentu, zruší pre-capture `OrderPhase`/sloty a uvolní jejich `PhaseReservationSet`; teprve pak Order `quoted` ukončí jako `expired | cancelled`. Capture webhook, který získá zámek před close commandem, smí potvrdit Order jen s `now < checkout_capture_expires_at` a platným nebo čerstvě atomicky reacquired kompletním setem. Pokud worker ještě neběžel, ale webhook už vidí `now ≥ checkout_capture_expires_at`, sám v téže transakci provede idempotentní close s `reason = checkout_expired`; zpoždění workeru tedy capture window neprodlužuje. Provider success po tomto cutoffu se auditovaně zapíše, ale fázi ani Order neaktivuje; Payment přejde `voided → refund_pending` a v téže transakci vznikne plná `LateCaptureCompensation(kind = initial_checkout_expired | initial_checkout_cancelled)` a `RefundTransaction` s klíčem `late_initial_capture + provider_transaction_id`. Selže-li kompletní reacquisition ještě před cutoffem, použije se stejná plná kompenzace s `kind = initial_checkout_capacity`; žádný z těchto výsledků nesmí vytvořit Job ani znovu otevřít Order.

**Brána:** rozhodující je **absence měsíčního paušálu** (viz log #39), povinné je **bankovní tlačítko vedle karty**. Schovat za jedno rozhraní — je to nejsnáze vyměnitelná komponenta.

### 3.4 Odstoupení a záruka

Podle §1837 OZ se čtrnáctidenní lhůta **nevztahuje na zboží vyrobené podle požadavků spotřebitele**. Musí být **výslovně a srozumitelně** v podmínkách a potvrzeno před objednáním.

Konstrukce záruky **odděluje vadu tisku od vady modelu**:

> Tiskneme věrně podle dodaného modelu. Pokud byl model laděný na jiné tiskárně, může se lícování lišit — to není vada tisku.

To není formalita. Zákaznické modely bývají doladěné empiricky na jedné konkrétní tiskárně a nesou její skrytou kompenzaci; na kalibrovaném stroji pak **vyjdou přesněji a přestanou sedět**. Nikdy neslibuj lícování, slibuj věrnost modelu.

Reklamace je samostatná entita `Claim` navázaná na objednávku, položku, fázi nebo zásilku. Lze ji otevřít po `delivered`, `completed` i `partially_fulfilled`, a pro `Shipment.lost | returned` už ve stavu agregátu `in_production` (mezifáze) nebo `shipped` (finální/jediná fáze). Terminální fulfilment stav zpětně nemění; pre-delivery incident může vytvořit náhradní zásilku/job nebo finančně vypořádané storno, každý výsledek s vlastním auditem.

Při přijetí objednávky se snapshotuje verze reklamační politiky z přijatých podmínek; při doručení každé položky nebo fáze z ní vznikne konkrétní `claim_until`. Standardní samoobslužný `Claim` lze otevřít do příslušného termínu; zákonná nebo smluvní výjimka jej může prodloužit právním holdem. Pozdější požadavek jde do ručního právního posouzení a bez zachovaného reprodukčního artefaktu vyžaduje nový upload zákazníka.

### 3.5 Makeři a IČO (jen při stavbě sítě)

Neexistuje legální způsob, jak mít pravidelné makery bez IČO. Limit 50 000 Kč pro příležitostné příjmy řeší **daňové osvobození, ne povinnost mít živnost**; rozhodující je soustavnost podle §420 OZ. Platforma je navíc dokonalá evidence.

**Řešení: oddělit „vyzkoušet si to" od „vydělávat".** Certifikace je zdarma a bez toku peněz; IČO se vyžaduje až u první placené zakázky.

### 3.6 Zakázané zakázky

Části střelných zbraní; prostředky k obcházení bezpečnostních prvků; zdravotnické prostředky ve styku s tělem; porušení práv třetích osob k modelu. V v0 manuální kontrola náhledu u každé objednávky.

### 3.7 Data zákazníka

Souhlas se zveřejněním fotografií hotových dílů, odmítnutelný checkboxem. **Zdrojová CAD data jsou citlivější než STL** — retenční politika i mlčenlivost je musí zmiňovat výslovně a u firemních zákazníků počítej s NDA.

Retence se neváže na příponu souboru. Každý zdrojový `ModelFile` — **STL, 3MF i STEP** — dostane už v transakci úspěšného uložení `uploaded_at` a počáteční `source_delete_after = uploaded_at + source_model_retention_days` (výchozí hodnota v parametrech §10), ještě před asynchronním parsingem a preflightem. Každý odvozený formátový mezisoubor a rekonstruovatelný `ModelGeometry` nese `source_model_file_id`, dědí tentýž deadline/hold a bez něj nesmí být persistovaný. Opuštěný konfigurátor i parse/preflight failure bez Quote nebo Order proto zůstanou na počátečním deadline a nemohou viset navždy.

Vznik Quote deadline pouze auditovaně prodlouží na `max(source_delete_after, quote.expires_at + source_model_retention_days)`. Přijetí Orderu zapne `source_retention_hold = active_order`, takže dlouhá výroba nepřijde o vstup; její terminální transakce hold vypne a nastaví `source_delete_after = max(dosavadní deadline, terminal_at + source_model_retention_days)`. Právní hold může deadline dále prodloužit, nikdy zkrátit. Mazací job po deadlinu bez aktivního holdu odstraní zdrojový upload, všechny jeho zdrojově navázané mezisoubory i `ModelGeometry`; přijaté objednávce ponechá jen oddělený `ReproductionArtifact` s vlastní retenční politikou níže, všude jinde nereverzibilní hash a auditní metadata. Retry používá `model_file_id + source_delete_after`, takže novější prodloužení nemůže prohrát se starým mazacím jobem.

Každá uložená fotografie je samostatný `PhotoAsset(kind = quote_reference | qc)` a už při úspěšném uploadu dostane `uploaded_at` a `photo_delete_after = uploaded_at + photo_retention_days`; bez deadlinu se originál, thumbnail ani EXIF odvozenina nesmí persistovat. U fotografie `QuoteRequest` smí vznik Quote deadline zvýšit nejvýše na `quote.expires_at + photo_retention_days`; nepřijatá nebo opuštěná poptávka tak zůstane na konečném termínu. Přijetí Orderu a QC upload zapnou jen `photo_retention_hold = active_order`, nikoli bezednou retenci.

Terminální transakce Orderu aktivní hold vypne a pro každý jeho reference/QC `PhotoAsset` nastaví `photo_delete_after` na maximum dosavadního data a nejpozdějšího `claim_until` souvisejících doručených slotů; není-li žádný doručený slot, použije `terminal_at + photo_retention_days`. Po terminálním Orderu smí smazání odložit už jen neterminální Claim pokrývající daný foto scope nebo explicitní legal hold; po jejich skončení se deadline přepočítá a mazací job odstraní originál, transformace, thumbnail i EXIF a ponechá pouze auditní hash/metadata. Souhlas se zveřejněním provozní kopii ani deadline neprodlužuje; v počátečním scope nevzniká trvalá veřejná galerie a publikovaný export musí zmizet nejpozději se svým `PhotoAsset` nebo okamžitě po odvolání souhlasu.

U přijaté objednávky vzniká zvlášť šifrovaný `ReproductionArtifact` s kanonickými produkčními bajty `ModelGeometry`, přijatou `PrintConfigRevision` a reference/cenovým snapshotem. Machine-specific vstupy se k němu nepřipisují předem. Každé přijetí jobu **po finálním routingu** atomicky vytvoří draft `ReproductionArtifactVersion` navázaný na `OrderItem`/`OrderPhase` a `produced_by_job_id`; z jeho vlastní `ProductionReservation` kopíruje přesná ID `CandidateResourceEstimate`, `MachineProfile`, `MachineCalibration` a konfigurace. Přechod `gcode_ready` doplní skutečný production `SliceResult` a digest výstupního artefaktu a verzi immutable uzamkne. Přesměrovaný nebo náhradní job dostane novou verzi; claimová náhrada odkáže původní doručenou přes `reproduces_artifact_version_id`, ale nekopíruje z ní machine-specific ID. Jen neúspěšná/nedoručená verze se označí `superseded`, nikdy se nepřepíše.

Claim vybírá sealed verzi skutečně doručeného jobu/fáze jako důkaz výsledku a cestu ke kanonické geometrii i zákaznické konfiguraci, ne jako production snapshot pro další stroj. Po smazání zdrojového STEP nebo 3MF tak stále reprodukuje správný obsah, zatímco každý reroutovaný reprint odvodí nové machine-specific vstupy až z čerstvé eligibility a rezervace. Dokud je objednávka neterminální, `reproduction_delete_after` se nenastaví. Při každém terminálním přechodu se ale nastaví vždy: bez doručeného slotu na `terminal_at + undelivered_reproduction_retention_days`; s doručením na nejpozdější z `claim_until` všech doručených slotů a, existuje-li nedoručená verze, `terminal_at + undelivered_reproduction_retention_days`. Aktivní incident zásilky, reklamace nebo právní hold termín prodlouží. Po odpadnutí poslední překážky mazací job odstraní artefakt i jeho produkční verze a ponechá jen auditní metadata a hash, nikoli rekonstruovatelnou geometrii; refund před doručením tak nikdy nenechá rekonstruovatelný artefakt bez data smazání.

#### Retence a opakování objednávky

Standardní retence zákaznického modelu zůstává 90 dní a existence zákaznického účtu ji automaticky neprodlužuje. `Objednat znovu` je dostupné jen tehdy, pokud jsou stále dostupné všechny zdrojové artefakty nutné k novému preflightu, slicingu, eligibility a výrobě. `ReproductionArtifact` držený kvůli reklamaci je účelově omezený na nápravu původní objednávky a nesmí se použít jako skrytá dlouhodobá archivace pro novou objednávku.

Po vypršení retence zůstávají obchodní a auditní data historické objednávky v účtu viditelná, ale systém z nich nesmí automaticky vytvořit výrobně způsobilou kopii. Zákazník znovu nahraje model a systém smí z historie předvyplnit jen stále platnou konfiguraci. Případná dlouhodobá archivace výrobních souborů je samostatné budoucí rozhodnutí.

### 3.8 Právní kontrola

§3.3–§3.7 a obchodní podmínky ověřit s poradcem před spuštěním. Konkurenční VOP použít jako **strukturu a checklist, nikoli jako text**.

---

## §4 Cenový model

### 4.1 Vzorec

```
material    = gramáž_g × sazba_materiálu
machine     = čas_h × sazba_stroj_h          ← čas ze slice zvoleného ReferenceProfile
handling    = sazba_prace_h × (
                handling_order_fix
              + Σ_i(handling_plate × podložek_i
                  + handling_piece × qty_i     (degresivní)
                  + postprocessing_i)
              + handling_pack × počet_plánovaných_zásilek
              + Σ(shipping_trip / shipping_trip_pricing_divisor) )
handling_pretisk = sazba_prace_h × Σ_i(
                    handling_plate × podložek_i
                  + handling_piece × qty_i     (degresivní)
                  + postprocessing_i )
amortizace  = cena_stroje / návratnost_h × čas_h
obal        = Σ obalový_materiál(zásilka_i)
dopravni_naklad = Σ skutečný_náklad_dopravce(zásilka_i)

vyrobni_naklad = material + machine + handling + amortizace + obal + rezerva_pretisk
cena_tisku_pred_subvenci = max(min_print_price, vyrobni_naklad × (1 + marže))
doprava            = 0 pokud cena_tisku_pred_subvenci ≥ prah_doprava_zdarma
                   | Σ zákaznická_sazba(zásilka_i.kategorie) jinak
dotovana_doprava   = max(0, dopravni_naklad − doprava)
naklad_s_prodejem  = vyrobni_naklad + dotovana_doprava
cena_tisku_zaklad  = max(min_print_price, naklad_s_prodejem × (1 + marže))
express_priplatek  = cena_tisku_zaklad × (koef_express − 1)
cena_tisku         = cena_tisku_zaklad + express_priplatek
mezisoucet          = cena_tisku + doprava + small_order_surcharge
cena_celkem         = nejmenší x, pro které
                      x − Σ poplatek_platebni_brany(payment_i(x)) ≥ mezisoucet
                      a Σ payment_i(x) = x pro celý PaymentSchedule
```

#### Hranice `OrderItem` / `Order`

Pricing má dvě závazné úrovně:

- `OrderItem` nese náklady a pravidla vznikající z jedné výrobní konfigurace: vybranou geometrii/tělesa, materiál, barvu, kvalitu, `PrintConfigRevision`, množství a z nich odvozené arrangement/podložky, spotřebu materiálu, strojový čas, item-level handling, post-processing, amortizaci a rezervu přetisku.
- `Order` nese náklady a pravidla sdílená celou objednávkou: jedno `handling_order_fix`, administrativu, plán zásilek, balení, `handling_pack`, `shipping_trip`, dopravu, platební poplatky, `min_print_price`, `small_order_surcharge` a express eligibility/příplatek.

Agregovaný výrobní pricing nejprve sečte výrobní příspěvky všech položek a jednou přidá sdílené order-level náklady. Více samostatně konfigurovaných `OrderItem` proto nesmí násobit minimum, přirážku malé objednávky ani fixní náklady celé objednávky.

```
cena_tisku_order = max(min_print_price, agregovaný výrobní pricing položek)
```

`min_print_price` se aplikuje **jednou na objednávku**, ne na každý `OrderItem`. Chrání především `handling_order_fix`, balení, administrativu a předání zásilky / `shipping_trip`.

`small_order_surcharge` se rovněž aplikuje **jednou na objednávku**. Spouštěčem ve v0 je `sum(print_weight všech OrderItem) < 100 g`; hranice zůstává dočasnou obchodní proxy sledovanou podle parametrů §7.

Množstevní sleva se naproti tomu vyhodnocuje **na úrovni `OrderItem`**, protože výrobní efekt vzniká opakováním stejného dílu se stejnou konfigurací a jeho rozložením na podložce. Množství různých položek se pro tuto slevu nesčítá.

`postprocessing_i` je celkový nadstandardní post-processing požadovaný konkrétním `OrderItem` pro naceněné množství a fázi; bez něj je 0. Ve vzorci se proto sčítá jednou přes itemy, ne jednou za celý Order ani znovu za každý kus mimo itemový odhad. Stejný item-level rozsah používá `handling_pretisk` pro očekávané opakování výroby.

**Žádný `koef_kvality`.** Kvalita mění výšku vrstvy, tedy čas — a ten dává slicer přímo. Násobit přesně spočítaných 6 h 12 min ručním koeficientem znamená zahodit přesně tu výhodu, kvůli které se slicuje. Pokud má u jemné kvality existovat obchodní přirážka, ať se jmenuje přirážka a stojí vedle, ne v čase.

**`small_order_surcharge` je obchodní přirážka, ne úhrada přípravy.** Ta je už v `cena_tisku` přes `handling`. Dřívější název „poplatek za přípravu" tvrdil zákazníkovi opak a účetně to bylo dvojí účtování.

**`min_print_price` se vztahuje na `cena_tisku`, ne na částku u pokladny** — konkrétní podlahy viz parametry §7.

**Báze pro `rezerva_pretisk` je definovaná explicitně**, jinak ji každý implementátor aplikuje jinam:

```
rezerva_pretisk = mira_zmetku × (material + machine + handling_pretisk + amortizace)
```

`handling_pretisk` je peněžní částka: používá stejnou sazbu práce a stejné násobnosti podložek a kusů jako hlavní výpočet. Nezahrnuje `handling_order_fix`, `handling_pack` ani `shipping_trip` — ty se při přetisku chyceném doma neopakují. `amortizace` v bázi je očekávané opotřebení životnosti stroje při opakovaném tisku; v v0 a hobby režimu je při návratnosti ∞ stále nulová.

**Nekryje ale odmítnutí až po doručení.** To stojí navíc dopravu a balení, a to obojím směrem. Dokud není změřený first-pass yield, sedí tohle riziko v marži; jakmile bude, patří sem druhá složka s vlastní mírou.

**Marže se aplikuje na celý výrobní náklad, ne na cenu materiálu.** Model z Prusa blogu počítá marži jako procento z materiálu — u téže práce pak vyjde marže korunu u levného PLA a stovky u karbonu, přestože riziko a čas jsou stejné.

**Amortizace je parametr s explicitní dobou návratnosti**, ne skrytý předpoklad. V v0 a hobby režimu ∞, tedy nula.

**Práh dopravy zdarma se počítá z `cena_tisku_pred_subvenci`**, tedy z ceny před započtením dotované dopravy, poplatku brány i expresního příplatku. Dotovaná doprava tak sama objednávku nekvalifikuje a nikdo si dopravu zdarma nekoupí připlacením za spěch.

**Přepravní náklady se počítají přes všechny plánované zásilky.** Běžná v0 `single` fáze má jednu nebo více podle objemového/hmotnostního rozdělení celého množství; fázovaná objednávka má oddělené sample a batch plány a každý z nich může mít více parcel. Každá zásilka má vlastní kategorii, obal, `handling_pack` a alokaci cesty. Práh dopravy zdarma nuluje součet sazeb dopravce, ne počet zásilek ani jejich náklad v CM.

**Alokace logistické cesty v závazné ceně je verzovaný očekávaný parametr, ne budoucí skutečnost.** `shipping_trip_pricing_divisor` patří do `PriceList` a v hobby/v0 je konzervativně 1; pozdější objednávky už vydanou cenu nemění. Skutečný `HandlingSession.shipping_trip` naopak eviduje jednu reálnou cestu a `actual_shipments_in_trip`; tento jmenovatel vstupuje jen do realizované CM a variance proti quote, nikdy zpět do zákaznické ceny.

**Nevyhnutelné prodejní náklady nesmějí propadnout pod cenovou podlahu.** Rozdíl mezi skutečným nákladem dopravce a částkou účtovanou zákazníkovi vstupuje do nákladové báze ještě před marží. Cenový snapshot obsahuje `PaymentSchedule` se všemi plánovanými capture (`full`, nebo `deposit` + `balance`, případně nový balance revize) a cena se hrubuje proti **součtu** jejich poplatků. Pro stejný tarif `p × částka + f` a `n` plánovaných capture je `cena_celkem = (mezisoucet + n × f) / (1 − p)`, ne varianta s jediným `f`. Přidání další platby v `OrderRevision` proto přepočítá i fee schedule před přijetím zákazníkem. Po odečtení všech poplatků stále zbývá celý mezisoučet a doprava zdarma neznamená zápornou CM na nominální podlaze.

### 4.2 Co v ceně dominuje

Při 300 Kč/h a 30 minutách handlingu je struktura malé zakázky zhruba tato:

| Položka | Podíl |
|---|---|
| Materiál + energie + opotřebení | ~6 % |
| **Handling** | **~54 %** |
| Doprava, brána, obal | ~40 % |

**Materiál je marginální položka.** Dynamické sledování cen filamentu je architektonicky správné, ale nezmění jediné rozhodnutí — rozpětí PLA 299 vs. 499 je na běžném dílu dvanáct korun. Co rozhoduje, je handling a zmetkovitost.

### 4.3 Nákladová podlaha a tržní strop

Podlaha se počítá z parametrů. Strop je 4–6 Kč/g hlavního tržního pásma. **Umístění: spodní polovina pásma.**

Ověřená podlaha je v parametrech §7. V0 počítá pouze se zasláním přes dopravce; osobní odběr se do ekonomiky ani síťové brány nezapočítává, dokud nebude mít vlastní checkout a předávací workflow zachovávající soukromí zákazníka.

### 4.4 Publikovaný ceník

Trh kotví ceny **na gram**, ale skutečný náklad je dominantně **čas** — vysoký tenký díl a nízký zavalitý díl o stejné gramáži se v čase liší klidně trojnásobně.

Proto: **publikovat „od X Kč/g" kvůli srovnatelnosti** a skutečnou cenu nechat vzniknout ze slicingu. Kde výsledek vyjde nad pásmem, má to konfigurátor vysvětlit a nabídnout jinou orientaci.

### 4.5 Slicuj podložku, ne díl

Drobný díl tištěný sám je pomalý kvůli minimálnímu času vrstvy na chlazení; dvacet dílů na podložce → čas na kus klesne klidně na třetinu. Množstevní sleva z toho vypadne sama a je **skutečná**.

**Ve v0 ale nestav vlastní packing engine.** Princip platí, implementace může být triviální:

```
qty = 1   → přesný slice
qty > 1   → slicer-native arrange + slice
            nevejde se → další podložka
```

Orca má vlastní arrangement se svými omezeními a psát k němu paralelní 2D packing je v nulté verzi práce navíc bez odpovídajícího přínosu. Vlastní algoritmus až tehdy, když se ukáže, že nativní arrange systematicky plýtvá plochou.

Arrangement i množstevní efekt se počítají samostatně pro každý `OrderItem`. Například kryt × 5 a víčko × 4 jsou dvě nezávislá vyhodnocení; devět kusů ve dvou různých konfiguracích automaticky neznamená slevu pro 9 ks.

### 4.6 Přepravní kategorie

Bounding box počítá preflight, ale kategorie se nesmí určit jen z jednoho dílu ani z jednoho `OrderItem`. Před závaznou cenou musí mít Order vybraný jeden `delivery_destination` včetně provider capability snapshotu; deterministický `ShipmentPlan` pak vznikne nad **všemi výrobními položkami a celým množstvím každé fáze** a všechny jeho parcely míří do tohoto jediného endpointu:

1. pro každý kus vznikne ochranný `packing_part_bbox`, který ke každé straně zdrojového bboxu přidá obalovou rezervu; tyto obálky se při skládání nesmějí překrývat a každý kus se musí do vnějších rozměrů kategorie vejít alespoň v jedné ze šesti osových rotací
2. podporované kategorie mají ve `PriceList` verzované `shipping_category_priority`; v v0 je pořadí `Z-BOX → výdejní místo → nadrozměrná`, ale před packingem se seznam omezí jen na kategorie podporované zvoleným `delivery_destination` a jeho snapshotovanými provider limity
3. ještě před vznikem slotů dostane každý plánovaný kus stabilní `packing_unit_key = (order_item_id, phase_kind, quantity_ordinal)`, kde ordinal je souvisle `1..phase_quantity` uvnitř itemu; kusy se seřadí sestupně podle nejdelší hrany, pak bbox objemu a nakonec lexikograficky podle tohoto klíče, nikdy podle dosud neexistujícího `FulfilmentSlot.id`
4. dimension-aware first-fit zkouší existující zásilky v pořadí jejich vzniku a pro každou drží skutečně realizovatelný `packing_bbox`: další ochrannou obálku zkusí ve všech unikátních osových rotacích seřazených lexikograficky podle orientovaného `(x, y, z)` a přiloží ji podél os v pořadí `X → Y → Z`; na zvolené ose se rozměry sečtou a na zbývajících vezme maximum
5. kandidát smí zůstat v právě zkoušené zásilce jen tehdy, když nepřekročí rozměrové limity její kategorie, agregovanou hmotnost dílů + obalu ani `volume_proxy = Σ(packing_part_bbox_volume) / packing_fill_coefficient`; proxy se porovnává výhradně s verzovaným `shipping_category.max_parcel_volume_cm3`, nikoli s objemem právě realizovaného `packing_bbox`, a v0 používá `packing_fill_coefficient = 0,55` i category ceilings z parametrů §6. Ze všech platných umístění v první způsobilé existující zásilce se vybere minimum tuple `(výsledný bbox objem, nejdelší výsledná hrana, výsledné x, y, z, orientované x, y, z kusu, axis_order)`; přesně tento kandidát se uloží jako nový `packing_bbox` před zpracováním dalšího kusu
6. pokud nevyhoví žádná existující zásilka, zkusí se prázdný `packing_bbox` ve filtrovaném pořadí `shipping_category_priority` a nový balík vznikne v první způsobilé kategorii; jeho snapshot uloží stejný `delivery_destination_id`, kategorii, výsledný bbox ochranných obálek, objemovou proxy a hmotnost
7. pokud některý kus neprojde žádnou kategorií kompatibilní se zvoleným endpointem, závazný plán nevznikne: UI nabídne jiný společný endpoint/service a po změně vytvoří nový quote; co se nevejde ani potom, jde do individuální nabídky
8. na hraně se zaokrouhluje nahoru

Vlastní přesný 3D bin packing **nestav**. Popsaný axis-aligned first-fit může vytvořit více zásilek než optimální packing, ale každý přijatý krok reprezentuje platné nepřekrývající se umístění, takže samotný součet objemů nikdy nesmí podcenit počet balíků. Změna priority kategorií vytváří novou `PriceList`; změna endpointu nebo jeho capability snapshotu před platbou invaliduje dosavadní `ShipmentPlan` a vyžádá nový závazný quote. Přijatý cenový snapshot se nikdy zpětně nepřecení. `ShipmentPlan` je součást cenového snapshotu; fázovaná objednávka plánuje sample a batch odděleně a revize modelu přepočítá jen zbývající zásilky se stejným endpointem, dokud zákazník výslovně nepřijme jeho změnu a novou cenu.

Pre-quote výsledek rozdělí každý `packing_unit_key` právě do jedné plánované zásilky. Transakce `Order.draft → quoted` potom pro každý klíč vytvoří právě jeden `FulfilmentSlot`, klíč na něm immutable snapshotuje a atomicky přepíše parcel allocations plánu na vzniklá slot ID; po přechodu nesmí zůstat klíč bez slotu ani slot bez právě jedné alokace. Skutečný `Shipment` tuto množinu snapshotuje. Cenový snapshot každému slotu přiřadí `settlement_amount` a každé zásilce vlastní účtovanou dopravu/handling tak, aby jejich součet přesně odpovídal ceně fáze; refund ztracené parcely proto má předem danou částku bez zpětného přepočtu doručených kusů. Jednotlivé složky včetně expresního příplatku mají deterministickou alokaci ke slotům a každý `PriceAdjustment` ukládá, kterou dosud nekreditovanou alokaci spotřeboval. `remaining_contract_value` slotu proto nikdy neklesne pod nulu a claim, SLA credit ani jejich opačné pořadí nemohou stejnou hodnotu odečíst dvakrát. Fáze je `delivered` až tehdy, když je doručený každý aktuální list všech povinných shipment lineage. Pokud je alespoň jeden slot doručený a všechny ostatní jsou buď doručené, nebo po incidentu finančně vypořádané jako `cancelled_refunded`, fáze i objednávka skončí `partially_fulfilled`. První z více balíků tedy nikdy nedokončí celou fázi a ztráta druhého nikdy nevynutí refund už doručených kusů.

Tvrdá podmínka: **každý jednotlivý vyráběný díl** se musí vejít do rozměrů zvolené přepravní kategorie; výsledné rozdělení zásilky zároveň musí splnit její objemové, rozměrové i hmotnostní limity.

**Strukturální napětí, vědomě přijaté:** diferenciace vůči hobbistovi s P1S je velký build plate, ale přesně ty zakázky vypadávají z levné boxové sítě.

**Bonus zdarma:** *„kdyby byl díl o 3 cm kratší, doprava by stála o 60 Kč míň; zkusit jinou orientaci nebo rozdělit?"*

### 4.7 Expresní výroba

**Předběhnutí fronty, ne kurýr.** Dokončení do 24 h od potvrzení, pak normální Zásilkovna. Nulové dodatečné náklady, zpeněžuje volnou kapacitu.

Expres se nabízí jen objednávce s právě jednou `OrderPhase(kind = single)`. Dvoufázový sample/batch flow jej ve v1 nesmí zobrazit, nacenit ani přijmout: čekání na doručení a potvrzení vzorku není výrobní prodlení a agregátní `qc_passed_at` pro něj nemůže měřit 24hodinový slib. Phase-scoped expres lze přidat až s odděleným příplatkem, `express_due_at` a refundovatelnou alokací pro každou fázi; do té doby neexistuje.

**Prodávat s garancí vrácení příplatku.** V českém vzorku to nikdo nenabízí a při funkční kapacitní bráně to nic nestojí. Podmínkou legitimity je **poctivý standardní termín** — jinak express jen prodává zpátky rezervu, což lidé při druhé objednávce poznají.

Pro způsobilou single-phase objednávku se garance vypořádává idempotentní událostí `ExpressSlaBreach`, když její jediná fáze nedosáhne `qc_passed_at` do `express_due_at = confirmed_at + 24 h`. Událost pod zámkem cenových alokací odvodí `express_credit_amount` jako dosud žádným jiným `PriceAdjustment` nekreditovanou část `express_priplatek`, vytvoří novou immutable revizi aktuálního cenového snapshotu s `contract_total' = contract_total − express_credit_amount` a aktivuje ji jako `PriceAdjustment(kind = express_sla_credit)`; původní snapshot se nemění. Teprve proti takto snížené smluvní ceně přepočítá `refundable_balance = max(0, net_captured − contract_total')` a pod stejným zámkem Payment i aktivních refundů vytvoří `RefundTransaction` na dosud nevrácenou a žádným pending refundem nealokovanou část příplatku s klíčem `order_id + express_due_at + price_snapshot_id`. Pokud příplatek už zahrnul jiný úplný refund nebo settlement, částka je nulová a druhý refund nevznikne. Clock worker i `handoff_shipment` vyhodnotí po `express_due_at` tutéž událost pod zámkem; předání proto nemůže předběhnout dosud nezapsaný SLA credit. Úspěšný webhook vrátí `refundable_balance` na nulu; retry a alert pokračují do vypořádání a pre-handoff zásilka zůstává mezitím blokovaná. Refund tedy nikdy nevytvoří falešný doplatek základní objednávky a opakované vyhodnocení SLA nevrátí příplatek dvakrát.

**Kapacitní brána — default zapnuto, měří zásahy obsluhy, ne hodiny.** Jeden dvacetihodinový tisk přes noc je v pořádku, pět čtyřhodinových podložek ne, protože mezi nimi musí někdo sejmout díly. Podmínky v parametrech §10. Když padnou, volba se **nezobrazí**.

Způsobilost se vyhodnocuje nad **celou objednávkou**: do brány vstupují všechny `OrderItem`, jejich množství a všechny potřebné podložky. Limit dvou podložek je společný pro celý order, stejně jako požadavek na dostupný materiál/barvu, nulový nadstandardní post-processing a dostatečné výrobní okno. Pokud jediná položka nebo společný plán podmínky nesplní, express se nenabídne vůbec. Jedna objednávka nesmí kombinovat standardní a expresní položky.

### 4.8 Meze automatu

Automat vydává **závaznou** cenu jen v mezích, kde ví, co dělá; mimo ně → individuální nabídka. Hodnoty v parametrech §8.

Hodnotový strop existuje proto, že prémie za bezbariérovost funguje na malých objednávkách — u zakázky za 5 000 Kč zákazník obvolá tři dodavatele. **Riziko se s tím kryje:** špatně naceněná malá zakázka stojí padesátikorunu, velká tisíce.

### 4.9 Modelářské služby

Rozsah: jednoduché objekty a překreslení poškozených dílů podle detailů od zákazníka. Hladiny a ceny v parametrech §11.

**Neúčtovat hodinově** — zákazník neumí odhadnout riziko. **Skutečný náklad není modelování, ale komunikace:** jedno bezplatné kolo úprav je standardní součást práce, ne rezerva, a započítej ho do ceny.

**Vstup:** STEP jako univerzální formát. STEP nese jen geometrii, ne historii úprav, takže „úprava STEPu" znamená domodelovat změnu na tupém tělese — jiná hladina než editace nativního souboru.

**Práci na cizím modelu naceňuj až po otevření souboru, nikdy podle popisu.** Cizí parametrický strom může být hotový za dvacet minut, nebo je rychlejší začít znovu.

**Konkurence:** TisknuTO nabízí přesně tenhle rozsah včetně skenování a AI z fotek. Diferenciace musí být v rychlosti a konkrétnosti, ne v seznamu služeb.

---

# ČÁST II — TECHNICKÉ JÁDRO

## §5 Slicing engine

### 5.1 Dvoufázový slicing

**Fáze A — quote (referenční slice).** Výstup: gramáž, čas, bbox, počet objektů, nálezy preflightu. **Jedna cena bez ohledu na to, kdo bude tisknout.**

Invariant zní **„referenční profil pro zvolený materiál a kvalitu, nezávislý na stroji"** — ne jeden generický PLA profil pro celý svět. PETG má jiné rychlosti i teploty, takže nacenit ho podle PLA slice znamená být systematicky vedle. Profilů je tedy `materiály × kvality`, každý strojově nezávislý; síť pak dostane stejnou zákaznickou cenu bez ohledu na to, který uzel job vezme.

**Slicuje se líně** — až pro kombinaci, kterou zákazník vybral, ne všechny dopředu. Obrazovku do té doby drží hrubý odhad z objemu meshe (§5.7).

**Fáze B — produkce (strojový slice).** Až po přijetí jobu, profilem pro daný stroj a materiál, s kalibračními overridy.

V v0 i v1 obě fáze splynou (jeden stroj), ale **šev tam musí být**.

### 5.2 Jádro

**OrcaSlicer CLI v Dockeru.** Image je **verzovaná a immutable** — upgrade binárky mění výstup a tedy cenu; nikdy automaticky, vždy s přepočtem ceníku a novými verzemi všech dotčených `ReferenceProfile` a `MachineProfile`.

**Zafixovat toleranci tesselace STEP.** Mění gramáž i čas, takže její změna změní cenu u téhož souboru a padne reprodukovatelnost, na které stojí cache i verzování ceníku. Patří mezi parametry referenčního profilu.

### 5.3 Vstupní formáty

| Formát | Přímé flow | Modelářská práce | Blokuje vydání v0? |
|---|---|---|---|
| STL, 3MF bez paint/multimaterial metadat | ✓ | ✗ | **ano** |
| **STEP** | ✓ (slicery ho importují) | ✓ univerzální vstup | **ne** |
| nativní CAD (f3d, sldprt) | ✗ | až později | ne |

**STEP není blocker v0.** Produktově je to silný diferenciátor — zákazník s CADem a bez vyexportovaného meshe je přesně ta lepší cílovka — ale implementačně přináší tesselaci s deterministickou tolerancí, jednotky, sestavy, náhled a novou plochu na selhání. Úkolem v0 je ověřit instant quote, ne pokrýt formáty. Když by STEP brzdil vydání, pusť **STL + 3MF** a STEP přidej hned poté.

**STEP může obsahovat sestavu.** Když STEP nebo podporovaný 3MF obsahuje víc těles, ukaž je jako seznam a nech zákazníka vybrat, která se tisknou. Vybraná tělesa se shodnou úplnou výrobní konfigurací — materiálem, barvou, kvalitou, `PrintConfigRevision` a množstvím celé vybrané sady — smí tvořit jeden `OrderItem`; odlišná konfigurace vždy vytváří samostatnou položku. Každý `OrderItem` odkazuje na immutable `ModelGeometry` přesně svého tělesa nebo podmnožiny těl a naceňuje se samostatně. Nad práh → individuální nabídka. U STL s jediným tělesem tenhle grouping nevzniká.

Cache nikdy neidentifikuje vstup jen hashem celého uploadu. Každý `OrderItem` odkazuje na immutable `ModelGeometry`: u STL/3MF je to kanonická tisknutelná geometrie, u STEP deterministicky extrahované vybrané těleso nebo podmnožina těl po tesselaci s verzovanou tolerancí. `geometry_hash = sha256(canonical_geometry_bytes)`; dvě tělesa jednoho STEP souboru tak mají rozdílný klíč, geometricky totožné výstupy mohou cache bezpečně sdílet.

### 5.4 Výstupní formáty

| Stroj | Formát | Přenos |
|---|---|---|
| Bambu P1S / X1C / H2S / H2D | `.gcode.3mf` | LAN: FTP + MQTT |
| Prusa MK4 / MK4S / Core One | `.bgcode` | PrusaLink HTTP |
| Klipper | `.gcode` | Moonraker |

U Bambu **nikdy holý G-code** — přijdeš o náhledy plate a mapování AMS.

### 5.5 Preflight

Každý nález má úroveň `info` / `warning` (risk checkbox) / `blocking` (→ individuální nabídka).

| Kontrola | Nástroj | Úroveň | Fáze |
|---|---|---|---|
| Watertight, manifold, normály | trimesh / admesh | blocking pokud neopravitelné | v0 |
| Bounding box vs. build volume | vlastní | blocking | v0 |
| **Měřítko / jednotky** | heuristika nad bboxem | warning nebo dotaz | v0 |
| Tenké stěny < 2× šířka extruze | vlastní | warning | v0 |
| Rozsah podpěr | ze slice | warning nad prahem | v0 |
| **3MF paint, více material/extruder assignmentů** | parser 3MF archivu před slicingem | **blocking → individuální nabídka** | v0/v1 |
| Sestava ve STEPu (víc těles) | vlastní | dotaz | v0 |
| Počet objektů, stabilita | vlastní | info | v0 |
| Reliéfní text pod prahem | AI | warning | post-validation |

**Kontrola měřítka:** STL neobsahuje jednotky. Zákazník modelující v palcích pošle díl 25,4× větší nebo menší, aniž by si toho všiml — proto má PCBWay ve formuláři výslovný přepínač jednotek. Stačí pravidlo nad bboxem, který stejně počítáš.

**3MF se nesmí zploštit potichu.** Ještě před kanonizací geometrie a referenčním slicem parser projde model relationships, paint data a material/extruder assignmenty. Jakýkoli vícemateriálový nebo malovaný jeden díl nastaví blocking finding, nevydá závaznou automatickou cenu a přesměruje soubor do custom requestu, dokud nebude existovat machine-specific multicolor odhad včetně purge odpadu.

### 5.6 Cache

Klíč reference slice je `geometry_hash + reference_profile_revision_id + print_config_revision_id + parts_per_plate`. Klíč production slice je `geometry_hash + machine_profile_revision_id + machine_calibration_revision_id + print_config_revision_id + parts_per_plate`. `PrintConfigRevision` je immutable snapshot zvolené úrovně výplně (procento i vzor) a všech dalších konfiguračních voleb, které mění toolpath; výplň tedy není skrytá ve kvalitě. `geometry_hash` patří konkrétnímu `ModelGeometry`, ne kontejnerovému `ModelFile`. Revision ID je globálně unikátní immutable snapshot, takže se nemohou srazit lokální čísla verzí dvou profilů ani dvou fyzických strojů. `MachineCalibration` obsahuje `flow_ratio` a XY/elephant-foot kompenzace; změna kteréhokoli override vytvoří novou revizi a G-code z jiné kalibrace nebo jiné výplně nelze vrátit z cache.

`SliceResult` reprezentuje jednu konkrétní obsazenost podložky; pro jeden kus je `parts_per_plate = 1`, u dávky se plná a poslední částečná podložka cachují samostatně a výsledek nabídky se z nich složí. Závazná cena smí použít jen reference výsledek; production výsledek si ukládá obě strojové verze.

**Reference slice určuje zákaznickou cenu, nikdy rezervaci heterogenního stroje.** Pro každý plánovaný Job/parcel group každého `OrderItem` vznikne na každém kandidátním fyzickém stroji vlastní `CandidateResourceEstimate` z jeho `MachineProfile`, `MachineCalibration`, `PrintConfigRevision`, rozměru podložky a machine-specific arrangementu množství tohoto Jobu. Jeho klíč obsahuje `geometry_hash`, všechny production vstupy, `quantity`, `shipment_plan_id` a `arrangement_revision_id`. Agreguje počet podložek, jejich intervaly a gramáž ze strojových `SliceResult`; g-code se v této fázi neukládá ani nedá odeslat do stroje. `PhaseResourcePlan` potom přiřadí **každý** `required_fulfilment_slot` právě jednomu plánovanému Jobu a jeho candidate odhadu, případně na více strojích/uzlech. Produkční G-code vznikne až po `accepted` ze stejných immutable vstupů. Závazná cena ani capture nesmějí použít `EligibilitySnapshot` bez alespoň jednoho kompletního plánu přes celou aktivovanou fázi.

### 5.7 Async a UX ceny

1. **Hrubý odhad z objemu meshe a bboxu okamžitě** (±20 %, milisekundy) → číslo do 200 ms, což je ten konverzní efekt
2. **Skutečný slice na pozadí** → zpřesní výrobní mezisoučet, ale dokud zákazník nevybral doručovací endpoint, zůstává zobrazená cena výslovně **nezávazná**
3. **Výběr `delivery_destination`** → jeho capability snapshot omezí kategorie a deterministický `ShipmentPlan` dopočítá všechny parcely, dopravu, balení a order-level pricing; teprve pokud jsou zároveň splněny meze §4.8, vznikne immutable cenový snapshot, `Order.draft → quoted`, phase/slot topology a závazná cena s expirací

Právně čisté: hrubý odhad i sliced mezisoučet před volbou dopravy jsou výslovně nezávazné. Závazná cena vzniká až po reálném slice, preflightu a endpoint-bound `ShipmentPlan`; samotné dokončení background slice nesmí vytvořit `quoted` Order ani spustit expiraci závazné nabídky. Teprve nad stabilními phase/slot ID quoted objednávky vznikne `EligibilitySnapshot`; bez jeho kompletního plánu se nevytvoří Payment intent ani capture.

### 5.8 AI — pravidlo teď, implementace později

> **AI radí, geometrie rozhoduje.** Cokoli vstupuje do závazné ceny, musí pocházet z deterministického výpočtu.
>
> **Směr je jednosměrný:** AI smí **vetovat** (poslat věc do individuální nabídky), nikdy **povýšit** do automatu. Nejhorší selhání je pak falešný poplach — ztracená konverze u jedné objednávky, nikdy závazná cena na průšvihu.

`ai-worker` se v v0 ani v1 nestaví. Až na to dojde, pořadí podle návratnosti:

1. **triáž individuálních poptávek** — z fotek rozbitého dílu vytáhnout rozměry podle referenčního předmětu, připravit podklad a návrh ceny k odsouhlasení. Sem odtéká vzácná kapacita
2. **překlad varování do lidské řeči** — „tloušťka stěny 0,6 mm" nikomu nic neřekne; „tahle stěna je tenčí než dvě housenky materiálu, díl v tom místě praskne" ano
3. klasifikace dílu → výchozí hodnoty výplně
4. rizikové rysy mimo dosah geometrie

**Nikdy:** generování modelů z fotek nebo textu. U funkčních dílů nepoužitelné a otevírá reklamační frontu.

---

## §6 Datový model

### 6.1 Šest vstupů — nesloučit

```
ReferenceProfile   (verzovaný, materiál × kvalita; bez stroje)      platforma
MachineCapability  (statická, per model stroje)                    platforma
MachineProfile     (verzovaný, model × tryska × materiál × kvalita) platforma
MachineCalibration (verzovaná, per konkrétní stroj)                 maker
Inventory          (dynamická, per konkrétní stroj uzlu)            maker
PrintConfigRevision(verzovaná výplň + další toolpath volby)         objednávka
                                      ↓
                 = nabídka, kterou zákazník vidí a síť umí vyrobit
```

První tři popisují **svět**, `MachineCalibration` a `Inventory` **tenhle konkrétní stroj dneska** a `PrintConfigRevision` immutable volbu konkrétní objednávky. `ReferenceProfile` nikdy nemá vazbu na model stroje a používá se výhradně pro závaznou zákaznickou cenu. `MachineProfile` vždy patří kombinaci modelu, trysky, materiálu a kvality; `MachineCalibration` k němu přidává verzované odchylky konkrétního kusu. Reference i production slice používají tutéž `PrintConfigRevision`, produkční G-code navíc oba strojové snapshoty. Nastavení ani verze se nesmí sdílet jen proto, že v v0 běží na jednom fyzickém stroji.

**Maker nikdy nenahrává vlastní profil** — registruje jen schopnost (model, tryska, materiály, build volume, počet AMS). Ovlivnit smí pouze kalibrační odchylky svého kusu: `xy_hole_compensation`, `xy_contour_compensation`, `elephant_foot_compensation`, `flow_ratio`. Každé uložení vytvoří immutable `MachineCalibration` verzi; minulý job vždy ukazuje na snapshot, se kterým vznikl jeho G-code.

**Na `Inventory` patří `price_per_g` a `vendor`.** Pak umíš každý job naúčtovat proti **skutečně spotřebovaným cívkám** a postavit vedle sebe plánovanou a realizovanou marži. Rozdíl mezi nimi je to, co chceš vidět — bez toho spotový nákup na Alze nikdy neuvidíš.

### 6.2 Entity

| Entita | v0 | v1 | Poznámka |
|---|---|---|---|
| `Customer` | ✓ | ✓ | bez povinné registrace; volitelný účet v1 nesmí být podmínkou checkoutu ani sledování |
| `Order` / `OrderItem` | ✓ | ✓ | `OrderItem` je samostatná výrobní konfigurace; jeden `ModelFile` může přes výběr geometrií zdrojovat více položek; Payment, ShipmentPlan a Shipment jsou kolekce potomků Orderu od v0 |
| `Payment` | ✓ | ✓ | více transakcí na objednávku; role `full` / `deposit` / `balance`, capture cutoff + refundace |
| `PaymentSchedule` | ✓ | ✓ | immutable plán všech capture a fee sazeb použitý pro gross-up cenového snapshotu |
| `OrderSettlement` | ✓ | ✓ | earned/refund/write-off snapshot pro zrušení po vzniklých nákladech, opuštěném doplatku nebo neautorizovaném fyzickém handoffu |
| `HandoffReconciliation` | ✓ | ✓ | immutable vazba ověřeného carrier scanu, odmítnutého cancellation requestu a `OrderSettlement(kind = unauthorized_handoff)`; nikdy nenahrazuje běžnou autorizaci |
| `LateCaptureCompensation` | ✓ | ✓ | `initial_checkout_expired`, `initial_checkout_cancelled`, `initial_checkout_capacity`, `revision_capacity`, `unauthorized_handoff_balance`, `balance_settlement`, `sample_confirmation_expired` nebo `revision_rejected`; plná refundace provider capture bez znovuotevření fulfilmentu |
| `PriceAdjustment` | ✓ | ✓ | immutable následník cenového snapshotu; `express_sla_credit`, `claim_slot_credit`, `recovery_slot_credit` nebo `batch_cancellation_credit` před refundem |
| `OrderPhase` | ✓ | ✓ | v0 právě jedna pre-capture `single`; v1 `single` nebo `sample` / `batch`; vzniká s immutable per-item množstvím a sloty už pod `Order.quoted`, před rezervací a capture |
| `OrderRevision` | — | ✓ | explicitní množina dotčených `OrderItem`, jejich náhradní geometrie/konfigurace, reslice, cenový rozdíl, fee-aware `PaymentSchedule`, přijetí a `revision_amount_due` |
| `FulfilmentSlot` | ✓ | ✓ | stabilní pre-capture ID naceněného kusu s hodnotou/credits, jednou parcel allocation a nejvýše jedním `active_claim_id` |
| `ModelFile` | ✓ | ✓ | immutable, adresovaný hashem a nezávislý na `OrderItem`; `source_delete_after` už při uploadu + auditovaný hold/prodloužení |
| `PhotoAsset` | ✓ | ✓ | `quote_reference` nebo `qc`; `photo_delete_after` už při uploadu, aktivní Order/Claim a legal hold jen auditovaně odkládají smazání |
| `ModelGeometry` | ✓ | ✓ | kanonická geometrie tělesa/podmnožiny; vlastní `geometry_hash` |
| `ReproductionArtifact` / `Version` | ✓ | ✓ | draft při acceptance, sealed s production slice při `gcode_ready`; claim volí skutečně doručenou |
| `SliceResult` | ✓ | ✓ | vždy `PrintConfigRevision`; reference klíč s profile version, production navíc s calibration version |
| `CandidateResourceEstimate` | ✓ | ✓ | machine-specific plate plan, gramáž a intervaly; bez použitelného G-code |
| `PhaseResourcePlan` | ✓ | ✓ | úplné přiřazení všech slotů aktivované fáze k plánovaným Jobům a candidate odhadům |
| `PreflightFinding` | ✓ | ✓ | nález + úroveň + zda zákazník akceptoval |
| `Job` | ✓ | ✓ | přiřaditelný jednomu uzlu a jednomu `ShipmentPlan`; přetisk odkazuje přes `replaces_job_id` |
| `Node` / `Machine` / `Inventory` | ✓ | ✓ | uzel jediný, entity ale existují |
| `InventoryReservation` | ✓ | ✓ | gramáž z konkrétních kompatibilních zásob; TTL před capture, allocated po přijetí, spotřeba až při tisku |
| `CapacityReservation` | ✓ | ✓ | nekolidující strojové intervaly pro všechny plánované podložky včetně bufferu |
| `ProductionReservation` | ✓ | ✓ | pre-capture ji váže `phase_resource_plan_id + planned_job_key`, po potvrzení se stejný klíč doplní o `job_id`; atomická inventory + capacity rezervace se snapshoty candidate profilu/kalibrace/configu |
| `PhaseReservationSet` | ✓ | ✓ | all-or-none obal všech `ProductionReservation` potřebných pro právě aktivovanou fázi |
| `ReplacementRequest` | ✓ | ✓ | per Job trvalá recovery povinnost od neúspěchu až k rezervovanému náhradnímu Jobu nebo stornu |
| `ReplacementRequestSet` / `ReplacementResourcePlan` / `ReplacementReservationSet` | ✓ | ✓ | claimový all-or-none scope všech dotčených slotů, child requestů, plánů, rezervací, Jobů a zásilek |
| `ReferenceProfile` | ✓ | ✓ | `material × quality`, bez modelu stroje; jen quote slice |
| `MachineCapability` | ✓ | ✓ | statické schopnosti modelu stroje |
| `MachineProfile` | ✓ | ✓ | `model × nozzle × material × quality`; jen produkční slice |
| `MachineCalibration` | ✓ | ✓ | immutable override snapshot konkrétního stroje |
| `PrintConfigRevision` | ✓ | ✓ | zvolená výplň a další toolpath volby; součást každého slice klíče |
| `PriceList` | ✓ | ✓ | verzovaný; objednávka drží referenci |
| `QuoteRequest` / `Quote` | ✓ | ✓ | individuální nabídka |
| `CostInput` | ✓ | ✓ | nákupy filamentu, sazba energie, spotřební materiál |
| `HandlingSession` | ✓ | ✓ | aktivní práce: komponenta, začátek/konec, počty a zdroj měření |
| `ShipmentPlan` | ✓ | ✓ | plán celého množství/fáze; kategorie, objem, hmotnost a cena |
| `EligibilitySnapshot` | ✓ | ✓ | alternativní kompletní `PhaseResourcePlan` a jejich candidate odhady, konfigurace a barvy |
| `Shipment` | ✓ | ✓ | `Order 1:N Shipment` od v0; více parcel jedné fáze i současná original/replacement historie, náhrada má `replaces_shipment_id` + `origin_claim_id` |
| `Claim` | ✓ | ✓ | rodičovský agregát s `origin = post_delivery_quality | shipment_incident` a stavem `opened / investigating / active / resolved_*` |
| `ClaimSlotResolution` / `ClaimShipmentIncident` | ✓ | ✓ | exkluzivní per-slot remedy flow a incident náhradní parcely uvnitř rodiče; nikdy vnořený Claim |
| `ReplacementFulfilmentAuthorization` | ✓ | ✓ | jednorázové oprávnění k handoff úplné množiny Jobů a slotů claimového reprint Shipmentu |
| `ReshipmentAuthorization` | ✓ | ✓ | jednorázové custody-backed oprávnění předat nalezený/vrácený fyzický obsah bez druhého přechodu Jobu |
| `AuditEvent` | — | ✓ | |
| `Offer`, `QualityEvent`, `Certification`, `Payout` | — | — | jen při stavbě sítě |

### 6.3 Stavové automaty

Každý `Order` včetně v0 vytvoří před potvrzením alespoň jeden `OrderPhase`. Ve v0 je to právě jedna fáze `kind = single`, takže používá stejnou QC, handoff, shipment-lineage a settlement bariéru jako v1 bez zvláštní phase-free větve. V1 může zůstat `single` nebo vytvořit dvojici `sample` / `batch`; vícefázový workflow je rozšíření počtu a typu fází, ne zavedení entity až v pozdější verzi.

**Order — fulfilment**
```
draft → quoted → confirmed → in_production → qc_passed
      → ready_to_ship → shipped → delivered → completed
qc_passed → awaiting_balance → ready_to_ship
awaiting_balance → cancelled_settled
awaiting_balance → shipped (jen přes `HandoffReconciliation` + immutable settlement)
qc_passed | awaiting_balance | ready_to_ship → recovery_pending → qc_passed
recovery_pending → cancelled
```
`confirmed` znamená, že je uhrazená částka potřebná ke startu: u automatické nabídky 100 %, u individuální nabídky záloha. `ready_to_ship → shipped` se neřídí názvem odvozeného `payment_status`, ale aktuálním cenovým snapshotem: guard vyžaduje `amount_due = 0` a `refundable_balance = 0`. Samotná záloha proto nestačí, zatímco finančně vypořádané snížení ceny může být po částečné refundaci bezpečně odesláno i se stavem `partially_refunded`. Výjimečný `awaiting_balance → shipped` není handoff autorizace; pouze promítá již nastalou fyzickou custody po `HandoffReconciliation` a nulový finanční zůstatek odvozený z jeho settlementu.

Odbočky: `quoted → expired | cancelled`; `confirmed | in_production | qc_passed | ready_to_ship | recovery_pending → cancelled`; `in_production | shipped | recovery_pending → partially_fulfilled`, pokud je nejméně jeden `FulfilmentSlot` doručený a každý zbývající slot je doručený nebo finančně vypořádaný jako `cancelled_refunded`. Při ztracené/vrácené zásilce nebo vyčerpané post-QC recovery bez jediného doručeného slotu vede dokončený refund přes `shipped | recovery_pending → cancelled → refunded`. Nezaplacené `cancelled` je terminální. Zrušená objednávka se zachycenou platbou skončí `refunded`, pokud nevznikla zasloužená hodnota, nebo `cancelled_settled` přes explicitní `OrderSettlement`; blanket pravidlo „každý capture celý vrátit“ neplatí po doložené výrobě. `completed`, `partially_fulfilled`, `refunded` a `cancelled_settled` jsou terminální fulfilment stavy; pozdější reklamace je nemění.

U individuální nabídky vytvoří dokončení QC zbývající `balance` Payment a nastaví `balance_due_at = qc_approved_at + balance_payment_days`; agregát čeká v `awaiting_balance`. Po připomínkách a marném deadline timeout v jedné databázové transakci zamkne Order i balance Payment, nastaví `capture_authorized = false`, `capture_cutoff_at = now`, přepne dosud `pending` Payment na `voided`, zapíše idempotentní outbox příkaz ke zrušení provider intentu a teprve potom vytvoří immutable `OrderSettlement`. `earned_amount` je nejvýše prokazatelně vzniklá a v přijatých podmínkách sjednaná hodnota s guardem `0 ≤ earned_amount ≤ contract_total`, `retained_amount = min(captured_total, earned_amount)`, `refund_amount = captured_total − retained_amount`, `written_off_amount = max(0, earned_amount − captured_total)` a `unearned_cancelled_amount = contract_total − earned_amount`; počítají se jen capture, jejichž webhook získal tento zámek před cutoffem.

Webhook a timeout soutěží o stejný zámek. Vyhraje-li capture před timeoutem, je součástí settlementových součtů. Přijde-li úspěšný provider capture až po `capture_authorized = false`, existujícím `OrderSettlement` nebo terminálním stavu Order, handler jej auditovaně zapíše, ale objednávku znovu neotevře a settlement nemění; v téže transakci přepne `voided → refund_pending`, vytvoří `LateCaptureCompensation` na celou pozdě zachycenou částku a plnou `RefundTransaction` s idempotency klíčem `late_balance_capture + provider_transaction_id`. Compensation použije `kind = unauthorized_handoff_balance`, pokud existující settlement vznikl z `HandoffReconciliation`, jinak `kind = balance_settlement`. Capture po cutoffu se z immutable settlementových `captured_total` i z jeho odvozených Order `amount_due`/`refundable_balance` vyloučí; vlastní `compensation_balance` zůstává viditelný v provozu, automaticky se retryuje a alertuje až do nuly. Po úspěšném refundu přebytku známého při běžném settlementu Order přejde do `cancelled_settled`; pozdější kompenzace tento terminální fulfilment stav ani `abandoned_item_delete_after` nemění. Záloha tedy není automaticky propadná ani automaticky celá vratná a pozdní doplatek nikdy nezmění dispoziční větev; politiku musí před spuštěním potvrdit právní poradce.

**Shipment**
```
planned → label_created → handed_over → in_transit → delivered
planned → cancelled
label_created → cancellation_pending → cancelled
cancellation_pending → handed_over (po doloženém scanu před voidem jen přes úplný context-specific handoff nebo `HandoffReconciliation`)
in_transit → lost | returned
lost → recovered
```
`cancel_shipment` zamyká Shipment, jeho Joby a parent cancellation/withdrawal request ve stejném deterministickém pořadí jako `handoff_shipment`. `planned` bez labelu přejde rovnou do terminálního `cancelled` a v téže transakci zruší své pre-handoff Joby, vypořádá rezervace a odblokuje parent cancellation barrier. U `label_created` nejdřív nastaví `cancellation_requested_at`, lokálně `label_usable = false`, zneplatní download token a přepne Shipment do `cancellation_pending`; idempotentní outbox `void_carrier_label + carrier_label_id` pak žádá dopravce o zneplatnění. Dokud provider void nepotvrdí, lokální handoff je blokovaný, ale packed Joby, slot lineage, rezervace i nepoužité fulfilment/reshipment autorizace se ještě neruší. Cancellation guard současně zmrazí relevantní parent Order/Phase/Claim stav a finanční snapshot: nadřazený tok nesmí dokončit storno, spustit refund ani změnit podmínky původně autorizovaného handoffu.

Potvrzený provider void přepne pod stejným zámkem Shipment `cancellation_pending → cancelled`; teprve tato transakce zruší jeho pre-handoff Joby, vypořádá rezervace a odblokuje parent cancellation barrier. Pokud místo toho dopravce doloží fyzický acceptance scan dřív, než void uspěl, idempotentní `commit_verified_handoff(provider_scan_id)` zruší pending storno pro tento scope a podle původu Shipmentu zavolá **celou** příslušnou doménovou transakci: běžná parcela se splněnými business guardy provede všechny side effects `handoff_shipment` včetně přechodu OrderPhase/Order při prvním handoffu; claimový reprint spotřebuje `ReplacementFulfilmentAuthorization`, posune všechny náhradní Joby a child resolution do `replacement_shipped`; custody reship spotřebuje `ReshipmentAuthorization`, ponechá původní Joby beze změny a child resolution nastaví `reship_shipped`. Běžná parcela, jejíž frozen cancellation snapshot nesplňuje pouze finanční/aggregate handoff guard, musí místo předstírané autorizace zavolat úplný `ReconcileUnauthorizedCarrierHandoff` níže. Žádná větev nesmí provést jen holý update Shipmentu/Jobů ani ignorovat doloženou custody. Požadované storno/withdrawal se pak nesmí terminálně dokončit ani spustit původně plánovaný refund a pokračuje běžná delivery/incident větev. Void failure se retryuje a alertuje, `cancellation_pending` se nikdy nepovažuje za neškodný terminální label. Pod terminálním Orderem nebo Claimem proto nezůstane live Shipment lineage leaf ani použitelný carrier label.

`ReconcileUnauthorizedCarrierHandoff` je povolený jen pro ověřený provider scan běžného Shipmentu, kdy přesná slot/Job lineage, `packed` fyzický obsah a absence `recovery_blocked` platí, ale frozen Order je např. `awaiting_balance` a nesplňuje finanční guard normálního handoffu. Pod stejnými Shipment/Job/Phase/Order/Payment locks vytvoří jediný `HandoffReconciliation(provider_scan_id)`, odmítne cancellation request, označí Shipment `handed_over` s `handoff_mode = unauthorized_reconciled`, přepne jeho packed Joby do faktického `handed_over` a fázi do `shipped`. Současně nastaví `balance_due_at = null`, zavře všechny otevřené balance capture windows a vytvoří immutable `OrderSettlement(kind = unauthorized_handoff)`: `earned_amount` smí být nejvýše právně schválená a doložená hodnota s `0 ≤ earned_amount ≤ contract_total`, `retained_amount = min(pre_cutoff_captured_total, earned_amount)`, `refund_amount = pre_cutoff_captured_total − retained_amount`, `written_off_amount = max(0, earned_amount − pre_cutoff_captured_total)` a `unearned_cancelled_amount = contract_total − earned_amount`; jeho finanční projekce nastaví `amount_due = 0` a případný `refundable_balance` na konkrétní refund. Teprve s tímto reconciliation ID přepne Order z `awaiting_balance` do výjimečného `shipped`; nejde o úspěch normálního handoff guardu.

Provider balance capture po reconciliation cutoffu se nezapočítá do settlementu, Order znovu neotevře a dostane plnou `LateCaptureCompensation(kind = unauthorized_handoff_balance)` s unikátním provider-transaction klíčem. Delivery/lost/returned události potom pokračují nad skutečnou Shipment lineage, ale `completed | partially_fulfilled` čeká i na nulový settlement refund a compensation balance. Nesedí-li fyzická lineage/content guard, scan se uloží jako blokující custody incident k manuálnímu přiřazení; void, parent storno ani refund se nesmí falešně dokončit. Settlement politiku a retained `earned_amount` musí před spuštěním schválit právní poradce.

`lost` a `returned` na běžném Shipmentu bez `origin_claim_id` automaticky otevřou incident-backed `Claim` proti zásilce, i když objednávka ještě není `delivered`. Pokud některé sloty už vlastní neterminální Claim, incident handler je pod stejnými slot locks rozdělí podle `active_claim_id`: ke každému vlastníkovi připojí idempotentní `ClaimShipmentIncident` jen pro jeho podmnožinu a její `ClaimSlotResolution` vrátí do `recovery_pending`; pro zbylé neobsazené sloty vytvoří nejvýše jeden nový incident Claim. Stejně se postupuje, má-li postižený Shipment `origin_claim_id`: nový Claim se **nevytvoří**, incident se idempotentně připojí k uvedenému rodiči a jen dotčené child resolution se vrátí do recovery. Každý rodič zůstává `active` a jeho retenční hold trvá až do výsledku všech vlastněných reklamovaných slotů.

Volba `ClaimSlotResolution.reship_pending` má tvrdý guard `status ∈ {returned, recovered} && custody_confirmed_at != null && re_qc_passed_at != null`; teprve fyzicky převzatý a znovu zkontrolovaný výrobek smí dostat nový `Shipment` s `replaces_shipment_id` a stejným `origin_claim_id`. Nový Shipment převezme tutéž jedinou slot allocation původního `ShipmentPlan` jako její aktuální lineage leaf, nevytváří druhé přiřazení slotů. Ve stejné transakci vznikne jednorázové `ReshipmentAuthorization` navázané na Claim, původní Shipment, nový Shipment a přesnou množinu fyzicky převzatých `FulfilmentSlot`. Příkaz `handoff_reshipment` vyžaduje stále platnou custody a nové QC, atomicky autorizaci spotřebuje, posune pouze nový Shipment `label_created → handed_over` a dotčené child resolution do `reship_shipped`; původní Joby zůstanou `handed_over | settled` a podruhé se nepřepínají. Doručení nastaví jejich `delivered_reship` a teprve parent aggregate může skončit `resolved_reship | resolved_mixed`. Dokud zásilka zůstává `lost`, child smí zvolit jen kompletně rezervovaný reprint nebo refund — prázdný reshipment nikdy nevznikne.

Náhradní fulfilment **zachová aktuální agregátní stav podle fáze**: ztracený sample je mezifáze, takže objednávka zůstává `in_production` a doručení náhrady vrátí sample do `awaiting_confirmation`; ztracená finální/jediná zásilka zůstává `shipped` a do `delivered` přejde až po doručení náhrady. Žádná recovery větev proto nevynucuje skok `in_production → shipped`. Pokud zákazník zvolí refund, z aktuálního stavu se použije větev `cancelled → refunded` nebo `partially_fulfilled` výše, takže nedoručená zaplacená objednávka nezůstane viset.

**Payment**
```
created → pending → captured
pending → failed | voided
captured | partially_refunded → refund_pending
voided → refund_pending (jen po doloženém provider late capture)
refund_pending → partially_refunded | refunded
```
Každý refund je samostatná idempotentní transakce a `refunded_amount` je součet úspěšných refundací konkrétního capture. Po webhooku se stav vrátí do `partially_refunded`, dokud `refunded_amount < captured_amount`; teprve rovnost znamená `refunded`. Opakované dílčí refundace jsou tedy stejnou smyčkou, nikoli falešným přechodem do plného refundu. Objednávkový `payment_status` je projekce všech jejích plateb, ne náhrada jejich historie.

**Claim**
```
opened → investigating → active
investigating → resolved_rejected (jen čistý post_delivery_quality)
active → resolved_reprint | resolved_reship | resolved_refund | resolved_mixed
opened | investigating | active → withdrawn (jen čistý post_delivery_quality před handoff)
```

**ClaimSlotResolution**
```
pending → rejected (jen čistý post_delivery_quality)
pending → reship_pending → reship_shipped → delivered_reship
pending → reprint_pending → replacement_in_production → replacement_shipped → delivered_reprint
pending → refund_pending → refunded
reship_pending | reprint_pending | replacement_in_production → refund_pending (až po `ClaimRemedyCancellation` barrier)
replacement_in_production → recovery_pending (až po `ClaimRemedyCancellation(target = recovery)` barrier)
replacement_shipped | reship_shipped → recovery_pending (jen s ověřeným `lost | returned` incidentem)
recovery_pending → reship_pending | reprint_pending | refund_pending
pending | reship_pending | reprint_pending | replacement_in_production | recovery_pending → withdrawn (jen čistý post_delivery_quality)
```
Quality Claim lze otevřít proti doručené položce/fázi bez ohledu na to, zda je agregátní objednávka `delivered`, `completed` nebo `partially_fulfilled`; jen rodič bez jediného incident-backed slotu smí po vyšetření skončit `resolved_rejected` nebo se před handoff stáhnout. `reject_claim` pod zámkem vyžaduje, aby rodič byl stále `investigating`, neměl žádný Job, autorizaci, refund ani incident a všechny jeho child resolution byly `pending`; v jedné transakci je přepne na `rejected`, rodiče na `resolved_rejected`, uvolní všechna `active_claim_id` a přepočítá retenční deadline. Automatický shipment incident patří Shipmentu ve stavu `lost | returned | recovered`, i když je agregát teprve `in_production` nebo `shipped`; dokud jeho sloty nejsou doručené náhradou/reshipem nebo finančně vypořádané, rodič nesmí přejít do `resolved_rejected | withdrawn`.

Příkaz vytvoření Claim zamkne všechny cílové `FulfilmentSlot` v deterministickém pořadí. Slot s `active_claim_id = null` přiřadí novému Claim a vytvoří unikátní `ClaimSlotResolution(claim_id, slot_id, claimed_shipment_leaf_id)`; retry se stejným idempotency klíčem vrátí tentýž rodič. Pokud libovolný slot už vlastní jiný neterminální Claim, celý create se bez částečných změn odmítne a UI/API vrátí konfliktní rodiče. Překrývá-li request právě jednoho vlastníka, lze případné další neobsazené sloty přidat jen samostatným atomickým `extend_claim`, který znovu zamkne celou rozšiřovanou množinu a nesmí překrýt jiného vlastníka; více vlastníků se musí nejdřív provozně vypořádat, nikdy sloučit po vytvoření Jobů. Automatický shipment incident se naproti tomu povinně rozpartitionuje a připojí k existujícím vlastníkům, jak je popsáno výše. `active_claim_id` se uvolní až při terminálním stavu rodiče, takže dvě souběžné item/phase žádosti nikdy nevytvoří dvě replacement lineage pro tentýž slot; nový pozdější Claim může cílit až aktuální doručený Shipment leaf po skončení předchozího.

Rodič přejde po výběru alespoň jednoho remedy do `active`, zatímco každý jeho slot může **současně a nezávisle** zvolit `reship_pending`, `reprint_pending` nebo `refund_pending`. Reprint pod stejnými slot locks nejdřív ověří `active_claim_id = claim_id` i unikátní child resolution pro celý scope; při jediné odchylce vše abortuje. Potom snapshotuje `replacement_required_slots` jen z child resolution ve `reprint_pending` a vytvoří pro ně `ReplacementRequestSet` s jedním child `ReplacementRequest` pro každý plánovaný náhradní Job/parcel group tak, aby každý required slot pokryl právě jeden request; rodič s ostatními reship/refund sloty zůstává `active`.

Čerstvá eligibility vytvoří kompletní `ReplacementResourcePlan` přes všechny child requesty a stroje; deterministické parcel plány rozdělí každý slot právě do jednoho replacement Shipmentu. Jedna transakce all-or-none získá `ReplacementReservationSet` se samostatnou `ProductionReservation` pro každý plánovaný Job a vytvoří všechny nové Job lineage leaf i všechny replacement Shipmenty; jediný konflikt vrátí celý set a nevytvoří žádný Job ani Shipment. Teprve potom přejdou jen zahrnuté `ClaimSlotResolution` do `replacement_in_production`, rodič zůstává `active`. Jakmile jsou pro konkrétní replacement Shipment všechny aktuální lineage leaf QC-approved a `packed`, jedna transakce vydá immutable jednorázové `ReplacementFulfilmentAuthorization` navázané na `claim_id`, právě jeden `replacement_shipment_id`, úplné aktuální `replacement_job_ids` a `replacement_slot_ids` této parcely a původní `shipment_id`; pre-handoff selhání kteréhokoli leaf autorizaci zneplatní a novou lze vydat až pro kompletní náhradní lineage. Autorizace má `replacement_amount_due = 0`; handoff všech aktuálních replacement Shipment lineage leaf posune příslušné child resolution do `replacement_shipped` a jejich doručení do `delivered_reprint`. Teprve parent aggregate smí skončit `resolved_reprint | resolved_mixed`; stav původní objednávky se nemění. Náhrada jedné ztracené parcely tak běžně vytvoří jeden nový Shipment, ale širší položkový claim není omezený na fyzicky neproveditelný jediný balík.

Volba refundu z `pending` může nastavit dotčené `ClaimSlotResolution.refund_pending` rovnou, ale z `reship_pending | reprint_pending | replacement_in_production` nejdřív vytvoří idempotentní `ClaimRemedyCancellation(target = refund)` a child ponechá v dosavadním stavu. Stejný příkaz s `target = recovery` povinně použije i selhání náhradního fulfilmentu ve `replacement_in_production`; holý přechod do `recovery_pending` je před handoffem zakázaný. Příkaz pod stejnými Claim/slot/Shipment/Job locks zahájí auditované uzavření otevřeného `ReplacementRequestSet` a pro každý aktuální pre-handoff replacement/reship Shipment leaf zavolá `cancel_shipment`; `planned` leaf se uzavře rovnou, `label_created` musí projít `cancellation_pending` a provider-confirmed voidem. Dokud se na provider void čeká, Joby, rezervace i dosud nepoužitá remedy autorizace zůstávají zachované pro případ doloženého fyzického scanu. Teprve když jsou všechny tyto Shipment leaf `cancelled`, completion transakce zruší request set, zneplatní autorizace, vypořádá Joby a rezervace a podle immutable targetu přepne child do `refund_pending` a spustí finanční větev, nebo jej bez finančního side effectu přepne do `recovery_pending`. Vyhraje-li fyzický handoff, cancellation request se odmítne, child přejde do `replacement_shipped | reship_shipped` a refund lze znovu zvolit jen přes ověřený shipment incident a `recovery_pending` popsané níže.

Po splnění této bariéry zamkne refund command rodičovský Claim a všechny jeho child resolution a vytvoří immutable `claim_credit_scope` výhradně z ID těch `ClaimSlotResolution`, které v **téže transakci** přepíná do `refund_pending`; retry se stejným idempotency klíčem znovu použije přesně tuto množinu. Sibling child ve `reship_pending | reship_shipped | delivered_reship | reprint_pending | replacement_in_production | replacement_shipped | delivered_reprint` se do scope nesmí dostat a pokračuje svou fulfilment větví. Rodič zůstává `active`.

Pod zámkem všech slotů v `claim_credit_scope`, jejich cenových alokací, Payment a aktivních refundů odvodí `claim_credit_amount = Σ remaining_contract_value` jen tohoto refund-target scope. Před platební operací vytvoří novou immutable revizi cenového snapshotu `PriceAdjustment(kind = claim_slot_credit)` s `contract_total' = contract_total − claim_credit_amount`. Teprve proti aktivovanému nižšímu snapshotu přepočítá `refundable_balance = max(0, net_captured − contract_total')` a idempotentně vytvoří `RefundTransaction` na dosud nevrácenou a žádným pending refundem nealokovanou hodnotu těchto slotů proti konkrétním capture. Unikátní spotřeba component allocations a `ClaimSlotResolution` v jednom `claim_credit_scope` brání dvojímu snížení smluvní ceny při retry, souběžném claimu nebo předchozím SLA creditu. Až úspěšný platební webhook označí příslušné child resolution jako `refunded`; `amount_due` zůstane nulové, protože smluvní cena klesla před refundem. U pre-delivery incidentu se dosud nedoručené refundované sloty teprve tehdy označí také `cancelled_refunded` a přepočítá se agregát; u post-delivery reklamace zůstává původní slot `delivered` a terminální Order beze změny. Vyprší-li deadline claimového `ReplacementRequestSet` bez kompletní rezervace nebo náhradní fulfilment selže bez dalšího pokusu, celý set se auditovaně zruší a jen jeho dotčené child resolution automaticky přejdou do této refund větve.

`SamplePrerequisiteAbort` je společný atomický příkaz pro finanční opuštění nedoručeného sample, dokud batch ještě není aktivní: spustí jej refund incident-backed Claimu i vyčerpání pre-handoff výrobní recovery. Spouštěč předá `sample_failure_scope` — u shipment incidentu přesně refund-target sample sloty z immutable `claim_credit_scope`, nikdy jeho reprint/reship siblingy, nebo všechny dosud nedoručené sample sloty při zrušení celé výrobní fáze. Příkaz zamkne všechny fáze a sloty Orderu i jejich cenové alokace. `PriceAdjustment(kind = claim_slot_credit | recovery_slot_credit, reason = sample_prerequisite_abort)` podle spouštěče spotřebuje `remaining_contract_value` jen celého `sample_failure_scope`; pro batch ve stejné transakci zavolá `CancelUnactivatedBatch(reason = sample_prerequisite_abort)` popsaný ve fázovaném flow níže, který spotřebuje jeho oddělené alokace. Po úspěchu všech příslušných refund webhooků jsou sloty obou credit scopes `cancelled_refunded`, batch fáze `cancelled_refunded` a refund-target child resolution `refunded`; případný Claim zůstává `active`, dokud jeho ostatní remedy child nedojdou k výsledku, a pak skončí jako `resolved_refund | resolved_mixed` podle obecné parent bariéry. Sample fáze čeká, dokud každý její slot není `delivered | cancelled_refunded`; bez doručeného slotu pak skončí `cancelled_refunded`, jinak `partially_fulfilled`. Teprve terminální sample i batch dovolí Orderu bez dodaného slotu projít `cancelled → refunded`, nebo s doručeným sample slotem skončit `partially_fulfilled`. Zamčená předplacená dávka tak nikdy nezůstane bez výrobní cesty ani bez creditu.

Rodičovský Claim je terminální teprve, když má **každý** jeho `ClaimSlotResolution` odpovídající terminální dispozici: všechny `rejected` dávají `resolved_rejected`, všechny `withdrawn` dávají `withdrawn`, všechny `delivered_reprint` `resolved_reprint`, všechny `delivered_reship` `resolved_reship`, všechny `refunded` `resolved_refund` a jakákoli kombinace fulfilment/refund výsledků `resolved_mixed`. `rejected` ani `withdrawn` se s remedy výsledkem kombinovat nesmějí, protože jejich příkazy vyžadují čistý parent scope před handoff/refundem. Jakmile remedy Shipment přešel do `handed_over`, jeho child resolution nesmí přejít z `replacement_shipped | reship_shipped` přímo do `refund_pending`. Přechod do `recovery_pending` povolí jen transakce, která pod stejnými Shipment/Claim/slot locks zapíše ověřený incident `lost | returned` na aktuálním shipment lineage leaf. Vyhraje-li souběžně delivery, child skončí v `delivered_reprint | delivered_reship` a refund se odmítne; vyhraje-li incident, teprve `recovery_pending` smí zvolit další kompletní reprint set, custody-backed reship nebo refund, vždy uvnitř stejného aktivního rodiče a se stejnou per-slot agregační bariérou. Terminální stav tedy dokazuje celý výsledek, nikoli pouhou volbu operátora nebo výsledek prvního balíku, a teprve pak uvolní `active_claim_id` všech slotů i jediný retenční hold.

Stažení je povolené jen pro rodiče `origin = post_delivery_quality`, který nemá incident-backed child ani child ve `refund_pending | refunded | reship_shipped | replacement_shipped | delivered_reship | delivered_reprint`. `withdraw_claim` vytvoří idempotentní withdrawal request a pro každý nepředaný replacement Shipment zavolá `cancel_shipment`; pokud některý label přejde do `cancellation_pending`, rodič i child resolution zůstanou neterminální, slot ownership a retenční hold se neuvolní a Joby se ještě neruší. Teprve po terminálním `Shipment.cancelled` všech těchto lineage leaf závěrečná transakce zruší celý otevřený `ReplacementRequestSet` a všechny aktivní pre-handoff Joby přes `cancellation_reason = claim_withdrawn`, zneplatní dosud nepoužité `ReplacementFulfilmentAuthorization` i `ReshipmentAuthorization`, vypořádá child rezervace, přepne všechny neterminální child resolution na `withdrawn`, rodiče na `withdrawn`, uvolní slot ownership a přepočítá retenční deadline. Vyhraje-li u kteréhokoli labelu fyzický handoff, withdrawal request se odmítne a Claim zůstává aktivní do delivery/incident výsledku. Rodiče `origin = shipment_incident` ani quality Claim s připojeným incidentem stáhnout nelze.

Pro post-delivery claim otevřený do snapshotovaného `claim_until` čte přechod child resolution do `reprint_pending` kanonickou geometrii a přijatou `PrintConfigRevision` z rodičovských `ReproductionArtifact` všech dotčených slotů; sealed verze skutečně doručených Jobů zůstávají důkaz a `reproduces_artifact_version_id`. Jejich `CandidateResourceEstimate`, `MachineProfile`, `MachineCalibration` ani production `SliceResult` se do reprintu nekopírují. Čerstvý complete replacement plan a `ReplacementReservationSet` mohou pro jednotlivé náhradní Joby vybrat jiné stroje a acceptance každého Jobu z jeho child rezervace vytvoří a později sealne novou machine-specific verzi. Flow tak nezávisí na smazaném zdrojovém `ModelFile`, ale ani nefalšuje vstupy nového stroje. Před terminálním stavem nemá reprodukční artefakt expiraci; terminální objednávka bez doručení použije `undelivered_reproduction_retention_days` a otevřený shipment incident nebo claim prodlouží retenci až do terminálního vyřešení.

**Job**
```
created → accepted → gcode_ready → printing → printed → photo_submitted → qc_approved → packed → handed_over → settled
created → cancelled
photo_submitted → qc_rejected
accepted | gcode_ready | printing | printed | photo_submitted | qc_approved | packed → failed
accepted | gcode_ready | printing | printed | photo_submitted | qc_approved | packed → cancelled
```
`created → cancelled` je terminální cesta po vyčerpání routing nabídek; ukládá `cancellation_reason = routing_exhausted | order_cancelled`, zavře otevřené offers, uvolní `ProductionReservation` a spustí odpovídající order settlement/refund. Po přijetí smí zákaznické/order storno použít tutéž terminální větev s `cancellation_reason = order_cancelled | phase_cancelled | claim_withdrawn` z kteréhokoli pre-handoff stavu. Před `printing` uvolní rezervovanou gramáž a nevyužité intervaly; během/po tisku zapíše skutečnou spotřebu, uvolní zbytek a auditovaně naloží s rozpracovaným či hotovým kusem. Má-li Job `Shipment.label_created`, storno jej ponechá beze změny až do výsledku `cancel_shipment`; zruší jej teprve provider void, zatímco doložený handoff jej posune do `handed_over`. Oba příkazy zamykají stejné řádky, takže již předaný Job se neruší a pokračuje jako shipment incident. Jednotlivé maker rejection/timeout události zůstávají na `Offer`, Job ve stavu `created` se zruší až po vyčerpání celé množiny.

`failed` ukládá `failure_stage = preparation | gcode | machine | printing | post_print | post_qc | packing` a důvod. Větve před tiskem pokrývají odstoupení makera/G-code/poruchu; `printing` zmetek; `printed | photo_submitted` ztrátu nebo poškození při dokončení; `qc_approved | packed` poškození při balení nebo ztrátu před předáním dopravci. `photo_submitted → qc_rejected` zůstává další terminální neúspěšná větev. Všechny pre-handoff neúspěchy používají stejnou auditovanou `ReplacementRequest`/cancellation recovery; až `handed_over` převádí ztrátu na `Shipment` incident.

Post-QC failure před **prvním** handoffem přepne dotčenou fázi z `qc_passed` do `recovery_pending`; u finální/jediné fáze totéž přepne agregát z `qc_passed | awaiting_balance | ready_to_ship`, zneplatní aktivní `balance_due_at` a zachová existující `PaymentSchedule` i capture. Po QC náhrady se fáze i případný agregát vrátí do `qc_passed`: při `amount_due = 0` agregát pokračuje do `ready_to_ship`, jinak do `awaiting_balance` s novým `balance_due_at`. Jakmile byl ale předán alespoň jeden Shipment téže fáze, finální/jediná fáze i Order zůstávají `shipped`, zatímco sample fáze zůstává `shipped` a její mezifázový Order `in_production`; selhání Jobu pro pozdější nepředanou parcelu vytvoří `ReplacementRequest`, označí její sloty `recovery_blocked` a zablokuje pouze handoff dotčeného ShipmentPlan i completion barrier. QC náhrady blok uvolní. Vyčerpání recovery pod stejnými zámky a pravidly component allocations jako claim refund nejdřív použije `PriceAdjustment(kind = recovery_slot_credit)` na dosud nekreditovanou hodnotu dotčených slotů a až potom jejich refund; je-li však zrušenou fází nedoručený sample a batch ještě není aktivní, povinně spustí `SamplePrerequisiteAbort` výše s `sample_failure_scope` všech nedoručených sample slotů a přes `CancelUnactivatedBatch` kredituje i celý zamčený batch. Již předané parcely jinak dál doběhnou a teprve jejich výsledky spolu s refundovanými sloty určí `delivered | partially_fulfilled | cancelled → refunded`. Nevzniká tedy nelegální agregátní návrat z `shipped`, falešný doplatek ani druhý capture již uhrazené částky. Recovery se měří odděleně a nezhoršuje tiskový FPY.

Handoff je příkaz `handoff_shipment`, protože opakovatelnou fyzickou jednotkou je parcela, ne Job. Každý Job smí plnit více `FulfilmentSlot`, ale všechny musejí patřit jedinému `ShipmentPlan`; jeden plán naopak může čekat na více Jobů. Příkaz v jedné transakci ověří, že všechny aktuální Job lineage leaf přiřazených slotů jsou `packed`, žádný slot není `recovery_blocked`, přepne právě jeden Shipment do `handed_over` a všechny jeho přispívající Joby `packed → handed_over`. U běžné finální nebo jediné fáze navíc vyžaduje `amount_due = 0`, `refundable_balance = 0` a buď `Order.status = ready_to_ship && OrderPhase.status = qc_passed` pro první parcelu, nebo `Order.status = shipped && OrderPhase.status = shipped` pro další dosud nepředaný plán téže fáze; první handoff posune oba do `shipped`, další je tam ponechají. U mezifázového sample vyžaduje `phase_amount_due = 0` podle aktuálního `PaymentSchedule` a buď `Order.status = in_production && OrderPhase.status = qc_passed` pro první parcelu, nebo `Order.status = in_production && OrderPhase.status = shipped` pro každý další dosud nepředaný plán téže sample fáze; první handoff posune jen sample fázi do `shipped` a všechny handoffy ponechají agregátní Order v `in_production`. Claimový reprint vyžaduje QC a `packed` stav **všech** `replacement_job_ids`, přesnou shodu jejich sjednocených slotů s `replacement_slot_ids` nového Shipmentu a dosud nepoužité `ReplacementFulfilmentAuthorization` pro tento kompletní Claim/Shipment scope; autorizaci v téže transakci spotřebuje a všechny náhradní Joby posune jednou. Custody-backed reship používá oddělený `handoff_reshipment` výše, který žádný původní Job nemění. `commit_verified_handoff` je carrier-scan dispatcher: doloženému provider eventu povolí jako zdroj `cancellation_pending` místo `label_created`, zachová každý ostatní guard a side effect a při jejich splnění dokončí celý ordinary/reprint/reship handler. Pokud u běžné parcely selže pouze frozen finanční/aggregate guard navzdory ověřené custody a validní fyzické lineage, povinně dispatchuje celý `ReconcileUnauthorizedCarrierHandoff`; nikdy guard potichu neobchází ani scan nezahodí. Cancellation guard drží původní finanční, phase a autorizační předpoklady immutable a dispatcher musí dokončit vybraný handler před označením scanu za zpracovaný. Původní Order si zachová `in_production | shipped` při pre-delivery incidentu nebo svůj terminální stav po doručení. Žádný Job proto nemůže být předán dvakrát ani blokovat handoff další parcely.

Obě neúspěšné větve jednotlivého produkčního Jobu vytvoří trvalý `ReplacementRequest` navázaný na tento Job. Původní `ProductionReservation` se nejdřív vypořádá podle fáze: před `printing` uvolní veškerou gramáž a nevyužité intervaly, během/po tisku zapíše skutečnou spotřebu a uvolní jen zbytek. Příkaz `create_replacement` potom vytvoří čerstvý `EligibilitySnapshot` a znovu vyhodnotí aktuální požadavek materiálu/kapacity. V jedné transakci získá novou `ProductionReservation` — čerstvou gramáž i nekolidující strojové intervaly — a teprve pak vytvoří nový `Job` ve stavu `created` s `replaces_job_id`. Stará rezervace ani spotřebovaný materiál nikdy nekryjí nový pokus. Původní Job zůstane terminálně `failed` nebo `qc_rejected`, aby se neztratil first-pass yield. Claimový reprint přes více slotů nepoužívá tento singulární shortcut; musí projít úplným `ReplacementRequestSet`/`ReplacementReservationSet` popsaným výše.

Pokud novou rezervaci nelze získat, `ReplacementRequest` zůstane auditovatelně `pending_capacity`, Job se nevytvoří ani nenabídne a systém opakuje hledání jen do provozního deadline. Pak se request z výrobního selhání i neúspěšná fáze zruší: objednávka bez jediného doručeného slotu přejde do `cancelled → refunded`, objednávka s alespoň jedním doručeným slotem se po vrácení nedoručené části uzavře `partially_fulfilled`. Claimový `ReplacementRequestSet` zůstává `pending_capacity`, dokud nemá celý rezervovatelný plán; deadline zruší všechny jeho child requesty/rezervace a přepne jen zahrnuté `ClaimSlotResolution` do refund fallbacku popsaného výše, zatímco rodič zůstává `active` do výsledku ostatních slotů. Potvrzená objednávka tedy musí mít aktivní/úspěšný listový Job, otevřenou singulární nebo setovou replacement povinnost s deadlinem, nebo finanční vypořádání.

**Časová razítka stavových přechodů měří průchod procesem, ne aktivní handling.** Mezi přechody je tisk, čekání ve frontě, čekání na zákazníka i doprava, takže jejich rozdíl nesmí vstoupit do nákladů práce.

Aktivní práci zachycuje samostatný `HandlingSession`: `component`, `started_at`, `ended_at`, vazba na objednávku/job a jmenovatele `plate_count`, `piece_count` nebo `shipment_count`. Administrace nabídne start/stop časovač; pro činnost bez časovače (zejména `shipping_trip`) je povolený strukturovaný ruční zápis délky se zdrojem `manual`. U dávkové práce se zapíše jedna relace a počet obsloužených jednotek, aby šla doba správně rozpočítat. Stavové časové značky zůstávají pro SLA a provozní metriky, `HandlingSession` pro CM a kalibraci parametrů.

**Fázovaná objednávka (v1)**
```
quote → sample (1 ks každého OrderItem) → zákazník potvrdí fit celé sady
      nebo nahraje revidovaný model
      → dávka (zbývající množství každého OrderItem)
```

Fázování je ve v1 vlastnost **celé objednávky**, ne přepínač jednotlivé položky, a má precondition `ordered_quantity_i ≥ 2` pro každý zahrnutý `OrderItem`. Při přechodu do `quoted` se proto pro každý item immutable odvodí `sample_quantity_i = 1` a kladné `batch_quantity_i = ordered_quantity_i − 1`. Sample fáze obsahuje právě jeden `FulfilmentSlot` každé samostatné výrobní konfigurace; u `OrderItem` seskupujícího více těles znamená jeden kus celou vybranou sadu těles. Batch fáze obsahuje zbývající sloty každé položky. Položka s množstvím 1 patří do samostatného `single` Orderu nebo zákazník množství zvýší; API ani UI ji nesmí přijmout do sample/batch Orderu, takže každou nevyhovující sample konfiguraci lze opravit jejími existujícími batch sloty.

Zákazník potvrzuje nebo odmítá fit dodané sample sady atomicky za celou objednávku. Částečné potvrzení jen některých položek ani kombinace `single` a `sample/batch` položek v jednom Orderu se ve v1 nepodporuje; chce-li zákazník vzorek jen pro podmnožinu košíku, vytvoří pro ni samostatný Order. Toto členství a počty se po quote nemění a každý sample i batch slot odkazuje původní `order_item_id`, takže pricing, rezervace, výroba, zásilky i settlement používají stejnou množinu.

Cena obou fází pro všechny původní `OrderItem` se zamkne už při nacenění, takže zákazník od začátku ví celkovou částku. Při počátečním capture vznikne `PhaseReservationSet` jen pro celý sample plan; batch zůstává cenově zamčený, ale bez blokované gramáže nebo strojových intervalů po celou výrobu, přepravu a případnou náhradu vzorku. Potvrzení fitu beze změny modelu cenu nemění, ale před aktivací vytvoří čerstvý `EligibilitySnapshot` a atomicky získá nový kompletní batch `PhaseReservationSet`; prošlý či kolidující interval se nikdy nepovažuje za kapacitu.

`CancelUnactivatedBatch(reason)` je jediná finanční cesta z batch `locked | awaiting_revision | awaiting_capacity` do storna. Pod společným zámkem fáze, všech jejích slotů a component allocations, aktivního cenového snapshotu, revision Payment, ostatních Payment a aktivních refundů nejdřív zavře případné revision capture window a teprve potom zruší batch a uvolní jeho krátkou rezervaci. Odvodí `batch_credit_amount = Σ remaining_contract_value` všech batch slotů, vytvoří a aktivuje právě jeden immutable `PriceAdjustment(kind = batch_cancellation_credit)` s unikátním klíčem `order_id + batch_phase_id + batch_cancellation_credit` a sníží `contract_total` před přepočtem `refundable_balance`; `reason` ukládá jen jako auditní příčinu, ne jako část unikátní identity. Teprve proti novému snapshotu vytvoří refundy dosud nevrácené a žádným pending refundem nealokované batch hodnoty. Unikátní spotřeba component allocations i idempotency klíč zabrání druhému creditu při závodu timeoutu, odmítnutí revize a sample abortu; až úspěch všech refund webhooků nastaví batch sloty a fázi na `cancelled_refunded`. Příkaz používá `reason = confirmation_expired | revision_rejected | sample_prerequisite_abort`.

Nahrání revidovaného `ModelFile` původní cenu batch fáze ruší: vznikne `OrderRevision` s neprázdnou explicitní množinou `affected_order_item_ids` a mapováním každé dotčené položky na náhradní výběr `ModelGeometry` a případnou novou `PrintConfigRevision`. Revize nahrazuje pouze dosud nevyrobené batch sloty uvedených položek; doručené sample sloty i geometrie, konfigurace, množství a sloty ostatních `OrderItem` zůstávají immutable. Hranice nového uploadu sama nerozhoduje, které položky se mění, ani když původní `ModelFile` používalo více položek.

Nový preflight a referenční slice se provedou pro každou dotčenou položku. Revidovaný cenový snapshot se nesmí ocenit jako nová samostatná batch objednávka: vychází z immutable výrobních/phase allocations a print weight už dodané sample fáze, nahradí příspěvky dotčených batch slotů a přidá nezměněné příspěvky ostatních batch slotů. Nad tímto celým Orderem znovu vyhodnotí `min_print_price`, gramážní hranici i jediný `small_order_surcharge` právě jednou; předchozí order-level minimum ani surcharge se k výsledku nepřičítají jako druhá zamčená sample položka, ale jejich komponenty nahradí tento jediný nový výsledek. Už dodaná sample doprava, balení a jejich allocations zůstávají beze změny; nový endpoint-bound `ShipmentPlan` se sestaví pouze pro **celý zbývající batch** včetně nezměněných položek. Cenový rozdíl se alokuje jen k dosud nevyrobeným batch slotům, takže settlement amounts dodaného sample zůstávají immutable, a zákazník přijme výsledný rozdíl celkové smluvní ceny přes tokenizovaný odkaz.

Příkaz přijetí revize vždy vytvoří čerstvý `EligibilitySnapshot` a atomicky získá kompletní batch `PhaseReservationSet` pro všechny zbývající sloty, gramáž a kapacitu, přestože náhradní geometrie se týká jen `affected_order_item_ids`. Dokud to nelze, přijetí se necommitne, revize zůstává `awaiting_capacity` a batch se neaktivuje. Sample se tedy podruhé neplánuje, nerezervuje ani neúčtuje, ale jeho zamčené příspěvky zůstávají součástí jediného order-level pricing základu.

Zvýšení ceny vytvoří `balance` Payment navázaný na revizi a `revision_amount_due`; jeho capture smí začít až po novém setu rezervací. Batch se aktivuje teprve po přijetí revize, `revision_amount_due = 0` **a** celém `PhaseReservationSet` ve stavu `held`. Původní záloha tedy nestačí k výrobě zdražené geometrie. Pokud krátká rezervace vyprší a capture webhook před `confirmation_deadline_at` nedokáže atomicky získat nový kompletní batch set, pod společným Payment/revision/phase/resource zámkem nastaví tomuto pokusu `capture_authorized = false`, `capture_cutoff_at = now`, ponechá revizi i batch v `awaiting_capacity`, vyloučí kompenzovaný capture z `revision_amount_due`, přepne Payment do `refund_pending` a vytvoří plnou `LateCaptureCompensation(kind = revision_capacity)` s klíčem `revision_capacity + provider_transaction_id`. Až její refund uspěje, smí zákazník před confirmation deadlinem vytvořit nový balance Payment pokus, ale jen po novém kompletním setu; timeout/rejection pod stejnými zámky retry zakáže a použije svůj terminální flow. Souběh tedy nikdy neaktivuje batch ze starého capture ani jej nevrátí podruhé.

Snížení ceny nemění stejný požadavek na kompletní set — nižší cena může stále znamenat více materiálu nebo delší obsazení stroje. Přijetí revize v jedné transakci odvodí `net_captured = captured_total − refunded_total`, `revision_amount_due = max(0, revised_contract_total − net_captured)` a `refundable_balance = max(0, net_captured − revised_contract_total)`. Je-li `refundable_balance > 0`, vytvoří na přesně tuto částku idempotentní `RefundTransaction` s klíčem `order_revision_id` a přepne dotčené capture do `refund_pending`; jinak sleva pouze sníží budoucí doplatek. Úspěšný webhook sníží odvozený `refundable_balance` na nulu; automatické retry a provozní alert pokračují do vypořádání a handoff zůstává do té doby blokovaný.

Cena sample fáze ani už vzniklé náklady se zpětně nemění. Příkaz odmítnutí revize pod společným zámkem vyžaduje sample v `awaiting_confirmation`, batch v `awaiting_revision | awaiting_capacity` a dosud neaktivovanou revizi; přepne sample do terminálního `completed(completion_reason = revision_rejected)`, nastaví `confirmation_deadline_at = null`, zruší všechny neodeslané reminder joby a označí revizi `rejected`. Ve stejné transakci zavolá `CancelUnactivatedBatch(reason = revision_rejected)`, který před refundem zavře capture window, uvolní rezervace a odebere batch z aktivní smluvní ceny. Provider success po cutoffu je vyloučený z Order balances a jde přímo do plné `LateCaptureCompensation(kind = revision_rejected)`. Po finančním vypořádání batch skončí `cancelled_refunded` a agregát jako `partially_fulfilled`; timeout worker už nemá živý deadline, proti kterému by mohl znovu zasáhnout. Guard terminálního vypořádání není konkrétní `payment_status`, ale `amount_due = 0` a `refundable_balance = 0`, takže částečná refundace je platný terminální výsledek. Trh tuhle iteraci běžně dělá — ale e-mailem přes čtyři až šest zpráv.

Každá fáze je samostatný `OrderPhase`; sample a batch mají vlastní joby a vlastní `Shipment`. Doručení vzorku dokončí pouze sample fázi a přepne ji na čekání na potvrzení, nikoli celou objednávku na `delivered`. Batch se aktivuje až potvrzením fitu beze změny a atomickým získáním čerstvého úplného `PhaseReservationSet`, nebo přijetím `OrderRevision` s `revision_amount_due = 0` a novým setem ve stavu `held`. Každá úspěšná aktivace batch pod stejným zámkem přepne sample `awaiting_confirmation → completed(completion_reason = fit_confirmed)`, nastaví `confirmation_deadline_at = null` a zruší jeho neodeslané reminder joby. Cena všech plánovaných zásilek je součástí příslušného cenového snapshotu.

Doručení sample nastaví `confirmation_deadline_at = delivered_at + sample_confirmation_days`. Deadline zůstává aktivní pro batch `locked | awaiting_revision | awaiting_capacity` a končí jen jeho aktivací nebo stornem; samotný upload rozpracované revize jej nemaže. Pokud batch do deadline není aktivní, atomický timeout pod společným zámkem Orderu, batch fáze, aktivní `OrderRevision` a všech jejích `balance` Payment zavolá `CancelUnactivatedBatch(reason = confirmation_expired)`. Jeho první krok nastaví každému dosud otevřenému revision Payment `capture_authorized = false` a `capture_cutoff_at = now`, přepne `pending → voided` a zapíše idempotentní outbox zrušení provider intentu; teprve potom timeout přepne sample `awaiting_confirmation → confirmation_expired` a příkaz zruší batch, uvolní případnou krátkou rezervaci, aktivuje `batch_cancellation_credit` a spustí refund celé nečerpané batch části. Capture, který získal společný zámek před cutoffem, je v tomto refundu zahrnutý. Pozdější provider success se auditovaně zapíše, ale nesmí znovu získat phase plan ani aktivovat revizi či batch: Payment přejde `voided → refund_pending` a v téže transakci vznikne plná `LateCaptureCompensation(kind = sample_confirmation_expired)` a `RefundTransaction` s klíčem `expired_sample_confirmation + provider_transaction_id`. Capture po cutoffu je vyloučený z objednávkového `net_captured`, `amount_due` i `refundable_balance`; jeho oddělený `compensation_balance` zůstává viditelný a retryovaný do nuly, ale terminální fulfilment znovu neotevře. Systémem zaviněné `awaiting_capacity` smí deadline prodloužit jen explicitní auditovanou událostí oznámenou zákazníkovi, nikdy potichu. Po `amount_due = 0` a `refundable_balance = 0` agregát přejde z `in_production` do terminálního `partially_fulfilled`; doručený sample se tím nepředstírá jako neuskutečněný. Deadline i odeslané připomínky jsou auditované. Před doručením sample žádný confirmation deadline není potřeba pro zdroje batch, protože žádné nejsou držené; ztráta nebo opakovaný reprint vzorku tak cenu batch nemění, ale ani neblokuje inventář či kalendář.

```
single: quoted → active → in_production → qc_passed → shipped → delivered → completed
        quoted | active | in_production | qc_passed → cancelled
        cancelled → cancelled_refunded | cancelled_settled
        qc_passed → recovery_pending → qc_passed
        shipped | recovery_pending → partially_fulfilled | cancelled_refunded

sample: quoted → active → in_production → qc_passed → shipped → delivered → awaiting_confirmation
        awaiting_confirmation → completed (fit_confirmed | revision_rejected) | confirmation_expired
        quoted | active | in_production | qc_passed → cancelled
        cancelled → cancelled_refunded | cancelled_settled
        qc_passed → recovery_pending → qc_passed
        shipped | recovery_pending → partially_fulfilled | cancelled_refunded

batch:  locked → active → in_production → qc_passed → shipped → delivered → completed
        locked → awaiting_capacity → active
        locked → awaiting_revision → awaiting_capacity → active
                                    → active
        locked | awaiting_revision | awaiting_capacity | active | in_production | qc_passed → cancelled
        cancelled → cancelled_refunded | cancelled_settled
        qc_passed → recovery_pending → qc_passed
        shipped | recovery_pending → partially_fulfilled | cancelled_refunded
```
Každá objednávka vytvoří stabilní phase topology a `required_fulfilment_slots` už v transakci `Order.draft → quoted`, dřív než vznikne `EligibilitySnapshot`, `PhaseResourcePlan`, `PhaseReservationSet` nebo provider Payment intent. V0 vytvoří právě jednu `OrderPhase(kind = single, status = quoted)`; fázovaná v1 objednávka `sample(status = quoted)` a cenově zamčený `batch(status = locked)`. Každý plán i rezervace odkazuje tato existující immutable phase/slot ID. Úspěšný počáteční `full | deposit` capture pod stejným zámkem ověří celý set, přepne `single | sample` z `quoted → active` a Order z `quoted → confirmed`; batch zůstane `locked`. Timeout, storno nebo kompenzovaný capture místo toho ukončí pre-capture phase/slot scope bez jediného Jobu.

Výslovný phase graf výše řídí produkci, QC, první i další parcel handoff, delivery, recovery, storno i completion bez phase-free nebo implicitní batch analogie. Události sample fáze stav celkové objednávky za `in_production` neposouvají. Každá fáze snapshotuje `required_fulfilment_slots` tak, aby každý naceněný kus patřil právě jednomu slotu; Job může plnit více slotů jen uvnitř jediného `ShipmentPlan` a jeden plán může agregovat více Jobů. Do `qc_passed` smí fáze přejít až tehdy, když každý slot má právě jeden aktuální Job lineage leaf ve stavu `qc_approved | packed | handed_over | settled` a nemá otevřený `ReplacementRequest`; schválení prvního z více jobů nestačí. Do `delivered` smí přejít až po doručení každého aktuálního Shipment lineage leaf. Směs doručených a `cancelled_refunded` slotů končí `partially_fulfilled`; pokud není doručený žádný slot a všechny jsou refundované, fáze končí `cancelled_refunded` a agregát bez jiné dodané fáze pokračuje `cancelled → refunded`.

Storno po QC, ale před prvním handoff, zamkne fázi, její Joby i Shipmenty ve stejném pořadí jako `handoff_shipment`: finální Order může být `qc_passed | awaiting_balance | ready_to_ship`, zatímco jeho fáze je stále `qc_passed`. Každý `planned` Shipment se zruší rovnou, každý `label_created` musí projít `cancellation_pending`; dokud všechny nejsou `cancelled`, fáze i Order zůstávají v dosavadním neterminálním stavu, Joby a rezervace se zachovají a refund nezačne. Teprve completion transakce po provider voidu přepne fázi `qc_passed → cancelled`, zruší všechny její pre-handoff Joby a vypořádá rezervace podle skutečné spotřeby. Vyhraje-li fyzický handoff, storno se pro tento scope odmítne a fáze pokračuje ve `shipped`. Bez zachycených peněz je `cancelled` terminální; jinak fáze skončí až jako `cancelled_refunded` po úplném vrácení nezasloužené hodnoty nebo `cancelled_settled` po vlastním immutable settlementu a nulových `amount_due` i `refundable_balance`. Order smí dokončit odpovídající `refunded | cancelled_settled` větev až poté, takže pod terminálním agregátem nezůstane fáze v `qc_passed`, live Shipment ani aktivní label.

Poslední aktivní fáze — běžně batch — teprve po splnění příslušné bariéry řídí **všechny** zbývající přechody agregátu: `in_production → qc_passed`; plně předplacená objednávka s připravenými zásilkami `→ ready_to_ship`, individuální nabídka s doplatkem `→ awaiting_balance → ready_to_ship`; první handoff `→ shipped`, všechny doručené sloty `→ delivered` a uzavření `→ completed`, případně smíšený terminální výsledek `→ partially_fulfilled`. Agregát tedy nikdy nepřeskakuje mezistavy pevného automatu a marný doplatek končí přes `cancelled_settled`.

**QuoteRequest**
```
new → in_review → quoted → accepted → (vytvoří Order)
                        → rejected | expired
```

### 6.4 Invarianty

1. G-code se generuje **až po** `accepted`.
2. `Job` nesmí z `created` vstoupit do `accepted` ani provozního stavu bez přiřazeného `Node`; routing exhaustion smí přejít přímo `created → cancelled` s auditním důvodem a uvolněním rezervace.
3. `confirmed` vyžaduje zachycenou plnou platbu u automatické nabídky nebo zachycenou zálohu u individuální nabídky.
4. `shipped` vyžaduje vůči aktuálnímu cenovému snapshotu `amount_due = 0` a `refundable_balance = 0`; záloha sama nikdy nestačí, ale dokončená částečná refundace odeslání neblokuje.
5. `SliceResult` použitý pro cenu vždy odkazuje na `ReferenceProfile`, nikdy na `MachineProfile`, a jeho klíč obsahuje `geometry_hash` konkrétního `ModelGeometry`, `print_config_revision_id` i `parts_per_plate`; machine-specific odhad rezervace používá oddělený `CandidateResourceEstimate`.
6. `Order` nesmí být `confirmed` bez reference na **verzi ceníku a verzi podmínek**.
7. `Job` si při přijetí ukládá `payout_amount` i `payout_currency`, i když je příjemcem provozovatel; po aktivaci maker modelu jsou tato částka a měna u maker-owned assignmentu přesným immutable aliasem `MakerCompensationSnapshot.(agreed_compensation, currency)`, zatímco platform-owned fallback zůstává interním jobem bez maker assignmentu, snapshotu a settlementu.
8. Závazná cena smí vzniknout jen z deterministického výpočtu.
9. Makerovy náklady **nikdy** nevstupují do zákaznické ceny.
10. Neúspěšný job musí mít otevřený `ReplacementRequest` s deadlinem; navazující `Job` přes `replaces_job_id` smí vzniknout jen atomicky s čerstvou `ProductionReservation`. Jinak se jeho slot/fáze zruší: bez jediného dříve doručeného `FulfilmentSlot` následuje `cancelled → refunded`, s alespoň jedním doručeným slotem finančně vypořádané `partially_fulfilled`; u nedoručeného prerequisite sample se současně zruší a kredituje i neaktivovaný batch.
11. Každá zásilka fázované objednávky patří právě k jedné `OrderPhase`; sample zásilka nesmí dokončit celou objednávku a poslední fáze musí vyvolat všechny mezistavy agregátu.
12. Revidovaný `ModelFile` nesmí aktivovat batch bez nového deterministického slice, cenového snapshotu, čerstvého `EligibilitySnapshot`, atomicky získaného kompletního `PhaseReservationSet`, přijetí `OrderRevision` zákazníkem a `revision_amount_due = 0`; požadavek na materiál a kapacitu všech itemů platí i při zlevnění. Odmítnutí revize musí atomicky ukončit sample jako `completed(revision_rejected)`, vymazat jeho confirmation deadline, zrušit batch a po finančním vypořádání uzavřít agregát `partially_fulfilled`.
13. `ProductionReservation`, production `SliceResult`, přijatý `Job` a jeho sealed `ReproductionArtifactVersion` drží tatáž immutable ID candidate odhadu, `MachineProfile`, `MachineCalibration` a `PrintConfigRevision`; acceptance je kopíruje z rezervace, `gcode_ready` verzi uzamkne a aktivní revize je smí nahradit jen společně s atomickým re-estimate/re-reserve.
14. Závazná cena musí mít `ShipmentPlan` pro celé množství každé fáze; žádný plánovaný balík nesmí překročit objemový ani hmotnostní limit kategorie.
15. `Claim` je jediná cesta pro reklamaci po doručení i incident po předání dopravci; náhradní fulfilment zachová `in_production` u mezifáze a `shipped` u finální fáze, refund vyvolá finančně vypořádané storno bez zakázaného skoku agregátu.
16. Závazná cena a capture platby vyžadují čerstvý `EligibilitySnapshot` s alespoň jedním kompletním `PhaseResourcePlan`, který přes stabilní pre-capture phase/slot ID pokrývá každý `required_fulfilment_slot` právě aktivované fáze. Capture smí začít až po all-or-none vytvoření `PhaseReservationSet` se všemi potřebnými `ProductionReservation` napříč vybranými stroji; částečná rezervace jediného itemu nestačí. Počáteční capture fázované objednávky přepne již existující sample `quoted → active` a rezervuje jen jeho celý plán, batch se znovu vyhodnotí a rezervuje až při vlastní aktivaci.
17. Každá změna stavu zapisuje `AuditEvent` (od v1).
18. Sample v `awaiting_confirmation` musí mít `confirmation_deadline_at`; timeout nejdřív atomicky zavře všechny revision capture windows, potom zruší neaktivovaný batch, uvolní případnou krátkou aktivační rezervaci, spustí refund nečerpané části a po vypořádání uzavře agregát `partially_fulfilled`.
19. Individuální objednávka v `awaiting_balance` musí mít `balance_due_at`; timeout vytvoří `OrderSettlement`, vypořádá přebytek capture a write-off doplatku a uzavře `cancelled_settled`, takže výrobek ani pohledávka nezůstanou otevřené bez deadline.
20. `ClaimSlotResolution.reship_pending` vyžaduje fyzicky převzatou zásilku `returned | recovered`, nové QC a jednorázové `ReshipmentAuthorization`; `handoff_reshipment` posune pouze nový Shipment a nikdy podruhé původní Job, child `delivered_reship` vznikne až doručením. `lost` bez custody smí zvolit jen kompletně rezervovaný reprint nebo refund.
21. Selhání `Job` po QC před prvním handoffem musí převést dotčenou fázi do `recovery_pending` a u finální/jediné fáze i agregát. Po prvním předaném Shipmentu musí fáze zůstat `shipped`; finální/jediný Order zůstane `shipped`, mezifázový sample Order `in_production`, dotčené nepředané sloty budou `recovery_blocked` a completion čeká na QC náhrady nebo finanční vypořádání.
22. `handoff_shipment` smí v jedné transakci předat právě jednu parcelu jen tehdy, když všechny její sloty mají nezablokovaný `packed` aktuální Job leaf a každý přispívající Job patří výhradně jejímu `ShipmentPlan`; běžná finální/jediná fáze navíc vyžaduje nulové finanční zůstatky a dvojici `Order.ready_to_ship + OrderPhase.qc_passed` pro první parcelu nebo `Order.shipped + OrderPhase.shipped` pro další plán, mezifázový sample nulový `phase_amount_due` a `Order.in_production + OrderPhase.qc_passed` pro první parcelu nebo `Order.in_production + OrderPhase.shipped` pro další plán, claimový reprint jednorázové oprávnění přesně pro daný Claim, replacement Shipment a úplné množiny Jobů/slotů.
23. `OrderPhase.qc_passed` vyžaduje schválený aktuální lineage leaf pro každý `required_fulfilment_slot` a žádný otevřený `ReplacementRequest`; jednotlivý Job nesmí posunout vícejobovou fázi ani agregát předčasně.
24. Úspěšný capture smí potvrdit objednávku nebo revizi jen s dosud neexpirovaným úplným `PhaseReservationSet`; opožděný webhook smí celý plán atomicky znovu získat jen při `capture_authorized = true` a před immutable business deadline. Po `capture_cutoff_at` nebo neúspěšné reacquisition nesmí aktivovat phase, potvrdit Order/revizi ani vytvořit Job a musí zachycenou platbu okamžitě kompenzovat plným refundem.
25. Před potvrzením fitu se fyzické zdroje rezervují jen pro celý sample plán; cenově zamčený batch získá vlastní čerstvý `PhaseReservationSet` až při aktivaci, takže přeprava ani recovery vzorku nemůže držet batch zdroje bez deadline.
26. Storno objednávky, fáze nebo claimu před handoff musí nejdřív terminálně zrušit `planned` Shipmenty a přes provider-confirmed void ukončit každý `label_created → cancellation_pending → cancelled`; až potom smí zrušit aktivní Joby, vypořádat rezervace a refundovat. Doložený handoff závod vyhrává a stav `failed` se pro obchodní storno nepoužívá.
27. Každý `FulfilmentSlot` patří právě do jedné plánované zásilky; fáze ani Order nesmí být `delivered | completed`, dokud nejsou doručené všechny aktuální Shipment lineage leaf. Doručené plus finančně vypořádané `cancelled_refunded` sloty končí `partially_fulfilled` i uvnitř jediné fáze.
28. Claim smí být terminální až po výsledku každého `ClaimSlotResolution`: jednotný výsledek dává `resolved_reprint | resolved_reship | resolved_refund`, kombinace `resolved_mixed`; vypršený `ReplacementRequestSet` musí atomicky zrušit všechny child requesty/rezervace a převést jeho nevyřešené sloty do auditované refund větve.
29. Přijetí zlevňující `OrderRevision` musí z nového snapshotu odvodit doplatek/přeplatek a při `refundable_balance > 0` idempotentně vytvořit refund přesně této částky a přepnout dotčený capture do `refund_pending`; handoff zůstává blokovaný do úspěšného webhooku.
30. 3MF s paint daty nebo více material/extruder assignmenty nesmí v v0/v1 získat závaznou automatickou cenu; blocking preflight jej pošle do individuální nabídky před kanonizací a slicingem.
31. Vyčerpání post-QC recovery musí finančně vypořádat dotčené sloty: nebyl-li předán žádný Shipment, bez doručení fáze skončí `cancelled_refunded` a agregát `cancelled → refunded`, přičemž u prerequisite sample samostatný `batch_cancellation_credit` vypořádá i celý neaktivovaný batch; s dříve doručeným slotem oba skončí `partially_fulfilled`. Byl-li už jiný Shipment předán, fáze zůstává `shipped`, finální/jediný Order `shipped` a mezifázový sample Order `in_production` do výsledku všech předaných parcel; teprve jejich delivery/refund bariéra určí terminální agregát.
32. `withdraw_claim` je povolený jen pro rodiče `origin = post_delivery_quality` bez incident-backed child a před handoffem každého child; Claim zůstává neterminální, dokud každý nepředaný replacement Shipment není provider-confirmed `cancelled`. Teprve závěrečná transakce jej nastaví `withdrawn`, zruší request set/Joby, zneplatní autorizace, vypořádá rezervace a uvolní slot ownership i retenční hold.
33. Jeden Job nesmí obsahovat `FulfilmentSlot` z více `ShipmentPlan`; `handoff_shipment` atomicky předá jeden Shipment a všechny jeho přispívající packed Joby, takže každý Job projde `packed → handed_over` nejvýše jednou.
34. Každý Job claimového reprintu používá z příslušného doručeného artefaktu jen kanonickou geometrii, přijatou zákaznickou konfiguraci a evidenční odkaz; vlastní candidate/profile/calibration/production slice musí jeho nová `ReproductionArtifactVersion` převzít z child rezervace kompletního čerstvého replacement setu.
35. Každý terminální Order musí mít `reproduction_delete_after` rovný nejpozdějšímu použitelnému termínu: maximu `claim_until` doručených slotů a, pokud žádný slot nebyl doručen nebo existuje nedoručená verze, `terminal_at + undelivered_reproduction_retention_days`; otevřený incident, Claim nebo legal hold datum pouze prodlužuje.
36. QC zamítnutí musí použít deklarovaný terminální přechod `photo_submitted → qc_rejected`, vytvořit `ReplacementRequest` a nesmí se vykázat jako obecný produkční `failed`.
37. Timeout doplatku musí před vytvořením `OrderSettlement` pod stejným zámkem zneplatnit balance capture; provider capture zpracovaný po cutoffu nebo settlementu se nesmí započíst do splnění objednávky a musí v téže transakci spustit idempotentní plnou refundaci.
38. Porušení expresního SLA musí před refundem příplatku aktivovat následnou immutable revizi cenového snapshotu, která odebere dosud nekreditovanou alokaci `express_priplatek`; teprve poté může refund snížit `refundable_balance` bez vytvoření nového `amount_due` nebo dvojího creditu.
39. Storno finální fáze po QC a před handoff musí převést `OrderPhase.qc_passed → cancelled` a po finančním vypořádání do `cancelled_refunded | cancelled_settled`; Order nesmí být terminální, dokud jeho fáze terminální není.
40. Custody-backed `handoff_reshipment` musí spotřebovat přesné `ReshipmentAuthorization`, posunout jen nový Shipment a ponechat původní `handed_over | settled` Joby beze změny; bez custody a re-QC se nesmí spustit.
41. Claim refund musí v téže transakci jako přechod child do `refund_pending` vytvořit immutable `claim_credit_scope` obsahující jen tyto refund-target resolution/sloty a před platebním refundem aktivovat idempotentní `claim_slot_credit` o součet jejich `remaining_contract_value` po předchozích component credits; reprint/reship/delivered sibling se nesmí kreditovat. U prerequisite abortu nedoručeného sample se batch odebere samostatným `batch_cancellation_credit` a tatáž alokace se nesmí z ceny odečíst ani refundovat dvakrát.
42. Claimový reprint Shipment smí vzniknout jen atomicky s kompletním `ReplacementRequestSet`, `ReplacementResourcePlan` a `ReplacementReservationSet`, které pokryjí každý `replacement_required_slot` právě jedním novým Job lineage leaf; částečný set nesmí přejít do výroby ani handoffu.
43. Post-QC selhání nepředané pozdější parcely po prvním handoffu zachová fázi ve `shipped`, finální/jediný Order ve `shipped` a mezifázový sample Order v `in_production`, zablokuje dotčené sloty a nesmí dokončit delivery ani předat jejich ShipmentPlan před QC náhrady nebo finančním vypořádáním.
44. Claim s `origin = shipment_incident` nebo libovolným incident-backed child nesmí skončit `resolved_rejected | withdrawn`; dokud každý jeho slot není doručený přes aktuální shipment lineage nebo finančně vypořádaný, rodič musí zůstat `active`.
45. `lost | returned` Shipment s `origin_claim_id` nebo slotem vlastněným neterminálním Claim nesmí otevřít nový Claim; musí vytvořit idempotentní `ClaimShipmentIncident` v rodiči, vrátit dotčené child resolution do recovery a uvolnit retenční hold až po terminálním výsledku všech slotů.
46. Každý v0 Order musí mít při potvrzení právě jednu `OrderPhase(kind = single, status = active)` s explicitní topologií `active → in_production → qc_passed → shipped → delivered → completed` a deklarovanými recovery/cancellation větvemi; QC, první i další parcel handoff, delivery a settlement guardy nesmějí mít phase-free variantu ani spoléhat na implicitní batch analogii.
47. Remedy stav patří `ClaimSlotResolution`, ne rodičovskému Claim: různé sloty téhož aktivního rodiče smějí současně procházet reship, reprint a refund větví a rodič se terminálně odvodí až z jejich úplné množiny.
48. Každý `FulfilmentSlot` smí mít nejvýše jeden `active_claim_id`; vytvoření/rozšíření Claim, automatický shipment incident i vznik `ReplacementRequestSet` musí vlastnictví ověřit pod zámkem a terminální rodič je atomicky uvolní.
49. Expresní příplatek, `express_due_at` a `ExpressSlaBreach` jsou povolené jen pro Order s právě jednou `OrderPhase(kind = single)`; sample/batch objednávka nesmí expres zobrazit ani nacenit, dokud nemá phase-scoped SLA a credit.
50. `resolved_rejected | withdrawn` rodič vyžaduje stejnou terminální dispozici na každém `ClaimSlotResolution` a atomické uvolnění `active_claim_id`; incident-backed, handed-off nebo refundovaný child tyto příkazy blokuje.
51. Refund incidentu nedoručeného sample musí ve stejné transakci zrušit dosud neaktivovaný batch a před jeho refundem aktivovat `batch_cancellation_credit` přes všechny jeho sloty a component allocations; bez jiného doručeného slotu smí Order skončit až po úplném `cancelled → refunded`, s doručeným sample slotem jako finančně vypořádaný `partially_fulfilled`.
52. Confirmation timeout musí před stornem batch a uvolněním rezervace atomicky zavřít capture window každého revision Payment; provider success po `capture_cutoff_at` nesmí znovu rezervovat ani aktivovat batch a musí vytvořit idempotentní plnou kompenzační refundaci.
53. Vyčerpání pre-handoff recovery nedoručeného sample musí použít tentýž `SamplePrerequisiteAbort` jako jeho shipment-incident refund: `recovery_slot_credit` pokryje nedoručené sample sloty, oddělený `batch_cancellation_credit` celý neaktivovaný batch a obě fáze musejí skončit před `cancelled → refunded` Orderu.
54. Odmítnutí revize nesmí ponechat sample v `awaiting_confirmation`; pod stejným zámkem jej ukončí jako `completed(revision_rejected)`, vymaže `confirmation_deadline_at`, zruší reminders a teprve s terminálním batch dovolí agregátu `partially_fulfilled`.
55. Každé vrácení nečerpaného batch musí nejdřív aktivovat idempotentní `PriceAdjustment(kind = batch_cancellation_credit)` přes všechny dosud nekreditované batch allocations; timeout, odmítnutí revize ani sample abort nesmějí refundovat proti snapshotu, jehož `contract_total` batch stále obsahuje.
56. `OrderPhase(kind = single)` má vlastní deklarovaný počáteční stav, happy path i recovery/cancellation přechody; implementace nesmí jeho v0 lifecycle odvozovat z phase-free Order grafu ani z nevyřčené podobnosti s batch.
57. Každý `ModelFile` i jeho rekonstruovatelný mezivýstup musí získat `source_delete_after` už při uploadu; Quote jej smí jen prodloužit, aktivní Order drží auditovaný hold a terminální Order deadline přepočítá, takže abandon ani preflight failure bez nabídky nezůstanou bez mazání.
58. Každý pre-handoff Shipment musí mít deklarovanou cancellation větev: `planned → cancelled` nebo `label_created → cancellation_pending → cancelled`; u vydaného labelu nesmějí být parent Order/Phase/Claim, Joby, rezervace ani refund terminální před provider voidem a doložená fyzická custody pod stejným zámkem storno přebije přes úplný příslušný handoff command nebo explicitní `HandoffReconciliation`.
59. Carrier scan, který vyhraje nad `cancellation_pending`, musí podle původu Shipmentu atomicky provést všechny side effects `handoff_shipment` nebo `handoff_reshipment`; pokud běžnému Shipmentu při validní fyzické lineage brání jen frozen finanční/aggregate guard, musí místo nich dokončit `ReconcileUnauthorizedCarrierHandoff` včetně settlementu. Holý update Shipmentu/Jobů i zahození scanu jsou zakázané.
60. Sample rozdělený do více parcel povolí po prvním handoffu každý další plán z `Order.in_production + OrderPhase.shipped`; první handoff posune jen fázi a žádný sample handoff neposune agregátní Order do `shipped`.
61. Child remedy ve `replacement_shipped | reship_shipped` smí vstoupit do `recovery_pending` jen spolu s ověřeným `lost | returned` incidentem aktuálního Shipment leaf pod stejnými locks; přímý přechod do refundu je po fyzickém handoffu zakázaný.
62. Refund child remedy ve `reship_pending | reprint_pending | replacement_in_production` ani recovery z `replacement_in_production` nesmí začít před dokončením `ClaimRemedyCancellation(target = refund | recovery)`: všechny jeho pre-handoff Shipment leaf musí být provider-confirmed `cancelled`, Joby a rezervace vypořádané a autorizace zneplatněné; vítězný handoff oba targety odmítne a přesměruje child do shipped větve.
63. Každý `PhotoAsset` musí dostat `photo_delete_after` už při uploadu; Quote jej smí omezeně prodloužit, aktivní Order drží dočasný hold a terminální Order deadline přepočítá podle `claim_until` nebo `photo_retention_days`. Potom smí smazání odložit jen aktivní Claim ve stejném scope nebo legal hold, nikdy souhlas s publikací.
64. `claim_credit_scope` obsahuje výhradně `ClaimSlotResolution` atomicky přepínané do `refund_pending` jednou idempotentní refund operací; sibling slot s fulfilment remedy se nesmí zahrnout do `claim_credit_amount`, `PriceAdjustment` ani `RefundTransaction`.
65. Initial checkout musí vytvořit `single | sample` `OrderPhase(status = quoted)` a jeho immutable `required_fulfilment_slots` před `PhaseResourcePlan`, rezervací a Payment intentem; teprve platný `full | deposit` capture je atomicky aktivuje spolu s `Order.quoted → confirmed`.
66. `full | deposit` Payment má stejně jako `balance` explicitní capture window. Timeout nebo storno musí pod společným zámkem zavřít autorizaci, voidnout provider intent a uvolnit phase resources; provider success po cutoffu nebo bez kompletní reacquisition pouze vytvoří plnou `LateCaptureCompensation` a nesmí potvrdit Order.
67. Neúspěšná reacquisition batch setu po revision `balance` capture musí zavřít právě tento Payment pokus, vyloučit jeho capture z `revision_amount_due` a plně jej refundovat přes `LateCaptureCompensation(kind = revision_capacity)`; revize smí zůstat retryable jen do původního confirmation deadline a až po úspěchu kompenzace.
68. Ověřený scan běžné parcely v `cancellation_pending`, která nesplňuje jen finanční/aggregate handoff guard, musí atomicky vytvořit `HandoffReconciliation`, zaznamenat faktickou custody/Job transitions, zavřít balance captures, vytvořit `OrderSettlement(kind = unauthorized_handoff)` a teprve potom výjimečně posunout phase/Order do `shipped`; nesmí se vydávat za autorizovaný handoff ani dovolit původnímu stornu/refundu dokončit.
69. `Order` má vztah 1:N k `ShipmentPlan` i `Shipment` už v v0: jedna `single` fáze smí vytvořit více parcel a replacement/reship lineage zachovává původní Shipment vedle aktuálního leaf; implementace nesmí použít singulární `order.shipment_id`.
70. `ClaimSlotResolution.recovery_pending` smí přejít do `withdrawn` jen u čistého `post_delivery_quality` rodiče bez incident-backed child a po dokončení všech pre-handoff cancellation barriers; recovery vzniklou z `lost | returned` incidentu stáhnout nelze.
71. `ModelFile` a `OrderItem` jsou nezávislé koncepty: jeden upload může být zdrojem více položek s odlišným výběrem těles, materiálem, barvou, kvalitou nebo množstvím; hranice uploadu nesmí vynutit hranici výrobní konfigurace.
72. `Objednat znovu` vždy vytvoří nový draft a smí převzít jen znovu použitelnou konfiguraci včetně výběru těles a přijaté `PrintConfigRevision` (výplň a další zákaznické toolpath volby), pokud jsou stále podporované. Musí použít aktuální `PriceList`, aktuální způsobilý `ReferenceProfile`, nový slice/quote a novou závaznou cenu; historický Quote, PriceListVersion, sleva, item price ani order total se nekopírují.
73. Zákaznický účet neprodlužuje 90denní zdrojovou retenci. Po smazání potřebného zdroje je automatické opakování zakázané, reklamační `ReproductionArtifact` se k němu nesmí znovu použít a nový draft smí pokračovat až po novém uploadu.
74. `min_print_price` a `small_order_surcharge` se vyhodnocují jednou nad celým Orderem, zatímco množstevní sleva a plate arrangement se vyhodnocují samostatně pro každý `OrderItem`; počty různých položek se pro item-level slevu nesčítají.
75. Shipment planning, přepravní kategorie a express eligibility pokrývají všechny `OrderItem` objednávky. Každý jednotlivý díl musí splnit limit kategorie, každá zásilka současně rozměrový i hmotnostní limit a express musí splnit celý order bez kombinace standardních a expresních položek.
76. Závazný `ShipmentPlan` smí vzniknout až po výběru jediného order-level `delivery_destination`; každá jeho parcela musí snapshotovat tentýž endpoint a kategorii kompatibilní s jeho provider capabilities. Background slice před touto volbou dává jen nezávazný mezisoučet a nesmí vytvořit `quoted` Order. Změna endpointu před platbou invaliduje plán i cenu a per-parcel destinace se v v0 nepodporuje.
77. Fázovaná v1 objednávka smí obsahovat jen `OrderItem` s `ordered_quantity ≥ 2` a pro každý musí immutable alokovat jeden sample slot a `ordered_quantity − 1` kladných batch slotů; fit se potvrzuje za celou sample sadu. `OrderRevision` smí nahradit jen batch sloty explicitních `affected_order_item_ids`; order-level policies přepočítá jednou z frozen sample allocations a celého revidovaného batch, zatímco zásilky a resource plan znovu vytvoří jen pro celý zbývající batch.
78. Parcel `volume_proxy` musí dělit součet ochranných `packing_part_bbox` objemů verzovaným `packing_fill_coefficient` a porovnat výsledek s verzovaným `shipping_category.max_parcel_volume_cm3`; realizovaný `packing_bbox` slouží samostatné rozměrové kontrole a nesmí být implicitním objemovým stropem.
79. Nadstandardní `postprocessing_i` je item-level čas pro celé množství daného `OrderItem` a fázi. Hlavní handling i `handling_pretisk` jej sčítají přes itemy právě jednou; globální order-level `postprocessing` ani další násobení počtem kusů mimo itemový odhad neexistuje.
80. Pre-quote packing musí identifikovat kus tuplem `(order_item_id, phase_kind, quantity_ordinal)` a pro každé vložení vybrat minimum úplného placement tuple; `FulfilmentSlot.id` vzniká až při atomickém finalizování quoted plánu a nesmí ovlivnit pořadí ani počet zásilek.

### 6.5 Švy pro síť

- **Node scope na každém dotazu na joby**, i když je uzel jediný a i když je makerské UI uvnitř administrace. Sloučení prezentace nesmí sklouznout ke sloučení datového přístupu.
- `Job` jako samostatná entita oddělená od `Order`.
- Profilová matice postavená pořádně i pro jeden stroj.
- Dvoufázový slicing implementovaný celý.
- `payout_amount` na jobu.
- Fotodokumentace vlastních tisků — korpus, ze kterého se později definuje přijatelný výsledek.

Až dorazí maker č. 2, přidá se tlačítko „přiřadit ručně" — jeden den práce.

---

# ČÁST III — ROZHRANÍ

## §7 Zákaznické rozhraní

### 7.1 Landing — dva vchody

| Vchod | Kdo | Kam |
|---|---|---|
| **Mám soubor** | STL / 3MF / STEP | konfigurátor |
| **Nemám soubor / potřebuji poradit** | fotka rozbitého dílu, rozměry | poptávka |

Nejsou to dvě větve jednoho trychtýře, jsou to dvě cílovky. Obsah: hodnotová věta (cena hned, platba hned, bez e-mailů), tři kroky, ceník „od X Kč/g", portfolio, dodací lhůta, důvěryhodnostní prvky.

### 7.2 Konfigurátor

**Krok 1 — nahrání.** Drag & drop. Okamžitě náhled, rozměry, seznam těles, hrubý odhad ceny, indikátor „počítám přesnou cenu". Zákazník může tělesa sdílející konfiguraci seskupit do jednoho `OrderItem` nebo je rozdělit do více položek; jeden `ModelFile` proto není automaticky jeden `OrderItem`.

**Krok 2 — parametry.** Pro každý `OrderItem` samostatně: materiál, barva, kvalita (návrhová / standardní / jemná), počet kusů. **Výplň není slider**, jen tři pojmenované stupně. Trysku, teploty, styl podpěr a orientaci nezobrazovat.

Plus jeden příznak: **„díl musí do něčeho zapadnout / má lícované rozměry"** — geometricky se to spolehlivě nedetekuje, tak se zeptej. Otevře cestu ke zkušebnímu kusu nebo do individuální nabídky.

**Krok 3 — nálezy preflightu.** Risk checkboxy (§7.5).

**Krok 4 — cena.** Transparentní rozpad: cena tisku, množstevní sleva, doprava, expres. Dokud zákazník nevybere společný delivery endpoint v prvním kroku checkoutu, doprava i celková částka jsou výslovně provizorní; teprve kompatibilní `ShipmentPlan` nad vybraným endpointem vydá závazný total. **Celková závazná částka je vizuálně dominantní, rozpad pod ní jako detail** — vedle konkurenta s „dopravou zdarma" vypadá rozpad opticky dráž.

**Tichá úniková cesta** k individuální nabídce jako odkaz, ne rovnocenné tlačítko. Kdyby byly stejně velké, značná část lidí zvolí konzultaci i bez potřeby. Cestu **povyšuje systém**, když preflight něco najde.

### 7.3 Barvy

**Zákazník sklad nikdy nevidí.** Paleta není globální sjednocení inventáře. Nejdřív se pro každou geometrii a konfiguraci plánovaného Jobu vyfiltrují stroje, které splňují build volume, materiál, aktivní `MachineProfile`, trysku, tier/certifikaci a cooldown. Reference slice zůstává jen vstupem zákaznické ceny. Každý kandidátní fyzický stroj a Job mají vlastní `CandidateResourceEstimate`: machine-specific arrangement jeho slotů a metriky slice s profilem a kalibrací určí `required_material_g`, počet podložek i délku intervalů včetně termínového bufferu. Menší nebo pomalejší stroj tedy nikdy nedědí gramáž ani kapacitu reference stroje.

`available_g` je fyzicky evidovaná gramáž kompatibilních zásob uzlu minus jejich aktivní rezervace; dostupná kapacita je kalendář stroje minus nekolidující aktivní `CapacityReservation`. U jednoho itemu je paleta sjednocení barev kandidátů, pro které lze umístit celý jeho machine-specific plán a platí `available_g ≥ required_material_g`. U více itemů zákazník volí barvu per `OrderItem` a systém musí najít alespoň jeden kompletní `PhaseResourcePlan`, který současně pokryje všechny jejich sloty — na jednom nebo více uzlech — bez dvojího použití zásoby či intervalu. Barva/kombinace bez úplného plánu se skryje a závazná cena nevznikne.

Výsledek ukládá do krátce platného `EligibilitySnapshot` alternativní kompletní `PhaseResourcePlan`; každý odkazuje již existující checkout-target `OrderPhase` a její immutable `required_fulfilment_slot_ids` a obsahuje pro každou plánovanou job group stabilní `planned_job_key`, ID `CandidateResourceEstimate`, `required_material_g`, konkrétní intervaly, stroj a pozorovanou dostupnost. Bezprostředně před capture se přepočítá **každý** odhad vybraného plánu. Jedna databázová transakce zamkne všechny dotčené phase/slot, zásobní a kalendářové řádky v deterministickém pořadí a vytvoří `PhaseReservationSet`: pro každý `planned_job_key` samostatnou `ProductionReservation` s `InventoryReservation` na jeho gramáž a `CapacityReservation` na jeho podložky. Teprve úspěch celé množiny povolí capture; jediný konflikt vrátí vše a žádný skutečný `Job` před capture nevznikne. Úspěšný potvrzovací webhook vytvoří právě jeden Job pro každý klíč a doplní jeho `job_id` do odpovídající rezervace; unikátnost `(phase_resource_plan_id, planned_job_key)` dělá retry idempotentní. Souběžný checkout proto nemůže utratit tutéž gramáž ani slíbit stejný interval podruhé.

`PhaseReservationSet` i každá jeho `ProductionReservation` mají společné `payment_reservation_expires_at = created_at + payment_reservation_minutes` po dobu nedokončené platby nebo nepřijaté revize: expirace krátké rezervace celou množinu atomicky uvolní, ale sama ještě nezavírá delší capture window. Webhook úspěšného capture ji smí přepnout na `held` jen pokud v téže transakci stále platí a všechny child rezervace vlastní oba své zdroje. Opožděný capture po expiraci krátké rezervace se smí idempotentně pokusit získat čerstvý kompletní phase plan a celý nový set jen pokud Payment má stále `capture_authorized = true`, u `full | deposit` platí `now < checkout_capture_expires_at`, u `balance` nevypršel jeho konkrétní balance/revision deadline a Order/revize/fáze nejsou stornované ani terminální. Při jediném neúspěchu objednávku/revizi nepotvrdí, nevytvoří žádný Job a zachycenou platbu okamžitě přepne do `refund_pending` s příslušnou plnou capture compensation; po `capture_cutoff_at`, confirmation timeoutu nebo jiném stornu je re-reserve vždy zakázaný. `CloseInitialCaptureWindow` je explicitní timeout/storno vlastník pro `full | deposit`; provider success po jeho cutoffu jde přímo do `initial_checkout_*` compensation popsané v §3.3. `Held` po platném capture nemá krátké checkout TTL, ale podléhá provoznímu deadline aktivní fáze. U fázované objednávky počáteční checkout rezervuje pouze celý existující sample plan; cenově zamčený batch získá vlastní set až atomicky při potvrzení fitu nebo přijetí revize. Přijetí každého Jobu přepne jeho gramáž na `allocated` a intervaly na `scheduled`, nikoli ještě na spotřebu; až `printing` commitne materiál k průběžnému vyúčtování. Pre-print failure uvolní jeho gramáž a nevyužitou kapacitu, in-print failure zapíše skutečnou spotřebu a vrátí zbytek, storno obdobně uvolní všechny nepoužité zdroje; povinnost dokončit ostatní sloty fáze zůstává. V v0 je množina strojů jediný vlastní stroj a úplný plán musí na jeho třech AMS a kalendáři pokrýt všechny itemy; s heterogenní sítí se nikdy nesmí nabízet kombinace, kterou kompletní phase plan nesplní.

### 7.4 Množstevní varianty

Cena za 1 / 5 / 20 kusů vedle sebe pro právě upravovaný `OrderItem`. Nejlevnější upsell — item-level handling a doprava se rozpustí. Počty různých položek se pro množstevní slevu nesčítají: kryt × 5 a víčko × 4 nejsou množstevní varianta 9 ks.

### 7.5 Risk checkboxy

**Nezaškrtnuté. Zákazník musí aktivně potvrdit, aby mohl pokračovat.** Předzaškrtnutý checkbox je slabší produktově (nikdo si ho nevšimne) i právně — a právě o ten argument při reklamaci jde.

**Maximálně tři najednou**, jinak se z toho stane zeď odklikaná naslepo a hodnota důkazu klesá. Když zákazník nepotvrdí, nabídne se přechod na poptávku.

U lícovaných dílů patří do textu i tohle: *„u dílů, které do sebe musí zapadnout, se běžně ladí rozměr v setinách milimetru podle konkrétní tiskárny — počítejte s jedním kolem úprav."* Nastavuje očekávání dřív, než vznikne spor.

### 7.6 Poptávkový formulář

Jedna obecná cesta pro vše, co konfigurátor neumí ocenit: díl nad build volume, lícované tolerance, nestandardní materiál, multicolor jednoho dílu, množství nebo hodnota nad strop, zákazník bez souboru.

Pole: popis, účel dílu, fotky (u překreslení ze tří stran s referenčním předmětem), rozměry, termín, kontakt.

**Závazek odpovědi do 24 h v pracovní dny** — tržní standard, ne diferenciace, a zároveň test vlastní kapacity.

**Konverzace běží e-mailem, ale záznam vzniká v systému.** Formulář vytvoří `QuoteRequest` se strukturovanými daty a přílohami; nabídka se vystaví ze systému přes tokenizovaný odkaz. Dostaneš tím záznam i převod na objednávku bez jediného řádku chatového rozhraní. Vlákno zpráv v portálu je až tehdy, když je poptávek dost.

### 7.7 Checkout

První krok checkoutu je widget Zásilkovny pro **výběr jednoho výdejního místa / Z-BOXu pro celý Order** (nikdy u makera). Teprve jeho provider ID, typ endpointu a capability snapshot omezí kompatibilní přepravní kategorie, vytvoří finální `ShipmentPlan` a zobrazí rekapitulaci s novou závaznou cenou. Změna endpointu před platbou starý plan/quote invaliduje; payment intent nesmí vzniknout, dokud zákazník znovu nepotvrdí aktuální total. Jeden Order v v0 nevybírá různé endpointy per parcel.

Následují fakturační údaje **bez povinné registrace**; souhlas s podmínkami a **výslovné potvrzení výjimky z odstoupení**; checkbox souhlasu se zveřejněním fotek; platba kartou i **bankovním tlačítkem**. V0 ani síť zatím nenabízí osobní odběr — vyžadoval by samostatný anonymizovaný předávací workflow, který není součástí scope.

### 7.8 Sledování

**Tokenizovaná URL v e-mailu, bez účtu.** Stav v lidské řeči, termín, **fotka hotového dílu s možností odsouhlasení před odesláním**, tracking, doklad.

Fotka jako zákaznický touchpoint není režie navíc — db3D to už dělá, takže je to očekávaná praxe.

### 7.9 Statické stránky

Ceník, jak to funguje, portfolio, kontakt, VOP, reklamační řád, zásady zpracování osobních údajů.

### 7.10 Historie a opakování objednávky

Volitelný účet v1 zobrazuje dlouhodobou historii obchodních dat objednávky. `Objednat znovu` ale nekopíruje historickou objednávku ani její cenu. Vytvoří nový rozpracovaný Order a z původních `OrderItem` převezme pouze znovu použitelnou konfiguraci:

- zdrojový model, pokud je stále dostupný,
- výběr těles,
- materiál,
- barvu, pokud je stále dostupná,
- kvalitu,
- přijatou `PrintConfigRevision` včetně pojmenované výplně a dalších znovu použitelných toolpath voleb, pokud jsou stále podporované,
- množství.

Nový draft vždy projde aktuálním pricing flow:

`aktuální PriceList → aktuální Profile → nový slice/quote → nová závazná cena`

Historický `Quote`, `PriceListVersion`, cena položky, sleva ani výsledná cena objednávky se nepřebírají. UI musí před potvrzením ukázat novou závaznou cenu; rozdíl proti historické ceně není chyba ani `PriceAdjustment`, ale cena nové objednávky podle aktuálních podmínek.

Akce je dostupná jen při existenci všech potřebných zdrojových artefaktů. Po vypršení retence objednávka v historii zůstává, ale UI místo automatické kopie nabídne například:

> Původní výrobní soubor už neuchováváme. Nahraj ho znovu a předchozí konfiguraci doplníme za tebe.

V první verzi účtu se standardní retence kvůli účtu neprodlužuje. Dlouhodobá archivace výrobních souborů zůstává samostatným budoucím rozhodnutím.

---

## §8 Makerské funkce

### 8.0 Logicky ano, fyzicky ne

Makerské rozhraní je **soubor funkcí uvnitř administrace, ne samostatná aplikace.** Dokud je uzel jediný, samostatný portál je práce bez uživatele.

Oddělené zůstávají: entity `Node` / `Job` / `Machine` / `Inventory`, **node scope na každém dotazu**, a logické seskupení obrazovek jako „provoz uzlu", aby šly vyříznout jedním řezem. **Oddělení `/maker` nastane s prvním externím uzlem** — tehdy je to přesun obrazovek, ne přepis datové vrstvy.

### 8.1 Přehled a detail jobu

Seznam podle stavu; karta jobu s náhledem, materiálem, odhadem času, termínem a stavem. Detail: náhled, rozměry, gramáž, počet podložek, **stažení G-code** (podepsaná URL s krátkou platností), poznámky včetně akceptovaných rizik zákazníka, akce podle stavu.

**Vedle výplaty vždy zobraz čas.** 150 Kč za dvouhodinový job je 75 Kč/h, stejných 150 Kč za desetihodinový je 15 Kč/h. Maker, který vidí jen absolutní číslo, špatné zakázky vezme, odtiskne je a **až pak** si spočítá, že to nedávalo smysl — projeví se to poklesem acceptance rate a kvality.

### 8.2 Makerská kalkulačka (jen síť)

Maker zadá vlastní náklady (filament bez slevy, jiný tarif) a vidí **svou výplatu a odvozené Kč/h**. Nikdy nevidí, kolik zaplatil zákazník — pro jeho rozhodnutí je to irelevantní.

**Nákladové vstupy předvyplň platformními průměry.** Když je maker musí vyplnit, aby kalkulačka něco ukázala, nevyplní je nikdo a obrazovka je mrtvá.

Podmínka: **je čistě poradní a jednosměrná** (invariant §6.4 bod 8).

### 8.3 Stroje, inventář, kapacita

Registrace **schopnosti**, ne profilu. Kalibrační overridy konkrétního kusu.

Kalibrační overridy se nikdy nepřepisují na místě. Uložení vytvoří novou `MachineCalibration`; rozpracované a historické joby zůstávají na své verzi. Už `CandidateResourceEstimate` a navazující `ProductionReservation` snapshotují konkrétní `machine_profile_revision_id`, `machine_calibration_revision_id` a `print_config_revision_id`. Přijetí jobu tyto ID **kopíruje z rezervace**, nikdy z právě aktivního nastavení stroje, takže produkční G-code používá stejné vstupy jako rezervované gramy a intervaly. Tatáž transakce vytvoří draft `ReproductionArtifactVersion` pro tento job; `gcode_ready` ji doplní production výsledkem a uzamkne. Dřívější odmítnutý/přesměrovaný kandidát verzi vytvořit nemůže.

Pokud se před přijetím musí použít novější aktivní kalibrace, systém nejdřív vytvoří nový candidate odhad a atomicky nahradí materiálovou i kapacitní rezervaci; teprve pak lze job přijmout. Když novou rezervaci nelze získat, job se nepřijme a pokračuje routing/escalation path.

**Inventář je zdroj palety, kterou vidí zákazník** — musí být rychlý na údržbu, přepnutí cívky pár kliknutí. Jinak se přestane aktualizovat a paleta začne lhát.

Kapacita: plánované okno tisku, pauza, max souběžných jobů. **Vstup pro kapacitní bránu expresu.**

### 8.4 Fotodokumentace

Povinná, blokuje přechod stavu: díl na loži po dotisku; díl po odstranění podpěr na milimetrovém papíře nebo s referenčním předmětem; u přesných dílů naměřený kritický rozměr.

### 8.5 Štítek a podání

Generuje platforma, maker balí a podává — drží se tracking a maker nevidí adresu nad rámec štítku.

**Podání přes Z-BOX**: od 1. 7. 2026 otevřela Zásilkovna podání přes Z-BOXy všem českým e-shopům a zrušila příplatek za podání mimo depo; přes 6 500 boxů. Pro síť je to zásadní — odpadá nutnost stihnout obsluhované místo v otevírací době. U lidí, kteří tisknou po večerech, je to hlavní snížení tření.

---

## §9 Administrace

> **Stavový automat je pevný, konfigurovatelné jsou politiky.** Obecný workflow engine s překreslitelnými přechody stojí násobek práce, nikdy se nepoužije jinak než jedním způsobem a znemožní typovou kontrolu. Konfigurují se **prahy, brány, blokujícnost kroků a notifikace** — ne topologie.

**V v0 stačí:** seznam objednávek, detail, ruční změna stavu, fronta poptávek.

### 9.1 Provozní přehled

Dnešní objednávky, poptávky s odpočtem do 24h lhůty, joby po termínu, fronta tisku v hodinách, **obrat proti limitu DPH**.

### 9.2 Objednávky

Seznam s filtrem. Detail: položky, ceny s odkazem na verzi ceníku, slice výsledky, preflight nálezy a co zákazník akceptoval, platby, zásilky, reklamace, časová osa.

Ruční zásahy: změna stavu, storno a vrácení, přepsání ceny (**s povinným důvodem do auditu**), přeposlání e-mailů.

### 9.3 Poptávky a nabídky

Fronta s SLA odpočtem. Tvorba nabídky: položky, ceny, termín, platnost → tokenizovaný odkaz zákazníkovi.

### 9.4 Katalog strojů a profily

Tři oddělené katalogy: `ReferenceProfile` pro `(materiál × kvalita)` bez stroje, `MachineCapability` pro statické schopnosti modelů a `MachineProfile` pro `(model × tryska × materiál × kvalita)`. Referenční a strojové profily mají vlastní verze, changelog a stav.

**Testovací slice přímo v administraci:** nahrát referenční model, zvolit quote nebo production režim, spustit proti odpovídajícímu typu profilu a porovnat s jeho předchozí verzí. Bez toho se profily neladí, jen hádají.

**Aktivace nové verze `ReferenceProfile` spustí upozornění na přepočet ceníku.** Aktivace `MachineProfile` mění jen budoucí produkční G-code a zákaznickou cenu nepřepočítává.

### 9.5 Ceník a nákladový model

**Dvě oddělené vrstvy.**

*Nákladový model — dynamický.* Vstupy `CostInput`: nákupy filamentu, sazba energie, spotřební materiál, kapitálová hodnota strojů. Z toho se počítá aktuální podlaha.

*Ceník — verzovaný, měněný vědomě.* Přecenění je rozhodnutí, ne automatický důsledek. **Levnější filament neznamená nižší cenu, ale vyšší marži** — cena sleduje trh, ne tvoje náklady.

*Mezi nimi **drift alert***: „v ceníku máš materiál za 0,50 Kč/g, vážený průměr posledních nákupů je 0,62; marže klesla o 4 procentní body." Nad prahem zavolá o pozornost, ale nepřecení nic samo.

### 9.6 Meze automatu

Konfigurace bran + **zobrazený podíl souborů, které projdou automatem**. Klíčová metrika patří přímo sem, vedle páček, kterými se ovlivňuje.

### 9.7 Ostatní

Materiály a barvy (číselník, zdroj palety); uzly a stroje; doprava (kategorie, sazby, rezerva, zaokrouhlování, Packeta API); zákazníci s **podílem opakovaných objednávek**; obsah (statické stránky, texty varování, e-mailové šablony, verzované VOP); audit log.

### 9.8 Metriky

**Trychtýř po krocích** — jinak výsledek řekne jen „nefunguje to" a ne co:

```
imprese → prokliky → nahrané soubory → zobrazené ceny
        → vložení do košíku → zaplacené objednávky
```

Prokliky v pořádku a nahrání nula → landing. Nahrání v pořádku a objednávky nula → cena nebo důvěra.

**Konverze quote → paid podle cenového pásma:**

```
250–499 Kč:    ? %
500–999 Kč:    ? %
1 000–1 999:   ? %
2 000+ Kč:     ? %
```

Určuje `min_order`, práh dopravy zdarma, **hodnotový strop automatu**, a hlavně odpovídá, jestli prémie za bezbariérovost skutečně funguje, nebo jestli lidé nad určitou částkou začnou porovnávat.

**Konverze quote → paid podle stavu preflightu** (čistý vs. s varováními) — řekne, jestli risk checkboxy konverzi zabíjejí.

**Ekonomika:** contribution margin per objednávka; **CAC per kanál, odděleně od CM**; `capital_replacement_cost` jako stínová položka (vstup do §11); **atribuce kanálu na každé objednávce od první objednávky**; průměrná hodnota objednávky; podíl automat vs. individuální; podíl expresů; first-pass yield; obrat proti limitu DPH.

---

## §10 Architektura

```
web (Vue 3 + TS) ────┐
administrace ────────┼──► api (Node + TS) ──► PostgreSQL
                     │          │              Redis (BullMQ)
(/maker až se sítí) ─┘          │              S3 (zdrojové modely, gcode, fotky)
                                ├──► slicer-worker (Docker + OrcaSlicer CLI)
                                ├──► carrier adapter (Packeta)      [v1]
                                ├──► ai-worker                [post-validation]
                                └──► routing-worker                 [síť]
```

- **Node + TypeScript**, **PostgreSQL** (stavové automaty, konzistence peněz), **BullMQ** (slicing je dlouhá úloha)
- **Slicer worker odděleně a on-demand** — jiný scale profil (CPU-bound), jiný lifecycle (verzovaná image), a v hobby režimu nesmí běžet trvale
- **S3-compatible** — všechny zdrojové `ModelFile` (STL, 3MF i STEP) se mažou podle společného `source_delete_after`; customer/QC `PhotoAsset` včetně thumbnails, transformací a EXIF podle `photo_delete_after`; minimální `ReproductionArtifact` přijaté objednávky zůstává nejméně do `claim_until`; G-code se maže po dokončení jobu
- **Multi-tenancy od prvního dne** (§6.5)
- **Vyměnitelné adaptéry** za jedno rozhraní: platební brána, dopravce, AI poskytovatel
- **Privacy:** maker vidí minimum; žádné trackery nad rámec nutného měření reklamy; retenční politika je součástí podmínek, ne interní poznámka

---

# ČÁST IV — BRÁNA A SÍŤ

## §11 Brána: potřebujeme vůbec síť?

### 11.1 Přerámování

**Síť není produktový milestone. Je to jedno z možných řešení kapacitního problému.** Pokud vlastní uzel kapacitní problém nemá, síť se nestaví.

### 11.2 Spouštěč — musí platit obojí

1. **poptávka trvale přesahuje kapacitu** vlastního uzlu (fronta se prodlužuje, termíny se posouvají, expres je trvale nedostupný), a
2. **jednotková ekonomika je zdravá** — CM po odečtení CAC je kladná a **cena uživí plnou amortizaci nového stroje**

Bod 2 je zásadní: **pokud cena neuživí amortizaci nového stroje, nepomůže ani síť.** Makerovy stroje se také musí zaplatit. Síť by ten problém jen schovala do cizího utopeného nákladu a vydržel by přesně do chvíle, než si maker spočítá hodinovou sazbu a odejde.

### 11.3 Varianty

| Varianta | Náklad | Pro | Proti |
|---|---|---|---|
| **Další vlastní stroj** | kapitál | nulová variance kvality, žádná právní složitost, žádné výplaty ani routing | váže kapitál, hůř absorbuje krátké špičky |
| **Síť externích makerů** | měsíce vývoje + trvalý provoz | škáluje bez kapitálu platformy, elastická kapacita | variance kvality, IČO a smlouvy, výplaty, routing, disintermediace, FPY jako trvalé riziko |
| **Outsourcing na existující farmu** | žádný vývoj | okamžité, bez kvalitativního rizika | nízká marže, závislost, můžou tě obejít |

**Výchozí předpoklad je koupit druhý stroj.** Síť musí prokázat, že řeší něco, co druhý stroj neřeší — realisticky **kapitálovou nenáročnost platformy** nebo špičky, pro které by další vlastní stroj většinu času stál. Geografická blízkost sama nic nešetří: v navrženém checkoutu jde každá zásilka přes dopravce a zákazník s makerem kvůli privacy hranici nekomunikuje.

```
Brána §11
 ├─ kapacitní problém + zdravá ekonomika + chybějící kapitál / krátké špičky → síť (§11.4+)
 ├─ kapacitní problém + zdravá ekonomika, stabilní vytížení a kapitál        → druhý stroj
 ├─ kapacitní problém + nezdravá ekonomika                                   → přecenit, ne škálovat
 └─ žádný kapacitní problém                                                  → nic; provoz beze změny
```

### 11.4 Onboarding a certifikace

Kalibrační sada: **rozměrový test** (kostka + díl s dírami Ø 5/10/20 mm, maker měří posuvkou → z hodnot se odvodí `xy_*_compensation`), **test převisů a mostů**, **test tolerance sesazení**. Neprojde = není v síti, bez výjimek.

**Certifikace je zdarma a bez toku peněz.** Většina psychologické bariéry není „chci si nejdřív vydělat", ale „nevím, jestli jsem dost dobrý".

Nejsilnější argument pro povinnou certifikaci: **zákaznické modely nesou skrytou kompenzaci cizí tiskárny** (§3.4). Tentýž model vyjde na každém uzlu jinak, pokud uzly nejsou kalibrované ke stejnému nominálu.

### 11.5 Whitelist strojů

Bambu P1S, X1C, H2S, H2D; Prusa MK4, MK4S, Core One. Materiály **PLA a PETG**.

Heterogenita je nepřítel číslo jedna — každý přidaný model je nový řádek v profilové matici a nový zdroj rozptylu.

### 11.6 Tiery a skóre

| Tier | Kritérium |
|---|---|
| **A** | certifikace bez odchylky, FPY ≥ 97 %, ≥ 20 jobů |
| **B** | certifikace prošla, FPY ≥ 92 % |
| **C** | nový uzel, prvních 10 jobů — nekritické díly, dvojitá fotokontrola |

```
score = 0.45 × first_pass_yield + 0.25 × on_time_rate
      + 0.20 × acceptance_rate  + 0.10 × response_time_score
```
Klouzavé okno 30 jobů. Nový uzel postupuje **výkonem, ne časem**.

### 11.7 Routing

**Filtr způsobilosti musí proběhnout dřív, než vznikne paleta a závazná cena, znovu před capture platby a nakonec předtím, než job komukoli blikne.** Všechny tři kroky používají stejný verzovaný predikát, ale gramáž, počet podložek a intervaly berou z `CandidateResourceEstimate` konkrétního Jobu a stroje: build volume ≥ bbox + rezerva; aktivní `MachineProfile`; nasazený materiál a barva; candidate `available_g ≥ required_material_g` po odečtení aktivních rezervací; typ trysky odpovídá materiálu; tier/certifikace ≥ požadavek objednávky; nekolidující candidate intervaly; není v cooldownu. Před capture musí `PhaseResourcePlan` pokrýt všechny sloty a jeho `PhaseReservationSet` atomicky rezervovat materiál i kapacitu všech vybraných Jobů/uzlů; nabídku konkrétního Jobu smí vidět jen držitel jeho child `ProductionReservation`.

Při odmítnutí nebo timeoutu vznikne pro další stroj čerstvý machine-specific odhad. Jedna transakce na něm rezervuje **jeho** gramáž a intervaly a teprve po úspěchu uvolní předchozí skupinu; hodnoty se mezi různými stroji nekopírují. Až potom se odešle další nabídka. Pokud přesun není možný, job se nikomu nezobrazí a spustí se provozní eskalace/refundace.

```
Vlna 1 (0–15 min):   nejvýše skórovaný způsobilý držitel rezervace   payout ×1.00
Vlna 2 (15–45 min):  další způsobilý tier A/B po přesunu rezervace   payout ×1.08
Vlna 3 (45–120 min): další způsobilý uzel po přesunu rezervace       payout ×1.15
```

*Tato čísla nelze navrhnout dopředu — bez reálných makerů by se psala z fantazie a po třetím uzlu přepisovala. Výchozí odhad k okamžité revizi.*

**Rezerva termínu:** odhad tisku + buffer + doprava. **Anti-cherry-picking:** `acceptance_rate` je součást skóre. **Vlastní kapacita se neupřednostňuje** a slouží jen jako eskalace poslední instance.

### 11.8 Výplaty a reklamace

Brána na vstupu, **měsíční samofakturace** na výstupu. Zádržné se standardně
uvolní po `delivered` + reklamační okno. Pokud zásilka po ověřeném předání
dopravci není doručena a incident skončí konečným non-maker-caused
refund/replacement rozhodnutím, odvodí se payout eligibility místo toho z
`incident_resolved_at`; makerovi zůstává plná accepted compensation. Případ
před handoffem, neuzavřený incident ani maker-caused výsledek tuto cestu
nesmí použít.

Po aktivaci maker modelu zapisuje acceptance transakce externího maker-owned
assignmentu
`Job.(payout_amount, payout_currency) = MakerCompensationSnapshot.(agreed_compensation, currency)`;
offer, routing i settlement proto používají tutéž immutable částku a měnu.
Platform-owned fallback žádný maker assignment, snapshot ani settlement
nevytváří. Maker
hold se odvozuje z reklamační policy snapshotované zákazníkem při přijetí
Orderu a `payout_eligible_at` nesmí předcházet žádnému `claim_until` slotu
plněného assignmentem. Uplynutí okna samo nestačí, pokud se assignmentu
dotýká neuzavřený claim nebo legal hold: settlement čeká na jejich ukončení a
maker-caused výsledek zahrne až se schválenou adjustment.

Po vystavení self-billing dokladu běží uložené
`maker_settlement_dispute_days` (aktuálně ⚠ 5 kalendářních dní). Bez sporu
přejde settlement z `issued` do `payable` explicitním potvrzením makera nebo
idempotentně po deadline; spor otevřený před touto tranzicí má přednost.
Payout smí vzniknout jen nad `payable` settlementem a jeho aktivním `issued`
dokladem. Otevření sporu pod stejným zámkem vyžaduje autoritativní serverové
`opened_at <= dispute_deadline_at` a maker ID vlastníka settlementu; opožděný
worker tedy neprodlouží okno a cizí maker nemůže settlement zablokovat.

Replacement settlement po uznaném sporu zachovává makera a měnu superseded
settlementu a jako immutable `origin_dispute_id` ukládá spor, který právě
tento settlement a doklad napadl. Jeho correcting self-billing doklad musí
kompozitně odkazovat stejný origin spor a právě doklad tohoto superseded
settlementu; nezávislé propojení s jiným settlementem je zakázané. Pokud je
napaden i replacement, vzniká nový dispute a další replacement článek;
origin předchozího článku se nikdy nepřepisuje.

Ruční bankovní převod smí začít až po lokálně commitnutém přechodu
`MakerPayout.created | failed → initiated` s `initiated_at` a novým audit-stable
attemptem; externí příkaz používá stabilní parent idempotency key. Dispute
acceptance zamyká stejný payout a smí voidnout settlement jen bez payoutu nebo
pro `created | failed`, který zároveň zruší. Stav `initiated | paid`
pre-payout correction odmítne a vyžaduje samostatnou reconciliation; timeout
zůstává `initiated`, dokud banka autoritativně nepotvrdí, že peníze neodešly.
Teprve `failed_no_transfer` dovolí na stejném payout řádku nový
`failed → initiated` attempt se stejným klíčem. Úspěšné bankovní potvrzení v
jedné transakci přepne payout, jeho settlement i self-billing doklad do `paid`
a uloží jednu unikátní bankovní referenci; opakování stejné události je
idempotentní.

- **zavinění uzlu** → uzel nese materiál, platforma dopravu a přetisk
- **nezaviněné** (vada modelu zákazníka, nereálná tolerance) → uzel dostane zaplaceno v plné výši

Poslední bod je zásadní. Pokud maker nese riziko špatného zadání, síť se rozpadne.

### 11.9 Node agent

Až když je ruční provoz úzkým hrdlem a uzlů je přes deset. Bambu LAN (FTP + MQTT), PrusaLink, Moonraker, OctoPrint.

Architekturně tentýž problém jako FastyBird — discovery, stavový automat, telemetrie přes MQTT.

**Bezpečnost:** odchozí spojení, žádné otevírání portů; agent nedostane údaje o zákazníkovi; G-code přes podepsanou URL, po dotisku se maže; **tisk se spouští až po potvrzení makerem u stroje**, nikdy autonomně.

### 11.10 Multicolor

**Různé díly v různých barvách** — levné, bez odpadového problému, jen `OrderItem.color`. **Lze i v v1.**

**Vícebarevný jeden díl** — zákazník musí dodat přiřazení barev (holý STL to nenese); AMS proplachuje a u dvoubarevného dílu skončí 30–50 % materiálu v purge věži; **odpad je funkcí stroje, ne modelu** (jednonozzlové AMS vs. dual nozzle vs. IDEX se liší násobně), což bez nového modelu rozbíjí invarianty deterministické zákaznické ceny nezávislé na makerovi (§6.4 body 8–9).

Řešení: **custom request** do té doby; v v0/v1 parser paint/material metadata detekuje jako blocking preflight a nesmí je potichu zahodit. Později **nestavět malovátko, přijmout 3MF s paint daty**, ale až s machine-specific cenou purge a rezervací všech barev — OrcaSlicer CLI ho umí slicnout přímo. Dny, ne měsíce.

### 11.11 Tisk z materiálu zákazníka

Řeší problém „barva na objednávku" — nikdo nemusí kupovat celou cívku. Trh to nabízí za sníženou sazbu s vyloučením odpovědnosti při selhání kvůli kvalitě cizího filamentu.

---

# ČÁST V — ROADMAPA A OTEVŘENÉ POLOŽKY

## §12 Roadmapa spouštěči

Žádné termíny. Datum ve firmě o jednom člověku s kolísavou kapacitou nikdy nesedí a nutí ho posouvat.

| Co | Spouštěč |
|---|---|
| **Kampaň** | shakedown proběhl, flow funguje od konce do konce |
| **v1 — produkční flow v systému** | v0 splnila kritéria §2.3 |
| **Fázovaná objednávka se zkušebním kusem** | příznak lícovaných rozměrů se objevuje u >20 % poptávek |
| **`ai-worker` — triáž poptávek** | individuální poptávky zabírají > 2 h týdně |
| **Vlákno zpráv v portálu** | poptávek je tolik, že se e-mail přestane zvládat |
| **Multicolor jednoho dílu** | opakovaná poptávka v individuálních nabídkách |
| **Oddělení `/maker`** | první externí uzel |
| **Maker settlement, měsíční samofakturace a ruční výplaty** | první externí uzel |
| **Certifikace a tiery** | druhý až třetí externí uzel |
| **Nabídkové vlny (routing)** | ruční přiřazování přestane stačit, ~5 uzlů |
| **Node agent** | ruční provoz je úzké hrdlo, > 10 uzlů |
| **Druhý vlastní stroj** | brána §11 |
| **Přechod na plátcovství DPH** | obrat se blíží limitu, nebo cílení na B2B |

## §13 Otevřené položky

### 13.1 Blokující

**Název a clearance.** Taven jako finalista, Taviro záloha. Nutné projít **všemi čtyřmi** kroky:

1. žádný **český** subjekt ve 3D tisku, makerství nebo výrobě se stejnou první slabikou
2. **ÚPV a EUIPO, třídy 40 a 42** (a adjacentně 35, 7, 20) — hledat i s divokými kartami `tav*`, `*aven` a fonetické sousedy (Tavena, Taveno, Tavan). Zaměnitelnost se posuzuje podle celkového dojmu, ne shody znak po znaku. **TMview** pokryje ÚPV, EUIPO i mezinárodní známky jedním dotazem
3. volná `.cz` a handles, registrované najednou
4. test po telefonu

Pokud projde: registrovat doménu a **zvážit přihlášku známky** — chystáš se do toho jména sypat SEO a bez zapsané známky ji může někdo přihlásit po tobě.

**Strop reklamního spendu.** Stanovit **předem**, jinak je kritérium bezzubé. Zpětně se to nedá určit bez zaujatosti.

### 13.2 Čísla

Viz `taven-parametry.md`, položky označené ⚠. Nejdůležitější zbývající: `handling_piece`, zbytek opotřebení, marže, ceny modelářských služeb, platební brána.

### 13.3 Zodpoví až provoz

- **Jaký podíl zákazníků se vrací?** Hlavní otázka **škálovatelné placené akvizice** (§2.3) — při CM kolem 110 Kč se placená akvizice zaplatí jedině opakovaným nákupem. Není to hlavní otázka projektu: stroj se může rozumně vytěžovat i při nízké opakovanosti, pokud většina poptávky přijde organicky.
- **Jaký podíl souborů projde na automat?**
- **Konverze quote → paid po cenových pásmech.**
- **Má vlastní uzel kapacitní problém?** Vstup do brány §11.
- **Objem trhu.** Dvacet firem na trhu může znamenat, že je snadné do něj vstoupit a těžké v něm vydělat.

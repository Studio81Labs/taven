# Taven — parametry

**Frekvence změn:** týdně, bez ceremonie.
**Pravidlo:** změna čísla v této tabulce nevyžaduje zápis do rozhodovacího logu. Změna *struktury* výpočtu ano.
**Aktualizováno:** 2026-08-24

> Hodnoty označené ⚠ jsou dosud neověřené odhady. Hodnoty označené ✓ vycházejí z vlastního měření nebo z tržní rešerše.

---

## 1. Materiál

| Materiál | Nákupní cena | Kč/g | Zdroj |
|---|---|---|---|
| PLA | 299–499 Kč/kg | **0,30–0,50** | ✓ vlastní nákup |
| PETG | 479–499 Kč/kg | **0,48–0,50** | ✓ |
| ABS | 479–499 Kč/kg | **0,48–0,50** | ✓ |
| ASA | 599 Kč/kg | **0,60** | ✓ |

Do ceníku vstupuje **vážený průměr posledních nákupů**, ne aktuální cena. Skutečná spotřeba se účtuje proti konkrétní cívce (`Inventory.price_per_g`).

Každá zásoba eviduje fyzicky ověřené `remaining_g`; pro nabídku se používá `available_g = remaining_g − aktivní InventoryReservation`. Závazný reference slice určuje jen zákaznickou cenu. Pro každý plánovaný Job/parcel group každého itemu počítá `CandidateResourceEstimate` z profilu, kalibrace a arrangementu kandidátního stroje vlastní `required_material_g`, podložky a intervaly včetně termínového bufferu. Capture platby smí začít až po atomickém `PhaseReservationSet`, který společnými `ProductionReservation` pokryje gramáž a nekolidující kapacitu **všech** itemů/slotů právě aktivované fáze; u fázované objednávky se stejné pravidlo čerstvě zopakuje pro celý sample plán, aktivaci batch i revizi. Přetisk jednoho selhaného Jobu získá novou per-Job `ProductionReservation`, zatímco claim zasahující více slotů smí vytvořit náhradní Joby jen přes all-or-none `ReplacementReservationSet` celé reklamované množiny.

**V0 nabízené materiály:** PLA, PETG.

---

## 2. Provoz stroje

| Položka | Hodnota | Zdroj |
|---|---|---|
| Průměrný příkon (PLA/PETG) | 0,21–0,30 kW | ✓ vlastní měření |
| Cena elektřiny | ⚠ 5 Kč/kWh | odhad, nezjištěno |
| **Elektřina** | **1,5 Kč/h** | ✓ |
| **Tryska** (tvrzená, PLA/PETG) | **1,25 Kč/h** | ✓ 1 250 Kč / 1 000 h |
| Zbytek opotřebení (podložky, hotend, AMS, pásky) | ⚠ 2 Kč/h | odhad |
| **`sazba_stroj_h` celkem** | **~5 Kč/h** | |

**Trysky — životnost a cena**

| Tryska | Cena | PLA/PETG | Abrazivní |
|---|---|---|---|
| Mosazná | 500 Kč | 500 h → 1,00 Kč/h | 100 h → 5,00 Kč/h |
| High-flow tvrzená | 1 250 Kč | 1 000 h → 1,25 Kč/h | 500 h → 2,50 Kč/h |
| Carbid | 1 500 Kč | 1 000 h → 1,50 Kč/h | 500 h → 3,00 Kč/h |

---

## 3. Amortizace

Vzorec: `cena stroje / požadovaná doba návratnosti v hodinách`

| Parametr | Hodnota | Poznámka |
|---|---|---|
| Cena H2S + 3× AMS | ⚠ ~50 000 Kč | doplnit |
| **Doba návratnosti — v0 a hobby režim** | **∞ → 0 Kč/h** | stroj je pořízený pro vlastní projekty, náklad je utopený |
| Doba návratnosti — rozhodování o 2. stroji | dle §11 | vstup do brány, ne do ceny |
| **`capital_replacement_cost`** | ⚠ dopočítat | stínová metrika, sleduje se v §8.13 |

---

## 4. Práce

| Parametr | Hodnota | Zdroj |
|---|---|---|
| **`sazba_prace_h`** | **300 Kč/h** | ✓ operátorská pozice, benchmark „co by stál brigádník" |
| Handling celkem — běžný malý tisk | **~30 min** | ✓ hrubý odhad z vlastního provozu |

**Rozklad handlingu.** Těch 30 minut směšuje aktivní práci na objednávce s logistickou cestou a s prací na podložku. Struktura musí být správná **před** měřením — jinak po dvaceti objednávkách zjistíš „handling 23 minut" a nebudeš vědět, co z toho jde batchovat a co automatizovat.

| Komponenta | Škáluje s | Batchovatelné | Hodnota |
|---|---|---|---|
| `handling_order_fix` | objednávka | ne | ⚠ stažení, kontrola, administrativa |
| `handling_plate` | podložka | částečně | ⚠ nahrání, výměna špulky, start, sejmutí |
| `handling_piece` | kus | ne | ⚠ začištění, kontrola, třídění |
| `handling_pack` | zásilka | ne | ⚠ balení, štítek |
| `shipping_trip` | **cesta**, ne zásilka | **ano** | ⚠ cesta k Z-BOXu |
| **`shipping_trip_pricing_divisor`** | závazná cena | — | **1 v v0/hobby**; verzovaný očekávaný počet zásilek na cestu |
| `postprocessing` | zakázka | ne | ⚠ nad rámec začištění; jinak 0 |

**Pozor na `shipping_trip` při nízkém objemu.** Do závazné ceny vstupuje jen verzovaný `shipping_trip_pricing_divisor`; při 1–2 objednávkách měsíčně je 1, tedy **plný náklad, nikoli domnělá budoucí alokace**. Skutečný počet zásilek sdílejících cestu se zapisuje až do `HandlingSession` pro realizovanou CM. Divisor ceníku lze zvýšit teprve podle naměřených cest od několika zásilek týdně a nikdy se zpětně nepřepočítává do přijatých nabídek.

Stavový automat měří průchod zakázky a SLA, **ne aktivní práci** — intervaly mezi stavy obsahují tisk, frontu, čekání na zákazníka i dopravu. Handling se měří přes explicitní `HandlingSession` s komponentou, začátkem/koncem a počtem obsloužených podložek, kusů nebo zásilek. Administrace používá start/stop časovač; kde není praktický (zejména `shipping_trip`), zapíše se strukturovaně přímo naměřená délka se zdrojem `manual`. Pro CM se nikdy neodvozuje aktivní práce z pouhého rozdílu stavových časových značek.

---

## 5. Zmetkovitost

| Parametr | Hodnota | Poznámka |
|---|---|---|
| Vlastní historická zmetkovitost tisku | ✓ nízká | jeden případ, zachycen po pár gramech |
| **`mira_zmetku`** | **⚠ 5 %** | konzervativně; skutečný FPY služby zahrnuje i akceptační selhání, která zatím nemáš změřená |

**Báze výpočtu je závazná:**

```
handling_pretisk = sazba_prace_h × (
                    handling_plate × podložek
                  + handling_piece × qty       (degresivní)
                  + postprocessing )
rezerva_pretisk = mira_zmetku × (
                    material + machine + handling_pretisk + amortizace )
```

`handling_pretisk` je už peněžní částka a používá stejné násobnosti podložek a kusů jako hlavní handling. Bez `handling_order_fix`, `handling_pack` a `shipping_trip` — ty se při přetisku chyceném doma neopakují. `amortizace` kryje opakované čerpání životnosti stroje a při návratnosti ∞ je nula. **Odmítnutí po doručení tím kryté není** (stojí navíc dopravu a balení oběma směry) a sedí zatím v marži.

---

## 6. Doprava, obal, brána

| Parametr | Hodnota |
|---|---|
| Doprava — výdejní místo / Z-BOX | ⚠ ~85 Kč hrubých (neplátce si neodečte) |
| Obalový materiál | ⚠ 15 Kč |
| Poplatek brány | ⚠ ~9 Kč (1,5 % + 3 Kč) |
| Obalová rezerva k bboxu | +4 cm na stranu |
| Koeficient plnění krabice | 0,55–0,65 |
| Hmotnost obalu | 150–250 g |

U fázované objednávky se doprava, obal a `handling_pack` počítají pro každou plánovanou zásilku zvlášť; sample a batch se neposílají současně a nelze je sloučit do jedné sazby. Práh dopravy zdarma se vyhodnotí jednou nad `cena_tisku_pred_subvenci` a případně nuluje zákaznický součet dopravy, nikoli skutečné náklady v CM. Neúčtovaná část skutečného nákladu dopravce vstupuje do nákladové báze před marží a checkout se hrubuje o součet poplatků všech capture v `PaymentSchedule`; individuální `deposit` + `balance` proto nesou fixní složku dvakrát.

`ShipmentPlan` počítá celé množství, ne jen největší díl: potřebný objem je `Σ(bbox_volume × qty) / koeficient_plnění_krabice`, hmotnost zahrnuje materiál všech kusů a obal. Překročení objemu nebo hmotnosti vytvoří další plánovanou zásilku a tím další sazbu dopravy, obal i balicí handling.

**Limity přepravních kategorií**

| Kategorie | Limity |
|---|---|
| Z-BOX | max 60 × 43 × 35 cm, do 15 kg |
| Výdejní místo | nejdelší strana ≤ 60 cm, součet ≤ 120 cm, do 5 kg |
| Nadrozměrná | součet ≤ 150 cm, nejdelší ≤ 120 cm; do Z-BOXu nelze |

---

## 7. Ceník a prahy

| Parametr | Hodnota | Poznámka |
|---|---|---|
| `marže` | ⚠ dopočítat proti stropu | |
| **`min_print_price`** | **250 Kč** | ✓ trh: alvipek 200, M3Dtisk 250 |
| **`small_order_surcharge`** | **50 Kč** u zakázek do 100 g | ✓ trh: studio3dtisk |
| **`prah_doprava_zdarma`** | **⚠ 1 000 Kč** | start; revize po 50 objednávkách. Počítá se z `cena_tisku_pred_subvenci` před dotovanou dopravou, bránou a expresním příplatkem |
| **`koef_express`** | **×2,0** | ✓ trh: Bakuralab +100 %; jen Order s jedinou `OrderPhase(kind = single)`, nikdy sample/batch |
| Výplň | 10 / 20 / 40 % | dekorativní / běžná / pevná |

**`min_print_price` se vztahuje na `cena_tisku`, ne na částku u pokladny.** Bez tohoto rozlišení bude někdo za rok číst „minimální objednávka 250 Kč" jako nejnižší možný účet.

```
min_print_price   = 250 Kč
+ small_order_surcharge (pod 100 g)  = 50 Kč
+ doprava                            = ~85 Kč
mezisoučet                           = 335–385 Kč
+ hrubé pokrytí brány (1,5 % + 3 Kč)
checkout floor                       ≈ 343–394 Kč
```

**`small_order_surcharge` je obchodní přirážka, ne úhrada přípravy.** Příprava je už zahrnutá v `cena_tisku` přes `handling_*`. Původní název „poplatek za přípravu" tvrdil zákazníkovi opak a účetně to bylo dvojí účtování.

**Spouštěč „do 100 g" je prozatímní, ne posvátný.** Gramáž je proxy převzatá z trhu, ale dokument sám říká, že materiál tvoří jen malou část nákladu — takže se může ukázat, že správným spouštěčem je spíš `cena_tisku < X` nebo `handling / cena_tisku > Y`. Pro v0 nech 100 g a **sleduj to jako metriku**: kolik objednávek přirážku dostane a jaká je u nich skutečná CM proti těm bez ní.

`koef_kvality` **zrušen** — čas jemného profilu dává slicer přímo, viz §9.

**Ilustrativní checkout podlahy pro jednu `full` platbu** při `cena_tisku = 250 Kč`, dopravě 85 Kč a bráně 1,5 % + 3 Kč. Individuální nabídka s `deposit` + `balance` se hrubuje o dvě fixní složky:

| Scénář | Podlaha |
|---|---|
| Zasílaná objednávka bez `small_order_surcharge` | **~343 Kč** |
| Zasílaná objednávka do 100 g s `small_order_surcharge` | **~394 Kč** |

Osobní odběr není součástí v0 ani ekonomiky sítě; checkout podporuje jen dopravce. Případné zavedení vyžaduje vlastní anonymizovaný předávací workflow a nový přepočet podlahy.

---

## 8. Meze automatu

| Mez | Hodnota |
|---|---|
| **Hodnotový strop** | ⚠ 2 000–3 000 Kč |
| Strop počtu kusů | ⚠ dopočítat |
| Rozměr | build volume způsobilých strojů |
| Blokující úrovně preflightu | `blocking` |
| AI veto | neaktivní (post-validation) |

---

## 9. Slicing

**Referenční profily jsou per materiál × kvalita, nezávislé na stroji.** Ne jeden generický PLA profil pro celý svět — PETG má jiné rychlosti a teploty, takže by nabídka byla systematicky vedle.

| Profil | Tryska | Vrstva |
|---|---|---|
| `REF/PLA/návrhová` | 0,4 | ⚠ 0,28 |
| `REF/PLA/standardní` | 0,4 | 0,2 |
| `REF/PLA/jemná` | 0,4 | ⚠ 0,12 |
| `REF/PETG/*` | 0,4 | dtto |

Výplň je nezávislá volba `dekorativní` 10 % / `běžná` 20 % / `pevná` 40 %. Její procento, vzor a všechny další toolpath volby tvoří immutable `PrintConfigRevision`, která vstupuje do klíče reference, candidate i production slice; profil kvality ji nesmí tiše přepsat.

Podpěry auto. Kvalita **nemá koeficient** — čas se bere ze skutečného slice daného profilu.

**Slicuje se líně:** až pro kombinaci, kterou zákazník vybral, ne všech šest dopředu. Do té doby drží obrazovku hrubý odhad z objemu meshe.

| Parametr | Hodnota |
|---|---|
| **Tolerance tesselace STEP** | ⚠ zafixovat a verzovat — mění gramáž i čas |
| Arrangement u dávek | **slicer-native**, nikoli vlastní packing algoritmus |

---

## 10. Provoz a validace

| Parametr | Hodnota |
|---|---|
| **Shakedown — délka** | 1 měsíc bez reklamy |
| **`strop_spend_v0`** | **5 000 Kč** do jednoho kanálu |
| Lhůta na individuální nabídku | 24 h v pracovní dny |
| Slíbená dodací lhůta | ⚠ trh: 1–2 dny jednoduché, garance 72 h |
| **`payment_reservation_minutes`** | **⚠ 15 minut**; pozdější capture musí zdroje znovu získat, nebo se ihned refunduje |
| **`balance_payment_days`** | **⚠ 7 dní** od QC individuální zakázky; pak explicitní `OrderSettlement` |
| **`abandoned_item_retention_days`** | **⚠ 30 dní** od `cancelled_settled`; pak auditovaná recyklace/zničení |
| **`sample_confirmation_days`** | **⚠ 14 dní** od doručení sample; pak nejdřív zavřít revision capture window, zrušit neaktivovaný batch, refundovat nečerpanou část a uzavřít `partially_fulfilled`; pozdní capture se celý kompenzuje |
| Reklamační okno pro zádržné (síť) | 7 dní od doručení |
| **`source_model_retention_days`** | **90 dní** od terminálního stavu objednávky nebo expirace nabídky; jednotně pro zdrojové STL, 3MF i STEP |
| **`undelivered_reproduction_retention_days`** | **⚠ 90 dní** od terminálního stavu bez doručení; pak smazat rekonstruovatelný artefakt, pokud neběží incident/claim/legal hold |
| **`reproduction_artifact_retention`** | nejméně do snapshotovaného `claim_until` z přijaté verze podmínek; ⚠ přesnou lhůtu potvrdit s právním poradcem, aktivní claim/právní hold ji prodlužuje |

**Kapacitní brána expresu**

| Podmínka | Hodnota |
|---|---|
| Max podložek | 2 |
| Materiál a barva | musí být právě nasazené |
| Post-processing | žádný nad rámec začištění |
| Časové okno | součet hodin ≤ zbývající okno − rezerva na balení |

---

## 11. Modelářské služby

| Hladina | Vstup | Cena |
|---|---|---|
| Jednoduchý díl | kóty a fotky | ⚠ 600–1 200 Kč |
| **Návrh proti fyzickému vzorku** | předmět nebo zkušební kus | ⚠ dopočítat — obousměrná logistika |
| Reverse engineering | sken | individuálně |
| Kolo úprav | první zdarma, další účtovat | ⚠ |

Tržní kotva: příprava modelu 500 Kč/h (Bakuralab), post-processing 600 Kč/h bez DPH (TisknuTO).

| Parametr | Hodnota |
|---|---|
| CAD nástroj | ⚠ FreeCAD pro první zakázky; komerční licence až podle objemu |
| Přijímaný vstup | **STEP** jako univerzální formát |

---

## 12. Fixní náklady — strop

Hobby režim je přijatelný koncový stav (§12), takže fixní náklady v idle musí být téměř nulové.

| Položka | Strop |
|---|---|
| Platební brána | **bez měsíčního paušálu** — při 1–2 objednávkách/měsíc sežere paušál 200 Kč marži ze dvou zakázek |
| Slicer worker | on-demand, ne trvale běžící |
| Doména + hosting + brána celkem | ⚠ max několik set Kč/měsíc |

---

## 13. Tržní referenční pásmo

| Ukazatel | Hodnota |
|---|---|
| Prodejní cena FDM | 4–6 Kč/g hlavní pásmo; 1,50 spodní; 9 horní |
| Referenční sazba stroje na trhu | ~50 Kč/h |
| Množstevní sleva | až 20 % |
| Minimální objednávka | 200–250 Kč (u technicky zaměřených až 1 000) |
| Platba | 100 % předem u soukromých osob; záloha 30 % nad 5 000 Kč |

---

## 14. Limity DPH

| Parametr | Hodnota |
|---|---|
| Registrace od 1. 1. následujícího roku | 2 000 000 Kč obratu |
| Registrace okamžitá | 2 536 500 Kč |
| Strop v objednávkách při ~400 Kč | ~5 000/rok, tedy ~14/den |

**Sledovat měsíčně od první objednávky.**

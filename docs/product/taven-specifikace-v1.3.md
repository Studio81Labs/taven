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

Přidává: produkční flow v systému (stavy, G-code přes podepsané URL, povinná fotodokumentace, štítek, podání), sledování pro zákazníka, plnou administraci, notifikace, verzovaný ceník, profilovou matici s testovacím slicem, fázovanou objednávku se zkušebním kusem.

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

Platba není jeden sloupec na objednávce. `Order` má kolekci `Payment`, každý se samostatnou částkou, rolí `full` / `deposit` / `balance`, stavem brány a identifikátorem transakce. Automatická nabídka má jednu `full` platbu; individuální nabídka nejméně `deposit` a `balance`. Vrácení peněz se váže ke konkrétní zachycené platbě, aby šlo smířit částečné i úplné refundace. `payment_status` objednávky (`unpaid` / `partially_paid` / `paid` / `partially_refunded` / `refunded`) se odvozuje z těchto transakcí, není ručně přepisovaný stav. Stejně odvozené jsou `amount_due` a `refundable_balance` vůči právě platnému cenovému snapshotu; právě jejich nula určuje finanční vypořádání částečně splněné objednávky.

**Brána:** rozhodující je **absence měsíčního paušálu** (viz log #39), povinné je **bankovní tlačítko vedle karty**. Schovat za jedno rozhraní — je to nejsnáze vyměnitelná komponenta.

### 3.4 Odstoupení a záruka

Podle §1837 OZ se čtrnáctidenní lhůta **nevztahuje na zboží vyrobené podle požadavků spotřebitele**. Musí být **výslovně a srozumitelně** v podmínkách a potvrzeno před objednáním.

Konstrukce záruky **odděluje vadu tisku od vady modelu**:

> Tiskneme věrně podle dodaného modelu. Pokud byl model laděný na jiné tiskárně, může se lícování lišit — to není vada tisku.

To není formalita. Zákaznické modely bývají doladěné empiricky na jedné konkrétní tiskárně a nesou její skrytou kompenzaci; na kalibrovaném stroji pak **vyjdou přesněji a přestanou sedět**. Nikdy neslibuj lícování, slibuj věrnost modelu.

Reklamace je samostatná entita `Claim` navázaná na objednávku, položku, fázi nebo zásilku. Lze ji otevřít po `delivered`, `completed` i `partially_fulfilled`, a pro `Shipment.lost | returned` už ve stavu objednávky `shipped`. Terminální fulfilment stav zpětně nemění; pre-delivery incident může vytvořit náhradní zásilku/job nebo finančně vypořádané storno, každý výsledek s vlastním auditem.

Při přijetí objednávky se snapshotuje verze reklamační politiky z přijatých podmínek; při doručení každé položky nebo fáze z ní vznikne konkrétní `claim_until`. Standardní samoobslužný `Claim` lze otevřít do příslušného termínu; zákonná nebo smluvní výjimka jej může prodloužit právním holdem. Pozdější požadavek jde do ručního právního posouzení a bez zachovaného reprodukčního artefaktu vyžaduje nový upload zákazníka.

### 3.5 Makeři a IČO (jen při stavbě sítě)

Neexistuje legální způsob, jak mít pravidelné makery bez IČO. Limit 50 000 Kč pro příležitostné příjmy řeší **daňové osvobození, ne povinnost mít živnost**; rozhodující je soustavnost podle §420 OZ. Platforma je navíc dokonalá evidence.

**Řešení: oddělit „vyzkoušet si to" od „vydělávat".** Certifikace je zdarma a bez toku peněz; IČO se vyžaduje až u první placené zakázky.

### 3.6 Zakázané zakázky

Části střelných zbraní; prostředky k obcházení bezpečnostních prvků; zdravotnické prostředky ve styku s tělem; porušení práv třetích osob k modelu. V v0 manuální kontrola náhledu u každé objednávky.

### 3.7 Data zákazníka

Souhlas se zveřejněním fotografií hotových dílů, odmítnutelný checkboxem. **Zdrojová CAD data jsou citlivější než STL** — retenční politika i mlčenlivost je musí zmiňovat výslovně a u firemních zákazníků počítej s NDA.

Retence se neváže na příponu souboru. Každý nahraný zdrojový `ModelFile` — **STL, 3MF i STEP** — při expiraci nabídky nebo přechodu objednávky do terminálního stavu dostane `source_delete_after` podle společného parametru `source_model_retention_days` (výchozí hodnota v parametrech §10). Mazací job v tento den odstraní zdrojový upload a formátově specifické mezisoubory; u expirované nabídky bez objednávky odstraní i veškerou rekonstruovatelnou geometrii.

U přijaté objednávky vzniká zvlášť šifrovaný immutable `ReproductionArtifact`: kanonické produkční bajty `ModelGeometry` a reference na přesné revize profilů, kalibrace, `PrintConfigRevision` a cenového/slice snapshotu. Zdrojový STEP nebo 3MF tak nemusí zůstat uložený, ale reklamaci lze reprodukovat. Před doručením se `reproduction_delete_after` nenastaví; po doručení nesmí být dříve než příslušné `claim_until`. Aktivní incident zásilky, reklamace nebo právní hold termín prodlouží. Po odpadnutí poslední překážky mazací job odstraní artefakt a ponechá jen auditní metadata a hash, nikoli rekonstruovatelnou geometrii.

### 3.8 Právní kontrola

§3.4–§3.7 a obchodní podmínky ověřit s poradcem před spuštěním. Konkurenční VOP použít jako **strukturu a checklist, nikoli jako text**.

---

## §4 Cenový model

### 4.1 Vzorec

```
material    = gramáž_g × sazba_materiálu
machine     = čas_h × sazba_stroj_h          ← čas ze slice zvoleného ReferenceProfile
handling    = sazba_prace_h × (
                handling_order_fix
              + handling_plate × podložek
              + handling_piece × qty          (degresivní)
              + handling_pack × počet_plánovaných_zásilek
              + Σ(shipping_trip / zásilek_v_cestě_i)
              + postprocessing )
handling_pretisk = sazba_prace_h × (
                    handling_plate × podložek
                  + handling_piece × qty       (degresivní)
                  + postprocessing )
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
                      x − poplatek_platebni_brany(x) ≥ mezisoucet
```

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

**Přepravní náklady se počítají přes všechny plánované zásilky.** Běžná objednávka má jednu; fázovaná objednávka má nejméně sample a batch. Každá zásilka má vlastní kategorii, obal, `handling_pack` a alokaci cesty. Práh dopravy zdarma nuluje součet sazeb dopravce, ne počet zásilek ani jejich náklad v CM.

**Nevyhnutelné prodejní náklady nesmějí propadnout pod cenovou podlahu.** Rozdíl mezi skutečným nákladem dopravce a částkou účtovanou zákazníkovi vstupuje do nákladové báze ještě před marží. Nad výsledným mezisoučtem se cena hrubuje podle konkrétního sazebníku platební brány; pro pravidlo `p × x + f` je `cena_celkem = (mezisoucet + f) / (1 − p)`. Po odečtení brány proto stále zbývá celý mezisoučet a doprava zdarma neznamená zápornou CM na nominální podlaze.

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

### 4.6 Přepravní kategorie

Bounding box počítá preflight, ale kategorie se nesmí určit jen z jednoho dílu. Před závaznou cenou vznikne deterministický `ShipmentPlan` pro **celé množství každé fáze**:

1. největší jednotlivý díl se musí vejít do rozměrů zvolené kategorie po přidání obalové rezervy
2. odhad zabraného objemu je `Σ(bbox_volume × qty) / koeficient_plnění_krabice`
3. odhad hmotnosti je materiál všech kusů + hmotnost obalu
4. kusy se deterministicky rozdělí do nejmenší kategorie, která nepřekročí objem ani hmotnost; při překročení vznikne další plánovaná zásilka
5. na hraně se zaokrouhluje nahoru; co se nevejde do žádné podporované kategorie, jde do individuální nabídky

Vlastní přesný 3D bin packing **nestav** — pro hrubé přepravní kategorie stačí konzervativní first-fit nad bbox objemem a hmotností. `ShipmentPlan` je součást cenového snapshotu; fázovaná objednávka plánuje sample a batch odděleně a revize modelu přepočítá jen zbývající zásilky.

Tvrdá podmínka: **největší jednotlivý díl** se musí vejít do rozměrů krabice.

**Strukturální napětí, vědomě přijaté:** diferenciace vůči hobbistovi s P1S je velký build plate, ale přesně ty zakázky vypadávají z levné boxové sítě.

**Bonus zdarma:** *„kdyby byl díl o 3 cm kratší, doprava by stála o 60 Kč míň; zkusit jinou orientaci nebo rozdělit?"*

### 4.7 Expresní výroba

**Předběhnutí fronty, ne kurýr.** Dokončení do 24 h od potvrzení, pak normální Zásilkovna. Nulové dodatečné náklady, zpeněžuje volnou kapacitu.

**Prodávat s garancí vrácení příplatku.** V českém vzorku to nikdo nenabízí a při funkční kapacitní bráně to nic nestojí. Podmínkou legitimity je **poctivý standardní termín** — jinak express jen prodává zpátky rezervu, což lidé při druhé objednávce poznají.

**Kapacitní brána — default zapnuto, měří zásahy obsluhy, ne hodiny.** Jeden dvacetihodinový tisk přes noc je v pořádku, pět čtyřhodinových podložek ne, protože mezi nimi musí někdo sejmout díly. Podmínky v parametrech §10. Když padnou, volba se **nezobrazí**.

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
| STL, 3MF | ✓ | ✗ | **ano** |
| OBJ | ✓ | ✗ | ne |
| **STEP** | ✓ (slicery ho importují) | ✓ univerzální vstup | **ne** |
| nativní CAD (f3d, sldprt) | ✗ | až později | ne |

**STEP není blocker v0.** Produktově je to silný diferenciátor — zákazník s CADem a bez vyexportovaného meshe je přesně ta lepší cílovka — ale implementačně přináší tesselaci s deterministickou tolerancí, jednotky, sestavy, náhled a novou plochu na selhání. Úkolem v0 je ověřit instant quote, ne pokrýt formáty. Když by STEP brzdil vydání, pusť **STL + 3MF** a STEP přidej hned poté.

**STEP může obsahovat sestavu.** Když soubor obsahuje víc těles, ukaž je jako seznam a nech zákazníka vybrat, které se tisknou; každé naceň jako samostatný `OrderItem`. Nad práh → individuální nabídka. U STL tenhle případ neexistuje.

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
| Sestava ve STEPu (víc těles) | vlastní | dotaz | v0 |
| Počet objektů, stabilita | vlastní | info | v0 |
| Reliéfní text pod prahem | AI | warning | post-validation |

**Kontrola měřítka:** STL neobsahuje jednotky. Zákazník modelující v palcích pošle díl 25,4× větší nebo menší, aniž by si toho všiml — proto má PCBWay ve formuláři výslovný přepínač jednotek. Stačí pravidlo nad bboxem, který stejně počítáš.

### 5.6 Cache

Klíč reference slice je `geometry_hash + reference_profile_revision_id + print_config_revision_id + parts_per_plate`. Klíč production slice je `geometry_hash + machine_profile_revision_id + machine_calibration_revision_id + print_config_revision_id + parts_per_plate`. `PrintConfigRevision` je immutable snapshot zvolené úrovně výplně (procento i vzor) a všech dalších konfiguračních voleb, které mění toolpath; výplň tedy není skrytá ve kvalitě. `geometry_hash` patří konkrétnímu `ModelGeometry`, ne kontejnerovému `ModelFile`. Revision ID je globálně unikátní immutable snapshot, takže se nemohou srazit lokální čísla verzí dvou profilů ani dvou fyzických strojů. `MachineCalibration` obsahuje `flow_ratio` a XY/elephant-foot kompenzace; změna kteréhokoli override vytvoří novou revizi a G-code z jiné kalibrace nebo jiné výplně nelze vrátit z cache.

`SliceResult` reprezentuje jednu konkrétní obsazenost podložky; pro jeden kus je `parts_per_plate = 1`, u dávky se plná a poslední částečná podložka cachují samostatně a výsledek nabídky se z nich složí. Závazná cena smí použít jen reference výsledek; production výsledek si ukládá obě strojové verze.

**Reference slice určuje zákaznickou cenu, nikdy rezervaci heterogenního stroje.** Pro každý kandidátní fyzický stroj vznikne před rezervací `CandidateResourceEstimate` z jeho `MachineProfile`, `MachineCalibration`, `PrintConfigRevision`, rozměru podložky a machine-specific arrangementu celého množství. Jeho klíč obsahuje všechny production vstupy plus `quantity` a `arrangement_revision_id`. Agreguje počet podložek, jejich intervaly a gramáž ze strojových `SliceResult`; g-code se v této fázi neukládá ani nedá odeslat do stroje. Produkční G-code vznikne až po `accepted` ze stejných immutable vstupů. Kandidát bez čerstvého odhadu se nesmí objevit v závazném `EligibilitySnapshot`.

### 5.7 Async a UX ceny

1. **Hrubý odhad z objemu meshe a bboxu okamžitě** (±20 %, milisekundy) → číslo do 200 ms, což je ten konverzní efekt
2. **Skutečný slice na pozadí** → cena se upřesní a **stává se závaznou**, pokud jsou splněny meze §4.8

Právně čisté: hrubý odhad je výslovně nezávazný, závazná cena vzniká až po reálném slice a preflightu.

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
| `Customer` | ✓ | ✓ | bez povinné registrace |
| `Order` / `OrderItem` | ✓ | ✓ | fulfilment objednávky; platby a od v1 zásilky jsou kolekce potomků |
| `Payment` | ✓ | ✓ | více transakcí na objednávku; role `full` / `deposit` / `balance` + refundace |
| `OrderPhase` | — | ✓ | `sample` / `batch`; vlastní model, cenový snapshot, joby a zásilky |
| `OrderRevision` | — | ✓ | nový model, reslice, cenový rozdíl, přijetí a `revision_amount_due` |
| `ModelFile` | ✓ | ✓ | immutable, adresovaný hashem |
| `ModelGeometry` | ✓ | ✓ | kanonická geometrie tělesa/podmnožiny; vlastní `geometry_hash` |
| `ReproductionArtifact` | ✓ | ✓ | šifrovaná produkční geometrie + immutable vstupy pro případný claim; retence nejméně do `claim_until` |
| `SliceResult` | ✓ | ✓ | vždy `PrintConfigRevision`; reference klíč s profile version, production navíc s calibration version |
| `CandidateResourceEstimate` | ✓ | ✓ | machine-specific plate plan, gramáž a intervaly; bez použitelného G-code |
| `PreflightFinding` | ✓ | ✓ | nález + úroveň + zda zákazník akceptoval |
| `Job` | ✓ | ✓ | přiřaditelný jednomu uzlu; přetisk odkazuje přes `replaces_job_id` |
| `Node` / `Machine` / `Inventory` | ✓ | ✓ | uzel jediný, entity ale existují |
| `InventoryReservation` | ✓ | ✓ | gramáž z konkrétních kompatibilních zásob, TTL před capture a commit při přijetí jobu |
| `CapacityReservation` | ✓ | ✓ | nekolidující strojové intervaly pro všechny plánované podložky včetně bufferu |
| `ProductionReservation` | ✓ | ✓ | atomická skupina inventory + capacity rezervací jedné objednávky/fáze na jednom uzlu |
| `ReplacementRequest` | ✓ | ✓ | trvalá recovery povinnost od neúspěšného jobu/claimu až k rezervovanému náhradnímu jobu nebo stornu |
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
| `EligibilitySnapshot` | ✓ | ✓ | způsobilí kandidáti s vlastním `CandidateResourceEstimate`, konfigurací a barvou |
| `Shipment` | ✓ | ✓ | jedna běžně v v0, více/fáze v v1; náhrada odkazuje přes `replaces_shipment_id` |
| `Claim` | ✓ | ✓ | reklamace dílu nebo incident zásilky oddělený od fulfilment stavu objednávky |
| `AuditEvent` | — | ✓ | |
| `Offer`, `QualityEvent`, `Certification`, `Payout` | — | — | jen při stavbě sítě |

### 6.3 Stavové automaty

**Order — fulfilment**
```
draft → quoted → confirmed → in_production → qc_passed
      → ready_to_ship → shipped → delivered → completed
```
`confirmed` znamená, že je uhrazená částka potřebná ke startu: u automatické nabídky 100 %, u individuální nabídky záloha. `ready_to_ship → shipped` se neřídí názvem odvozeného `payment_status`, ale aktuálním cenovým snapshotem: guard vyžaduje `amount_due = 0` a `refundable_balance = 0`. Samotná záloha proto nestačí, zatímco finančně vypořádané snížení ceny může být po částečné refundaci bezpečně odesláno i se stavem `partially_refunded`.

Odbočky: `quoted → expired | cancelled`; `confirmed | in_production | qc_passed | ready_to_ship → cancelled`; `cancelled → refunded`, pokud už byla zachycena platba; `in_production | shipped → partially_fulfilled`, pokud je nejméně jedna fáze doručená a všechny zbývající jsou zrušené a finančně vypořádané. Při ztracené nebo vrácené zásilce bez dříve doručené fáze může finančně vypořádaný refund vést `shipped → cancelled → refunded`. Nezaplacené `cancelled` je terminální, zaplacené přejde na `refunded` až po úspěšném vrácení všech zachycených plateb. `completed`, `partially_fulfilled` a `refunded` jsou terminální fulfilment stavy; pozdější reklamace je nemění.

**Shipment**
```
planned → label_created → handed_over → in_transit → delivered
in_transit → lost | returned
```
`lost` a `returned` jsou terminální stavy konkrétní zásilky a automaticky otevřou `Claim` proti zásilce, i když objednávka ještě není `delivered`. Výsledek `resolved_reship` vytvoří nový `Shipment` s `replaces_shipment_id`; `resolved_reprint` jde přes rezervovaný `ReplacementRequest`. Během náhradního fulfilmentu zůstává agregát `shipped` a do `delivered` smí přejít až po doručení všech požadovaných zásilek nebo jejich náhrad. Pokud zákazník zvolí refund, použije se větev `refunded` nebo `partially_fulfilled` výše, takže nedoručená zaplacená objednávka nezůstane viset.

**Payment**
```
created → pending → captured
pending → failed
captured | partially_refunded → refund_pending
refund_pending → partially_refunded | refunded
```
Každý refund je samostatná idempotentní transakce a `refunded_amount` je součet úspěšných refundací konkrétního capture. Po webhooku se stav vrátí do `partially_refunded`, dokud `refunded_amount < captured_amount`; teprve rovnost znamená `refunded`. Opakované dílčí refundace jsou tedy stejnou smyčkou, nikoli falešným přechodem do plného refundu. Objednávkový `payment_status` je projekce všech jejích plateb, ne náhrada jejich historie.

**Claim**
```
opened → investigating → resolved_rejected | resolved_reship | resolved_reprint | resolved_refund
```
Claim lze otevřít proti doručené položce/fázi bez ohledu na to, zda je agregátní objednávka `delivered`, `completed` nebo `partially_fulfilled`, a proti `Shipment` ve stavu `lost` nebo `returned`, i když je objednávka teprve `shipped`. `resolved_reship` vytvoří navázanou zásilku, `resolved_reprint` vytvoří `ReplacementRequest`, který smí vytvořit náhradní `Job` až s čerstvou produkční rezervací, a `resolved_refund` spustí refundaci konkrétních `Payment`.

Pro post-delivery claim otevřený do snapshotovaného `claim_until` čte `resolved_reprint` kanonickou geometrii a immutable slice vstupy z `ReproductionArtifact`; nezávisí tedy na tom, zda už byl zdrojový `ModelFile` po 90 dnech smazán. Před doručením nemá reprodukční artefakt expiraci; otevřený shipment incident nebo claim prodlouží jeho retenci až do terminálního vyřešení.

**Job**
```
created → accepted → gcode_ready → printing
        → printed → photo_submitted → qc_approved
        → packed → handed_over → settled
```
Odbočky: `printing → failed`, `photo_submitted → qc_rejected`.

Obě neúspěšné větve vytvoří trvalý `ReplacementRequest` navázaný na neúspěšný job; stejnou cestu používá `Claim` s výsledkem reprint. Příkaz `create_replacement` nejdřív vytvoří čerstvý `EligibilitySnapshot` a znovu vyhodnotí aktuální požadavek materiálu/kapacity. V jedné transakci získá novou `ProductionReservation` — čerstvou gramáž i nekolidující strojové intervaly — a teprve pak vytvoří nový `Job` ve stavu `created` s `replaces_job_id`. Spotřeba původního jobu se nikdy nepovažuje za rezervaci přetisku. Původní job zůstane terminálně `failed` nebo `qc_rejected`, aby se neztratil first-pass yield.

Pokud novou rezervaci nelze získat, `ReplacementRequest` zůstane auditovatelně `pending_capacity`, job se nevytvoří ani nenabídne a systém opakuje hledání jen do provozního deadline. Pak se request i neúspěšná fáze zruší. Objednávka bez dříve doručené fáze přejde do `cancelled → refunded`; objednávka s doručeným sample se po vrácení nečerpané části uzavře `partially_fulfilled`. Potvrzená objednávka tedy musí mít aktivní/úspěšný listový job, otevřený `ReplacementRequest` s deadlinem, nebo finanční vypořádání.

**Časová razítka stavových přechodů měří průchod procesem, ne aktivní handling.** Mezi přechody je tisk, čekání ve frontě, čekání na zákazníka i doprava, takže jejich rozdíl nesmí vstoupit do nákladů práce.

Aktivní práci zachycuje samostatný `HandlingSession`: `component`, `started_at`, `ended_at`, vazba na objednávku/job a jmenovatele `plate_count`, `piece_count` nebo `shipment_count`. Administrace nabídne start/stop časovač; pro činnost bez časovače (zejména `shipping_trip`) je povolený strukturovaný ruční zápis délky se zdrojem `manual`. U dávkové práce se zapíše jedna relace a počet obsloužených jednotek, aby šla doba správně rozpočítat. Stavové časové značky zůstávají pro SLA a provozní metriky, `HandlingSession` pro CM a kalibraci parametrů.

**Fázovaná objednávka (v1)**
```
quote → sample (1 ks) → zákazník potvrdí fit
      nebo nahraje revidovaný model
      → dávka (N ks)
```
Cena obou fází pro **původní `ModelFile`** se zamkne už při nacenění, takže zákazník od začátku ví celkovou částku. Potvrzení fitu beze změny modelu cenu nemění, ale před aktivací vytvoří čerstvý `EligibilitySnapshot` a atomicky revaliduje nebo přeskládá drženou batch `ProductionReservation`; prošlý či kolidující interval se nikdy nepovažuje za kapacitu.

Nahrání revidovaného `ModelFile` původní cenu batch fáze ruší: vznikne `OrderRevision`, nový preflight a referenční slice, přepočítají se obsazenosti podložek, `required_material_g`, požadované strojové intervaly i kategorie všech zbývajících zásilek a zákazník přijme nový cenový rozdíl přes tokenizovaný odkaz. Příkaz přijetí revize vždy vytvoří čerstvý `EligibilitySnapshot` a atomicky nahradí původní batch `ProductionReservation` rezervací nové gramáže a kapacity. Dokud to nelze, přijetí se necommitne, revize zůstává `awaiting_capacity` a batch se neaktivuje.

Zvýšení ceny vytvoří `balance` Payment navázaný na revizi a `revision_amount_due`; jeho capture smí začít až po nové rezervaci. Batch se aktivuje teprve po přijetí revize, `revision_amount_due = 0` **a** nové `ProductionReservation` ve stavu `held`. Původní záloha tedy nestačí k výrobě zdražené geometrie. Snížení ceny zvýší `refundable_balance`, ale nemění stejný požadavek na novou rezervaci — nižší cena může stále znamenat více materiálu nebo delší obsazení stroje.

Cena sample fáze ani už vzniklé náklady se zpětně nemění; odmítnutí revize přepne batch do `cancelled`, vrátí dosud nečerpanou část platby a po finančním vypořádání uzavře agregát jako `partially_fulfilled`. Guard terminálního vypořádání není konkrétní `payment_status`, ale `amount_due = 0` a `refundable_balance = 0`, takže částečná refundace je platný terminální výsledek. Trh tuhle iteraci běžně dělá — ale e-mailem přes čtyři až šest zpráv.

Každá fáze je samostatný `OrderPhase`; sample a batch mají vlastní joby a vlastní `Shipment`. Doručení vzorku dokončí pouze sample fázi a přepne ji na čekání na potvrzení, nikoli celou objednávku na `delivered`. Batch se aktivuje až potvrzením fitu beze změny s čerstvě revalidovanou `ProductionReservation`, nebo přijetím `OrderRevision` s `revision_amount_due = 0` a novou rezervací ve stavu `held`. Cena všech plánovaných zásilek je součástí příslušného cenového snapshotu.

```
sample: active → in_production → shipped → delivered → awaiting_confirmation → completed
batch:  locked → active → in_production → shipped → delivered → completed
        locked → awaiting_capacity → active
        locked → awaiting_revision → awaiting_capacity → active
                                    → active
        locked | awaiting_revision | awaiting_capacity | active | in_production → cancelled
```
Události sample fáze stav celkové objednávky za `in_production` neposouvají. Poslední aktivní fáze — běžně batch — řídí **všechny** zbývající přechody agregátu: schválení QC `in_production → qc_passed`, finanční vypořádání aktuálního snapshotu a připravená finální zásilka `→ ready_to_ship`, předání dopravci `→ shipped`, doručení `→ delivered` a uzavření `→ completed`. Agregát tedy nikdy nepřeskakuje mezistavy pevného automatu.

**QuoteRequest**
```
new → in_review → quoted → accepted → (vytvoří Order)
                        → rejected | expired
```

### 6.4 Invarianty

1. G-code se generuje **až po** `accepted`.
2. `Job` nesmí opustit `created` bez přiřazeného `Node`.
3. `confirmed` vyžaduje zachycenou plnou platbu u automatické nabídky nebo zachycenou zálohu u individuální nabídky.
4. `shipped` vyžaduje vůči aktuálnímu cenovému snapshotu `amount_due = 0` a `refundable_balance = 0`; záloha sama nikdy nestačí, ale dokončená částečná refundace odeslání neblokuje.
5. `SliceResult` použitý pro cenu vždy odkazuje na `ReferenceProfile`, nikdy na `MachineProfile`, a jeho klíč obsahuje `geometry_hash` konkrétního `ModelGeometry`, `print_config_revision_id` i `parts_per_plate`; machine-specific odhad rezervace používá oddělený `CandidateResourceEstimate`.
6. `Order` nesmí být `confirmed` bez reference na **verzi ceníku a verzi podmínek**.
7. `Job` si při přijetí ukládá `payout_amount`, i když je příjemcem provozovatel.
8. Závazná cena smí vzniknout jen z deterministického výpočtu.
9. Makerovy náklady **nikdy** nevstupují do zákaznické ceny.
10. Neúspěšný job musí mít otevřený `ReplacementRequest` s deadlinem; navazující `Job` přes `replaces_job_id` smí vzniknout jen atomicky s čerstvou `ProductionReservation`. Jinak se jeho fáze zruší: bez dříve dodané fáze následuje `cancelled → refunded`, po dodaném sample finančně vypořádané `partially_fulfilled`.
11. Každá zásilka fázované objednávky patří právě k jedné `OrderPhase`; sample zásilka nesmí dokončit celou objednávku a poslední fáze musí vyvolat všechny mezistavy agregátu.
12. Revidovaný `ModelFile` nesmí aktivovat batch bez nového deterministického slice, cenového snapshotu, čerstvého `EligibilitySnapshot`, atomicky nahrazené `ProductionReservation`, přijetí `OrderRevision` zákazníkem a `revision_amount_due = 0`; požadavek na materiál a kapacitu platí i při zlevnění, odmítnutý batch končí finančně vypořádaným `partially_fulfilled` agregátem.
13. Production `SliceResult` a přijatý `Job` musí držet immutable `machine_profile_revision_id` i `machine_calibration_revision_id` konkrétního stroje.
14. Závazná cena musí mít `ShipmentPlan` pro celé množství každé fáze; žádný plánovaný balík nesmí překročit objemový ani hmotnostní limit kategorie.
15. `Claim` je jediná cesta pro reklamaci po doručení i incident po předání dopravci; terminální fulfilment stav nepřepisuje, ale z `shipped` smí po nedoručení vyvolat náhradní fulfilment nebo finančně vypořádané storno.
16. Závazná cena a capture platby vyžadují neprázdný, čerstvý `EligibilitySnapshot`; alespoň jeden způsobilý uzel musí mít pro vybranou barvu `available_g ≥ required_material_g` i nekolidující strojové intervaly a capture smí začít až po atomickém vytvoření společné `ProductionReservation` pro celou gramáž i kapacitu.
17. Každá změna stavu zapisuje `AuditEvent` (od v1).

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

**Krok 1 — nahrání.** Drag & drop. Okamžitě náhled, rozměry, hrubý odhad ceny, indikátor „počítám přesnou cenu".

**Krok 2 — parametry.** Čtyři, zbytek odvozený: materiál, barva, kvalita (návrhová / standardní / jemná), počet kusů. **Výplň není slider**, jen tři pojmenované stupně. Trysku, teploty, styl podpěr a orientaci nezobrazovat.

Plus jeden příznak: **„díl musí do něčeho zapadnout / má lícované rozměry"** — geometricky se to spolehlivě nedetekuje, tak se zeptej. Otevře cestu ke zkušebnímu kusu nebo do individuální nabídky.

**Krok 3 — nálezy preflightu.** Risk checkboxy (§7.5).

**Krok 4 — cena.** Transparentní rozpad: cena tisku, množstevní sleva, doprava, expres. **Celková částka vizuálně dominantní, rozpad pod ní jako detail** — vedle konkurenta s „dopravou zdarma" vypadá rozpad opticky dráž.

**Tichá úniková cesta** k individuální nabídce jako odkaz, ne rovnocenné tlačítko. Kdyby byly stejně velké, značná část lidí zvolí konzultaci i bez potřeby. Cestu **povyšuje systém**, když preflight něco najde.

### 7.3 Barvy

**Zákazník sklad nikdy nevidí.** Paleta není globální sjednocení inventáře. Nejdřív se pro aktuální geometrii a konfiguraci vyfiltrují stroje, které splňují build volume, materiál, aktivní `MachineProfile`, trysku, tier/certifikaci a cooldown. Reference slice zůstává jen vstupem zákaznické ceny. Každý kandidátní fyzický stroj má vlastní `CandidateResourceEstimate`: machine-specific arrangement celého množství a metriky slice s jeho profilem a kalibrací určí jeho `required_material_g`, počet podložek i délku intervalů včetně termínového bufferu. Menší nebo pomalejší stroj tedy nikdy nedědí gramáž ani kapacitu reference stroje.

`available_g` je fyzicky evidovaná gramáž kompatibilních zásob uzlu minus jejich aktivní rezervace; dostupná kapacita je kalendář stroje minus nekolidující aktivní `CapacityReservation`. Teprve paleta je sjednocení barev kandidátů, pro které lze současně umístit jejich celý machine-specific plán a platí jejich vlastní `available_g ≥ required_material_g`. Po výběru barvy musí zůstat alespoň jeden takový plán; jinak se barva skryje a závazná cena nevznikne.

Výsledek ukládá do krátce platného `EligibilitySnapshot` **per kandidát** ID `CandidateResourceEstimate`, jeho `required_material_g`, konkrétní plán intervalů a pozorovanou dostupnost. Bezprostředně před capture platby se odhad vybraného stroje i stejný predikát přepočítají. Jedna databázová transakce zamkne řádky zásob i kalendář právě tohoto stroje a vytvoří společnou `ProductionReservation`: `InventoryReservation` na jeho celou požadovanou gramáž a nekolidující `CapacityReservation` pro jeho podložky. Teprve úspěch obou částí povolí capture; souběžný checkout nemůže utratit tutéž gramáž ani slíbit stejný strojový interval podruhé.

`ProductionReservation` má TTL jen po dobu nedokončené platby nebo nepřijaté revize: neúspěch ji uvolní, úspěšný capture (nebo přijatá revize bez doplatku) ji přepne na `held` bez expirace, přijetí jobu materiál commitne do spotřeby a kapacitu do plánu a storno vrátí nevyužité zdroje. V v0 je množina jediný vlastní stroj a paleta obsah jeho tři AMS; s heterogenní sítí se nikdy nesmí nabízet barva ze stroje, který ostatní požadavky, celou gramáž a plánované intervaly zakázky nesplní.

### 7.4 Množstevní varianty

Cena za 1 / 5 / 20 kusů vedle sebe. Nejlevnější upsell — handling a doprava se rozpustí.

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

Rekapitulace s rozpadem ceny; widget Zásilkovny pro **výběr výdejního místa** (v checkoutu, ne u makera); fakturační údaje **bez povinné registrace**; souhlas s podmínkami a **výslovné potvrzení výjimky z odstoupení**; checkbox souhlasu se zveřejněním fotek; platba kartou i **bankovním tlačítkem**. V0 ani síť zatím nenabízí osobní odběr — vyžadoval by samostatný anonymizovaný předávací workflow, který není součástí scope.

### 7.8 Sledování

**Tokenizovaná URL v e-mailu, bez účtu.** Stav v lidské řeči, termín, **fotka hotového dílu s možností odsouhlasení před odesláním**, tracking, doklad.

Fotka jako zákaznický touchpoint není režie navíc — db3D to už dělá, takže je to očekávaná praxe.

### 7.9 Statické stránky

Ceník, jak to funguje, portfolio, kontakt, VOP, reklamační řád, zásady zpracování osobních údajů.

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

Kalibrační overridy se nikdy nepřepisují na místě. Uložení vytvoří novou `MachineCalibration`; rozpracované a historické joby zůstávají na své verzi, nové joby snapshotují právě aktivní verzi při přijetí.

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
- **S3-compatible** — všechny zdrojové `ModelFile` (STL, 3MF i STEP) se mažou podle společného `source_delete_after`; minimální `ReproductionArtifact` přijaté objednávky zůstává nejméně do `claim_until`, G-code se maže po dokončení jobu
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

**Filtr způsobilosti musí proběhnout dřív, než vznikne paleta a závazná cena, znovu před capture platby a nakonec předtím, než job komukoli blikne.** Všechny tři kroky používají stejný verzovaný predikát, ale gramáž, počet podložek a intervaly berou z `CandidateResourceEstimate` konkrétního stroje: build volume ≥ bbox + rezerva; aktivní `MachineProfile`; nasazený materiál a barva; candidate `available_g ≥ required_material_g` po odečtení aktivních rezervací; typ trysky odpovídá materiálu; tier/certifikace ≥ požadavek objednávky; nekolidující candidate intervaly; není v cooldownu. Před capture se materiál i kapacita atomicky rezervují na jednom vyhovujícím uzlu a nabídku jobu smí vidět jen aktuální držitel `ProductionReservation`.

Při odmítnutí nebo timeoutu vznikne pro další stroj čerstvý machine-specific odhad. Jedna transakce na něm rezervuje **jeho** gramáž a intervaly a teprve po úspěchu uvolní předchozí skupinu; hodnoty se mezi různými stroji nekopírují. Až potom se odešle další nabídka. Pokud přesun není možný, job se nikomu nezobrazí a spustí se provozní eskalace/refundace.

```
Vlna 1 (0–15 min):   nejvýše skórovaný způsobilý držitel rezervace   payout ×1.00
Vlna 2 (15–45 min):  další způsobilý tier A/B po přesunu rezervace   payout ×1.08
Vlna 3 (45–120 min): další způsobilý uzel po přesunu rezervace       payout ×1.15
```

*Tato čísla nelze navrhnout dopředu — bez reálných makerů by se psala z fantazie a po třetím uzlu přepisovala. Výchozí odhad k okamžité revizi.*

**Rezerva termínu:** odhad tisku + buffer + doprava. **Anti-cherry-picking:** `acceptance_rate` je součást skóre. **Vlastní kapacita se neupřednostňuje** a slouží jen jako eskalace poslední instance.

### 11.8 Výplaty a reklamace

Brána na vstupu, **měsíční samofakturace** na výstupu. Zádržné se uvolní po `delivered` + reklamační okno.

- **zavinění uzlu** → uzel nese materiál, platforma dopravu a přetisk
- **nezaviněné** (vada modelu zákazníka, nereálná tolerance) → uzel dostane zaplaceno v plné výši

Poslední bod je zásadní. Pokud maker nese riziko špatného zadání, síť se rozpadne.

### 11.9 Node agent

Až když je ruční provoz úzkým hrdlem a uzlů je přes deset. Bambu LAN (FTP + MQTT), PrusaLink, Moonraker, OctoPrint.

Architekturně tentýž problém jako FastyBird — discovery, stavový automat, telemetrie přes MQTT.

**Bezpečnost:** odchozí spojení, žádné otevírání portů; agent nedostane údaje o zákazníkovi; G-code přes podepsanou URL, po dotisku se maže; **tisk se spouští až po potvrzení makerem u stroje**, nikdy autonomně.

### 11.10 Multicolor

**Různé díly v různých barvách** — levné, bez odpadového problému, jen `OrderItem.color`. **Lze i v v1.**

**Vícebarevný jeden díl** — zákazník musí dodat přiřazení barev (holý STL to nenese); AMS proplachuje a u dvoubarevného dílu skončí 30–50 % materiálu v purge věži; **odpad je funkcí stroje, ne modelu** (jednonozzlové AMS vs. dual nozzle vs. IDEX se liší násobně), což rozbíjí invariant §6.4 bod 4.

Řešení: **custom request** do té doby, pak **nestavět malovátko, přijmout 3MF s paint daty** — OrcaSlicer CLI to umí slicnout přímo. Dny, ne měsíce.

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
| **Certifikace, tiery, výplaty** | druhý až třetí externí uzel |
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

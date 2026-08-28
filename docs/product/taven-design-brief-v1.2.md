# Taven — zadání pro design v1.2

**Nahrazuje část B dokumentu `taven-identita-a-design-brief.md`**, který je tím celý překonaný — identita žije v `taven-identita-v1.1.md`.
**Cituje:** `taven-identita-v1.1.md` (tokeny, tón, zákazy), `taven-specifikace-v1.3.md` (chování), `taven-parametry.md` (čísla).
**Datum:** 2026-08-28
**Status:** produkční design baseline po iteracích landing page, objednávkového flow a zákaznického archivu.

---

## 1. Co se navrhuje

Kompletní zákaznický povrch **Tavenu** — české služby zakázkového 3D tisku: public/content stránky, objednávková aplikace, zákaznický účet a support/legal dokumenty.

**Jazyk: čeština**, včetně mikrotextů a stavů.

## 2. Ústřední myšlenka

> Nahraj soubor. Po přesném výpočtu a výběru dopravy dostaneš závaznou cenu. Zaplať a tiskneme.

Konkurence v Česku má kalkulačky, ale **všechny končí orientačním odhadem a e-mailem**. Taven dá cenu, která platí. To musí být z obrazovky čitelné do tří sekund.

## 3. Landing

**Hero není nadpis, hero je nahrávací pole.** První akcí má být nahrání, ne čtení.

Druhý vchod — „nemáš soubor? pošli fotku rozbitého dílu" — je viditelný, ale tišší. Odkaz, ne rovnocenné tlačítko. Jsou to dvě cílovky, ne dvě větve.

Odkaz vede na strukturovaný poptávkový formulář: popis a účel dílu, referenční fotky, rozměry, požadovaný termín a kontakt. Odeslání vytvoří `QuoteRequest` se stavem úspěchu a referencí; individuální nabídka se vrací tokenizovaným odkazem, ze kterého lze pokračovat k objednávce.

Pořadí sekcí: jak to funguje → čím se liší nacenění → ceník → ukázky vlastních výtisků → **Za zakázku ručí Taven**.

Původní osobní sekce „kdo za tím stojí“ se nepoužívá. Trust sekce komunikuje závaznou cenu, kontrolu každého výtisku, foto před odesláním a Studio81 Labs jako odpovědného prodávajícího. Konkrétní maker, stroj ani soukromá dílna se nezobrazují.

## 4. Konfigurátor

Nejdůležitější obrazovka. Progresivní odkrývání na jedné stránce.

**Nahrání** → náhled s kótami, rozměry, objem, **hrubý odhad do 200 ms** s viditelným indikátorem, že se počítá přesná cena.

**Parametry každého `OrderItem` — přesně pět:** materiál, barva (jen dostupné), kvalita ve třech pojmenovaných stupních, výplň ve třech pojmenovaných stupních a počet kusů s variantami 1 / 5 / 20.

Mimo parametry je jeden samostatný příznak: **„díl musí do něčeho zapadnout / má lícované rozměry“**. Otevírá cestu ke zkušebnímu kusu nebo individuální nabídce.

### Zkušební kus a dávka

Ve v1 je zkušební kus vlastností **celé objednávky**. Lze jej zapnout jen
tehdy, když má každý zahrnutý `OrderItem` alespoň dva kusy; z každé položky
pak quote neměnně vyčlení jeden kus do sample fáze a všechny zbývající kusy
do batch fáze. Položku s jedním kusem, kombinaci `single` a `sample/batch`
ani vzorek jen pro část objednávky UI nepřijme a nabídne samostatnou
objednávku.

Souhrn před platbou ukáže odděleně sample a batch, jejich zásilky a zamčenou
cenu obou fází. Počáteční rezervace kapacity a materiálu kryje jen kompletní
sample plán; batch má do potvrzení fitu cenu zamčenou, ale fyzické zdroje
neblokuje.

Po doručení všech sample zásilek detail objednávky zobrazí stav **Čeká na
potvrzení celé sady**, konkrétní deadline odvozený z
`sample_confirmation_days` (aktuálně ⚠ 14 dní od doručení) a dvě rovnocenně
srozumitelné cesty:

-   **Potvrdit fit celé sady** --- cena se nemění, ale pokračování čeká na
    nový eligibility snapshot a atomickou rezervaci kapacity a materiálu pro
    celý batch. Pokud chybí, stav je **Čeká na kapacitu**.
-   **Nahrát revidovaný model** --- zákazník explicitně označí dotčené
    položky, projde nový preflight a slice a dostane novou cenu i dopravu pro
    celý zbývající batch. Zvýšení ceny vyžádá doplatek, snížení spustí
    vrácení rozdílu. Přijetí revize znovu čeká na kompletní atomickou batch
    rezervaci; do té doby je stav **Revize čeká na kapacitu**.

Fit nelze potvrdit jen pro část sady. Rozpracovaná či dosud nepřijatá revize
ani čekání na kapacitu nemažou deadline. Odmítnutí revize ukončí čekání
rovnou; jeho marné uplynutí udělá totéž automaticky. V obou případech se
zavřou otevřená platební okna, neaktivovaný batch se zruší, jeho nevyčerpaná
hodnota se vrátí a objednávka skončí jako částečně splněná; pozdní capture se
vždy plně kompenzuje. Prodloužení kvůli systémově nedostupné kapacitě musí
být výslovné, auditované a oznámené zákazníkovi.

Zakázáno: slider výplně, výběr trysky, teploty, styl podpěr, orientace.

**U kvality se zobrazuje přepočtená cena, ne procentní přirážka.** Procenta typu „+35 %" vracejí zrušený `koef_kvality` (log #51). Kvalita mění výšku vrstvy, tedy čas, a ten dává slicer přímo — celý smysl deterministického nacenění je v tom, že se nenásobí odhadem.

**Nálezy před tiskem** — nezaškrtnuté checkboxy, které musí zákazník aktivně potvrdit, max tři. Text v lidské řeči. Vizuálně klidné, ne alarmující. Když zákazník některý nález nepotvrdí, přímý flow se zastaví a nabídne přechod do poptávky s bezpečně předvyplněným kontextem.

**Cena** — položkový rozpad, celková částka vizuálně dominantní. Po slicingu zůstává výrobní mezisoučet i celková částka provizorní, dokud zákazník v checkoutu nevybere výdejní místo a nevznikne endpoint-bound `ShipmentPlan`. Přechod z orientační na závaznou cenu se zobrazí až po tomto výběru; to je celý produkt v jedné mikroanimaci.

## 5. Checkout a sledování

Checkout: výběr jednoho obsluhovaného výdejního místa nebo Z-BOXu pro celý `Order`, fakturační údaje (jméno nebo název, adresa a případné firemní údaje) a kontakt bez povinné registrace, přijetí aktuální verze VOP, výslovné potvrzení výjimky z odstoupení, samostatný nepovinný souhlas se zveřejněním fotografií a platba kartou i bankovním tlačítkem.

Sledování: tokenizovaná URL bez účtu, časová osa stavů v lidské řeči, **fotka hotového dílu k odsouhlasení před odesláním**, tracking, doklad.

**Ve sledování se neuvádí stroj ani obsluha** — viz identita §2.

## 6. Schválený aplikační a obsahový systém

### Public shell

Veřejné stránky používají plný header, navigaci `01 JAK TO FUNGUJE / 02 CENÍK / 03 UKÁZKY / 04 POTŘEBUJI MODEL`, CTA `NAHRÁT MODEL` a plný `TitleBlockFooter`.

### Application shell

Objednávkový flow používá:

`01 SOUBOR — 02 KONFIGURACE — 03 DOPRAVA — 04 PLATBA — 05 VÝROBA`

Desktop má stabilní dvousloupcovou geometrii:

- vlevo `--paper`: model, upload, diagnostika a rozhodnutí,
- vpravo persistentní `--surface`: stav souboru, konfigurace/cena, objednávka a summary.

Pravý sloupec se během uploadu a nacenění neodstraňuje; tím nevzniká layout shift.

Před cenou zobrazuje skutečný stav pipeline:

`Načtení souboru → Kontrola geometrie → Slicing a dráhy → Výpočet ceny`.

### Více položek v objednávce

Objednávka může obsahovat více samostatně konfigurovaných `OrderItem` z jednoho nebo více `ModelFile`. U souboru s více tělesy zákazník tělesa sdílející jednu konfiguraci seskupí do jednoho `OrderItem`, nebo je rozdělí do více samostatně konfigurovaných položek; jeden soubor ani jedno těleso proto automaticky neznamená jednu položku. Po konfiguraci se zobrazuje technický order summary a volby `Pokračovat k dopravě` / `+ Přidat další model`.

V headeru lze zobrazit kompaktní indikátor typu `OBJ. / 03 / 2 636 Kč`; nepoužívá se ikona košíku.

### Account shell

`Moje zakázky` je technický registr, ne datová tabulka/dashboard. Používá `ZÁZNAM`, `TV-XXXX`, `REV.`, stav, datum, počet položek a částku. Aktivní zakázka používá akcent.

Detail historické zakázky nabízí `Objednat znovu`. Akce vytvoří nový draft z podporované znovu použitelné konfigurace, vždy projde aktuálním slicem a ukáže novou závaznou cenu. Když zdrojový artefakt po retenční lhůtě chybí, místo automatické kopie se zobrazí výzva k novému nahrání; po něm se bezpečně předvyplní pouze znovu použitelná konfigurace.

### Footery

Public/content/legal používají plný výkresový title block. Konfigurátor, tracking a účet používají `CompactTitleBlockFooter`.

### Další stránky

Systém pokrývá také:

- Jak to funguje
- Ceník
- Ukázky + detail realizace
- Potřebuji model
- Kontakt
- VOP
- Reklamace
- Ochrana soukromí
- Přihlášení / aktivace účtu / základní nastavení

Legal stránky používají dokumentový template s revizí, účinností, obsahem a číslovanými sekcemi; technický jazyk nesmí zhoršit čitelnost.

## 7. Zakázané vzory

- ❌ obří stažený headline přes celou šířku
- ❌ tři stejné karty vedle sebe jako sekce „co nabízíme"
- ❌ generická marketingová sekce „01 02 03 04“ vydávající dekorativní číslování za obsah; **procesní navigace aplikace je naopak indexovaná záměrně**
- ❌ verzálkové proložené mikropopisky automaticky nad každou marketingovou sekcí; **technická metadata a stavové labely je používat mohou**
- ❌ vlasové linky jako jediný oddělovací prostředek
- ❌ „early access", odpočet, waitlist, badge s počty
- ❌ stock fotky tiskáren a 3D renderů
- ❌ tmavý režim jako výchozí
- ❌ ikony ozubených kol, raket, blesků

## 8. Předepsané vzory

- ✅ milimetrový rastr jako podkladová struktura, ne dekorace
- ✅ kótovací linky se šipkami u rozměrů
- ✅ mono číslice všude, kde je číslo
- ✅ řezy a osy místo ilustrací
- ✅ asymetrická sazba
- ✅ stavy řešené barvou a linkou, ne ikonami

## 9. Stavy, na které se zapomíná

Navrhnout výslovně: prázdný stav před nahráním; probíhající slicing s progresem; neopravitelný mesh s konkrétním důvodem; podezřelé měřítko s dotazem na jednotky; STEP se sestavou a výběrem těles; barva není skladem (nezobrazí se vůbec, ne šedě); expres není dostupný (volba se nezobrazí); mobil.

## 10. Opravy po první sadě mockupů

Body, které se v první iteraci rozešly se specifikací nebo s parametry:

| # | Nález | Oprava |
|---|---|---|
| 1 | **Vymyšlené kontaktní údaje** — jméno, IČO, adresa, telefon patřící neznámo komu | pouze skutečné údaje; v mockupu neškodné, v produkci žalovatelné, a placeholdery se přepisují do kódu nepovšimnuty |
| 2 | **Cena nesedí s ceníkem** — 42,8 g za 206 Kč je 4,81 Kč/g proti inzerovaným „od 3,40" | dopočítat tak, aby „od X Kč/g" odpovídalo nejlevnějšímu reálnému případu; zákazník si to vynásobí |
| 3 | **Chybí `min_print_price` a `small_order_surcharge`** | při 206 Kč tisku, 42,8 g a dopravě 85 Kč má být účet přibližně 394 Kč: 250 Kč minimum + 50 Kč přirážka + 85 Kč doprava + gross-up brány 1,5 % + 3 Kč; ne 206 Kč + doprava |
| 4 | **Procenta u kvality** (−18 % / +35 %) | zobrazit přepočtenou cenu, viz §4 |
| 5 | **Stroj ve sledování** („Stroj 2 — Prusa MK4") | „Tiskne se, odhad dokončení 15:20" |
| 6 | **Dvě primární barvy** — černá pro vybrané, modrá pro akci | sjednotit, viz identita §8 |
| 7 | **Expres jednou pevných +199 Kč, jinde ×2,0** | používat pouze `koef_express = ×2,0`; expres se zobrazí jen pro celý Order s jedinou `OrderPhase(kind = single)`, když všechny položky, podložky, materiály, barvy, post-processing a výrobní okno splní eligibility |
| 8 | **Rozpor u sestavy** — vpravo „cenu spočítáme, až bude soubor v pořádku", vlevo ceny u těles | jedno, nebo druhé |

## 11. Odevzdat

1. Landing, desktop i mobil
2. Konfigurátor ve všech stavech z §9, včetně multi-item objednávky
3. Checkout
4. Sledování zakázky včetně odsouhlasení fotky
5. Zákaznický archiv + login/aktivace účtu
6. Jak to funguje, Ceník, Ukázky + detail, Potřebuji model, Kontakt
7. VOP, Reklamace, Ochrana soukromí
8. Full a Compact title-block footer
9. Barevné a typografické tokeny jako proměnné

## 12. Kontrola před odevzdáním

Seznam v `taven-identita-v1.1.md` §9, plus:

- Je první akcí nahrání souboru? → musí být ano
- Sedí ceny na obrazovkách s `taven-parametry.md`? → musí být ano
- Prošel návrh seznamem z §7? → žádná položka

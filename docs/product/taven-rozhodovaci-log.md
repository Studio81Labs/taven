# Taven — rozhodovací log

**Append-only.** Záznamy se **nikdy needitují ani nemažou.** Když se rozhodnutí změní, přidá se nový záznam, který to staré ruší, a u starého se doplní jen odkaz „zrušeno #N".

Účelem není evidence rozhodnutí — ta je v specifikaci. Účelem je uchovat **důvody a zamítnuté alternativy**, protože právě ty se zapomínají první a právě kvůli nim se stejná debata otevírá podruhé.

---

| # | Rozhodnutí | Zdůvodnění | Zamítnutá alternativa | Stav |
|---|---|---|---|---|
| 1 | Služba-first, síť později | vlastní nevyužitá tiskárna je skutečný problém; poptávka neexistuje | platforma-first | platí |
| 2 | Platforma je prodávající, ne zprostředkovatel | jinak nemá nástroj na vynucení kvality a zákazník nemá koho žalovat | marketplace / zprostředkovatel | platí |
| 3 | Cenu stanoví platforma, maker jen přijme/nepřijme | aukce = závod ke dnu v kvalitě a nekonzistentní zkušenost | aukční model | platí |
| 4 | Zůstat neplátcem DPH | jednodušší procesing, cenová výhoda v B2C | plátcovství od začátku | platí |
| 5 | Dvoufázový slicing (referenční / strojový) | slicovat každý model × každý stroj při poptávce je kombinatorický nesmysl | jednofázový | platí |
| 6 | OrcaSlicer CLI v Dockeru | jedna binárka pokryje Bambu i Prusu, vendorem udržované profily, umí `.gcode.3mf` i paint 3MF | PrusaSlicer CLI (nepokrývá Bambu formát), CuraEngine (ruční profily) | platí |
| 7 | Cena z referenčního slice, výplata pevná | rychlejší stroj vydělá víc za hodinu → tlačí síť k lepšímu hardwaru sama | cena podle konkrétního stroje | platí |
| 8 | Barva jako filtr způsobilosti; nedostupná se skryje | neprosakuje stav sítě do zákaznického rozhraní | zobrazovat NA / delay | platí |
| 9 | Slicovat podložku, ne díl | čas na kus není lineární — drobný díl sám tiskne pomalu kvůli minimálnímu času vrstvy | `cena_1ks × qty` | platí |
| 10 | **Podmíněně závazná cena** | trh se naučil závaznost nevydávat, protože auto-nacenění bývá špatné; závazné jen v mezích, kde stroj ví, co dělá | závazná na všechno / jen orientační jako konkurence | platí |
| 11 | AI jen jako jednosměrné veto | nejhorší selhání je pak falešný poplach, nikdy špatná závazná cena | AI rozhoduje o způsobilosti oběma směry | platí |
| 12 | AI odložena za validaci | architektonické pravidlo drží prostor, `ai-worker` se staví až bude co optimalizovat | `ai-worker` v v1 | platí |
| 13 | Multicolor jednoho dílu jako individuální nabídka | odpad při purge je funkcí stroje, ne modelu → rozbíjelo by to invariant „cena z referenčního slice"; bez automatické ceny není co rozbít | automatické nacenění multicoloru | platí |
| 14 | Nestavět malovátko barev, přijmout 3MF s paint daty | měsíce práce vs. dny; cílovka Bambu Studio nebo Orca už používá | browserový color painter | platí |
| 15 | Individuální nabídka jako jedna obecná úniková cesta | jedna feature pokryje šest případů včetně zákazníků bez souboru | zvláštní cesta pro každý případ | platí |
| 16 | Platba 100 % předem u automatické nabídky | díl na míru je jinak odpad; záloha znamená dvě platby a vymáhání doplatku | záloha u všech objednávek | platí |
| 17 | Certifikace zdarma místo výdělkové rampy bez IČO | soustavnost se posuzuje podle vzorce chování a úmyslu; rampa riziko nesnižuje dost | 3 zakázky / 8 000 Kč bez IČO | platí |
| 18 | Transparentní rozpad ceny | konzistentní se způsobem, jak jsou stavěné ostatní projekty; zákazník vidí tisk, dopravu i slevu zvlášť | doprava zabalená v ceně jako u konkurence | platí |
| 19 | Práh dopravy zdarma ~1 000 Kč, ne 5 000 | práh, kterého nikdo nedosáhne, je dekorace; smyslem je, aby si člověk s objednávkou za 900 přihodil | vysoký práh | platí |
| 20 | Express = předběhnutí fronty, ne kurýr | žádné nové náklady, zpeněžuje volnou kapacitu; kurýr by omezil na Brno a okolí | expresní doprava | platí |
| 21 | Kapacitní brána expresu měří **zásahy obsluhy**, ne hodiny | jeden dvacetihodinový tisk přes noc je v pořádku, pět čtyřhodinových podložek ne | brána podle hodin tisku | platí |
| 22 | Hodnotový strop automatu | prémie za bezbariérovost funguje na malých objednávkách; riziko se kryje — špatně naceněná malá zakázka stojí padesátikorunu, velká tisíce | automat na jakoukoli částku | platí |
| 23 | Node scope na dotazech od prvního dne | zpětné zavedení multi-tenancy není přidání sloupce, ale audit každého query | jednouživatelský admin | platí |
| 24 | Makerské UI uvnitř administrace, datový šev zachován | samostatný portál je práce bez uživatele; přesun obrazovek je levný, přepis datové vrstvy ne | samostatná `/maker` aplikace hned | platí |
| 25 | Sledování přes tokenizovanou URL bez účtu | registrace u jednorázové objednávky je překážka v nejcitlivějším místě trychtýře | uživatelské účty | platí |
| 26 | Pevný stavový automat, konfigurovatelné jen politiky | obecný workflow engine stojí násobek a nikdy se nepoužije jinak než jedním způsobem | konfigurovatelné přechody | platí |
| 27 | ~~Amortizace nevstupuje do ceny, sleduje se bokem~~ | — | — | **zrušeno #33** |
| 28 | Jedno jméno pro obě fáze, žádný rebranding | rebranding zahodí vybudované SEO, což je deklarovaný kanál | solo značka → přejmenování na síť | platí |
| 29 | Validace obsahuje celý automatický quote | landing s formulářem by validoval obecnou poptávku po tisku, kterou obsluhuje dvacet firem — ne diferenciaci | landing + poptávkový formulář jako v0 | platí |
| 30 | Contribution margin místo hrubé marže, CAC zvlášť | 30% hrubá marže může vypadat dobře, zatímco každá objednávka pálí peníze | hrubá marže | platí |
| 31 | Kill criterion má strop na reklamní spend | 10 objednávek za 20 000 Kč není validace | jen počet objednávek | platí |
| 32 | Síť je výsledek rozhodovací brány, ne v2 | síť řeší kapacitní problém; když ho nemáš, neřeší nic. Druhý stroj je výchozí varianta | síť jako automatické pokračování | platí |
| 33 | **Amortizace jako parametr s explicitní dobou návratnosti** (`cena stroje / návratnost v h`) | dělá z předpokladu číselník místo skryté volby; v0 a hobby režim = ∞, tedy 0 Kč/h; při rozhodování o 2. stroji se přepne na reálnou hodnotu | ruší #27 | platí |
| 34 | **Marže se aplikuje na celý výrobní náklad, ne na cenu materiálu** | model z Prusa blogu počítá marži jako 30 % z materiálu — u téže práce vyjde marže 1 Kč u levného PLA a 393 Kč u karbonu; tvoje riziko a čas s cívkou nesouvisejí | marže z ceny materiálu | platí |
| 35 | **Sazba práce 300 Kč/h — operátorská, ne vývojářská** | byznys zpeněžuje stojící stroj a poloprázdný večer; při vývojářské sazbě je model ztrátový. Benchmark: co by stál brigádník. Test poctivosti: přežije to, až to nebudeš dělat ty? | vlastní čas jako „zadarmo" nebo za vývojářskou sazbu | platí |
| 36 | **Handling se měří ze stavového automatu, ne stopkami** | časová razítka přechodů `accepted→printing→printed→packed→handed_over` dají handling z prvních ~20 reálných zakázek; měření nemusí předcházet spuštění, jen verdiktu | stopky a měření před spuštěním | **zrušeno #60** |
| 37 | **Provoz a validace jsou dva oddělené režimy** | při 1 zakázce měsíčně nezměříš FPY, konverzi po pásmech ani podíl souborů v automatu; nesměšovat, jinak vznikne rok „nějak to funguje" bez jediného čísla | jeden režim s průběžnou validací | platí |
| 38 | **Fixní náklady v idle téměř nulové** | hobby režim je přijatelný koncový stav, takže musí být bezúdržbový; projekt nezabije rozhodnutí, ale otrávenost z měsíčních nákladů bez odezvy | optimalizovat jen procenta z transakcí | platí |
| 39 | **Platební brána bez měsíčního paušálu** | při 1–2 objednávkách měsíčně sežere paušál 200 Kč marži ze dvou zakázek; ruší dřívější doporučení Comgate podle procent | brána vybraná podle transakčních procent | platí |
| 40 | **Risk checkboxy nezaškrtnuté** | explicitní acknowledgement je silnější produktově i právně, a právě o ten argument při reklamaci jde | předzaškrtnuté jako u PCBWay | platí |
| 41 | **Zkušební kus jako fáze objednávky, ne e-mailová domluva** | trh iteraci běžně dělá, ale e-mailem přes 4–6 zpráv; u nás je to stav v objednávce se zamčenou cenou obou fází | nová poptávka pro dávku | platí |
| 42 | **Slibujeme věrnost modelu, ne lícování** | zákaznické modely bývají laděné empiricky na jiné tiskárně a nesou skrytou kompenzaci — přesnější tisk je pak fitově horší. Konkrétní podoba rozdělení „vada tisku vs. vada modelu" | garance lícování | platí |
| 43 | **STEP jako univerzální vstup** | neutrální formát, exportuje ho každý, nezavazuje k ekosystému; nativní formáty s historií dospecifikovat, až je zákazníci budou umět dodat | vyžadovat nativní CAD formáty | platí |
| 44 | **Ceník, specifikace a log jako tři oddělené artefakty** | jednorázový osmdesátistránkový dokument se přestane udržovat, když se v něm mění cena filamentu; různá frekvence změn = různé soubory | jeden živý dokument | platí |
| 45 | **Roadmapa spouštěči, ne termíny** | datum ve firmě o jednom člověku s kolísavou kapacitou nikdy nesedí a nutí ho posouvat | kvartální roadmapa | platí |
| 46 | **Revize dokumentace se spouští událostí, ne kalendářem** | při 12 objednávkách ročně nemá měsíční revize co revidovat; hodina nad specifikací musí něco vrátit | pravidelná měsíční revize | platí |

---

## Nezapsaná, ale platná pravidla

Věci, které nejsou rozhodnutím o produktu, ale o tom, jak se rozhoduje:

**Test návratnosti featury.** Featura, která ušetří 5 minut na objednávce, ušetří při 1–2 objednávkách měsíčně **12 Kč měsíčně**. Cokoli nad jeden večer práce se při tom objemu nikdy nevrátí. Při 30 objednávkách měsíčně ušetří tatáž featura 375 Kč a týden práce se zaplatí. **Stejná featura má podle režimu dvacetipětinásobně jinou hodnotu** — přepočítej ji proti aktuálnímu objemu, ne proti tomu, ve který doufáš.

Výjimka: cokoli, co snižuje fixní náklady nebo tření natolik, že provoz zůstane bezúdržbový, se staví vždy (viz #38).

**Známé riziko projektu.** Spadl už jednou pod stůl (leden 2026) kvůli kapacitě, ve prospěch jednodušších věcí ve frontě. Nebylo to špatné rozhodnutí — byla to absence pravidla. Test výše to pravidlo dodává.

---

## Doplněno po revizi v1.2 → v1.3

| # | Rozhodnutí | Zdůvodnění | Zamítnutá alternativa | Stav |
|---|---|---|---|---|
| 47 | **Handling rozložen na komponenty před měřením** (`order_fix`, `plate`, `piece`, `pack`, `shipping_trip`, `postprocessing`) | jedno číslo „30 min" směšuje aktivní práci, práci na podložku a logistickou cestu; po 20 objednávkách bys věděl, že handling je 23 minut, ale ne co z toho jde batchovat | jeden souhrnný `handling_fix` | platí |
| 48 | **`shipping_trip` se při nízkém objemu nealokuje** | jedna cesta na jednu zásilku znamená plný náklad; handling na objednávku je v hobby režimu horší, ne lepší. Alokace začne fungovat od několika zásilek týdně | alokovat cestu vždy | platí |
| 49 | **`poplatek_priprava` → `small_order_surcharge`** | příprava je už v `cena_tisku` přes `handling`; původní název tvrdil zákazníkovi opak a účetně to bylo dvojí účtování | ponechat název | platí |
| 50 | **`min_print_price` se vztahuje na `cena_tisku`, ne na částku u pokladny** | bez explicitní definice se „minimální objednávka 250 Kč" za rok přečte jako nejnižší možný účet, přičemž checkout floor je 335–385 Kč | nedefinovat | platí |
| 51 | **`koef_kvality` zrušen; čas se bere ze skutečného slice** | slicer řekne 6 h 12 min přesně; násobit to ručním koeficientem znamená zahodit výhodu deterministické ceny. Obchodní přirážka smí existovat, ale musí se tak jmenovat a stát vedle času | koeficient nad strojovým časem | platí |
| 52 | **Referenční profily per materiál × kvalita, ne jeden generický PLA** | PETG má jiné rychlosti a teploty; nacenit ho podle PLA slice je systematicky vedle. Invariant zní „nezávislý na stroji", ne „nezávislý na materiálu". Slicuje se líně, až pro zvolenou kombinaci | jeden globální referenční profil | ruší část #7 |
| 53 | **Ve v0 slicer-native arrange, ne vlastní packing engine** | Orca má vlastní arrangement; psát k němu paralelní 2D packing je práce navíc bez odpovídajícího přínosu. Princip „slicuj podložku" zůstává, implementace se zjednodušuje | vlastní 2D packing v v0 | platí |
| 54 | **STEP není blocker vydání v0** | přináší tesselaci s deterministickou tolerancí, jednotky, sestavy, náhled a novou plochu na selhání; úkolem v0 je ověřit instant quote, ne pokrýt formáty | STEP jako součást v0 | platí |
| 55 | **Kampaň měří „first-order profitable", ne „valid / invalid"** | byznys s CM 120 Kč, CAC 170 Kč a třetinovou opakovaností je zdravý, jen se nezaplatí z první objednávky; binární brána by ho zabila | binární brána `CAC ≤ CM` | zpřesňuje #31 |
| 56 | **Opakovanost je hlavní otázkou placené akvizice, ne celého projektu** | může vyjít vysoký podíl organiky, drahý CAC, nízká opakovanost, zdravá CM — a stroj se přesto vytěžuje. Pro cíl „zpeněžit nevyužitou H2S" je to platný výsledek | opakovanost jako hlavní otázka projektu | platí |
| 57 | **Báze pro `rezerva_pretisk` definovaná explicitně** — `material + machine + handling_plate + handling_piece + postprocessing` | „5 % variabilního nákladu" si každý implementátor vyloží jinak; položky, které se při přetisku chyceném doma neopakují (`order_fix`, `pack`, `shipping_trip`), do báze nepatří. Odmítnutí po doručení kryté není a sedí zatím v marži | volná formulace „z variabilního nákladu" | **zrušeno #59** |
| 58 | **Spouštěč `small_order_surcharge` podle gramáže je prozatímní** | gramáž je proxy převzatá z trhu, ale materiál tvoří jen malou část nákladu; pravděpodobnějším spouštěčem je `cena_tisku < X` nebo `handling / cena_tisku > Y`. Pro v0 zůstává 100 g a sleduje se jako metrika | fixovat 100 g jako strukturu | platí |
| 59 | **`rezerva_pretisk` používá peněžní `handling_pretisk` se stejnými násobnostmi jako hlavní handling** | původní báze sčítala časové parametry přímo s Kč a vynechávala počty podložek a kusů; správně se opakovaná práce nejdřív ocení `sazba_prace_h` | sčítat neoceněné délky s peněžními náklady | ruší #57 |
| 60 | **Aktivní handling se měří přes `HandlingSession`, stavové časy jen průchod procesu** | interval mezi stavy obsahuje tisk, frontu, čekání i dopravu a není pracovním časem; timer nebo strukturovaný ruční zápis zachová komponentu i jmenovatele pro dávky | odvozovat práci z rozdílu stavových časů | ruší #36 |
| 61 | **Expresní příplatek stojí odděleně od `cena_tisku_zaklad`** | práh dopravy zdarma se musí vyhodnotit před expresním příplatkem, jinak si zákazník koupí dopravu zdarma připlacením za rychlost | aplikovat `koef_express` před vyhodnocením prahu dopravy | platí |
| 62 | **Cache slice je vždy klíčovaná i obsazeností podložky** (`parts_per_plate`) | čas a materiál jednoho kusu se liší od plné podložky; bez obsazenosti by cache mohla vrátit jinou závaznou cenu | klíč jen soubor + profil | platí |
| 63 | **Přetisk vzniká jako nový navázaný `Job`, ne návrat stavu původního** | terminální `failed` / `qc_rejected` zachová FPY a audit; `replaces_job_id` dovolí dokončit zaplacenou objednávku bez přepsání historie | vracet tentýž job do `printing` | platí |
| 64 | **Fulfilment a platby mají oddělené stavy; storno je explicitní větev před odesláním** | individuální nabídka má zálohu a doplatek, takže jediný stav `paid` neumí popsat start výroby ani refundaci; odvozený `payment_status` drží účetní pravdu | jeden platební stav na objednávce | platí |
| 65 | **Fázovaná objednávka má `OrderPhase` a více zásilek** | vzorek musí být doručen a potvrzen před výrobou dávky; jedna zásilka na objednávku tento flow neumí reprezentovat ani ocenit | jedna zásilka nebo dvě nesouvisející objednávky | zpřesňuje #41 |
| 66 | **Platby jsou kolekce transakcí s rolemi `full` / `deposit` / `balance`** | záloha a doplatek musí jít samostatně spárovat, refundovat a auditovat; jeden sloupec na objednávce ztrácí historii i částečné stavy | jedna platba na objednávku | zpřesňuje #16 |
| 67 | **Doprava, obal a balicí práce se sčítají přes všechny plánované zásilky** | sample a batch odcházejí v jiný čas; jedna sazba by zamčenou cenu i CM systematicky podhodnotila | účtovat jednu zásilku na objednávku | zpřesňuje #65 |
| 68 | **Revize modelu po sample vytváří `OrderRevision` a novou cenu batch fáze** | změna geometrie může změnit materiál, čas, obsazenost podložky i dopravu; původní závazná cena platí jen pro původní model | tisknout revidovaný model za původní cenu | zpřesňuje #41 |
| 69 | **Poslední fáze řídí všechny mezistavy agregátní objednávky** | sample shipment je dílčí, ale batch musí vyvolat `qc_passed → ready_to_ship → shipped → delivered`; přímý skok by porušil pevnou topologii a audit | skok `in_production → delivered` | zpřesňuje #26 a #65 |
| 70 | **`ReferenceProfile` a `MachineProfile` jsou oddělené entity i verze** | zákaznická cena musí být nezávislá na stroji, produkční G-code naopak konkrétní model a trysku potřebuje; společná matice by nechala ceny driftovat mezi stroji | jeden typ profilu pro quote i výrobu | zpřesňuje #52 |
| 71 | **`SliceResult` klíč obsahuje i `profile_kind`** | reference a machine profily mají oddělené tabulky a mohou mít stejná lokální čísla verzí; bez typu by se jejich cache klíče mohly srazit | společný neoznačený `profile_version` | **zrušeno #72** |
| 72 | **Cache používá globálně unikátní profile/calibration revision ID** | dva kusy stejného modelu mohou mít jiné flow a XY kompenzace a dvě tabulky stejná lokální čísla verzí; immutable revision ID zabrání oběma kolizím a job je snapshotuje | typ + lokální číslo verze nebo cache jen podle `MachineProfile` | ruší #71, zpřesňuje #70 |
| 73 | **Reklamace je samostatný `Claim`, ne zpětný přechod objednávky** | záruka může být uplatněná po `completed`; přepis terminálního fulfilment stavu by kazil historii a provozní metriky | nechat objednávky navždy `delivered` nebo vracet `completed → disputed` | platí |
| 74 | **Sample-only výsledek končí jako `partially_fulfilled`** | odmítnutá revize ponechá dodaný vzorek a refunduje jen nečerpaný batch; není to ani úplné `completed`, ani úplné `refunded` | nechat objednávku viset v `in_production` | zpřesňuje #64, #65 a #68 |
| 75 | **`ShipmentPlan` dimenzuje celé množství podle objemu i hmotnosti** | 20 jednotlivě malých dílů může překročit krabici nebo hmotnost; závazná cena musí znát počet balíků před checkoutem | kategorie jen z bbox největšího dílu | zpřesňuje #67 |
| 76 | **Slice cache klíčuje kanonický `ModelGeometry`, ne celý upload** | dvě tělesa jednoho STEP souboru mají stejný file hash, ale jiný čas, materiál i bbox; extrahovaná geometrie dává každému `OrderItem` vlastní bezpečný klíč | `sha256(ModelFile)` pro všechny vybrané části | zpřesňuje #62 |
| 77 | **Zvýšení ceny revize se platí před aktivací batch** | přijetí cenového rozdílu bez capture by pustilo dražší výrobu proti původní záloze; `revision_amount_due = 0` zachová předplacení změny | doplatek revize až před odesláním | zpřesňuje #16 a #68 |
| 78 | **Paleta je union inventáře jen společně způsobilých strojů** | barva na stroji, který nesplní objem, profil, trysku nebo tier, není pro danou zakázku dostupná; globální union by prodal nevyrobitelnou kombinaci | globální union všech barev v síti | zpřesňuje #8 |
| 79 | **Selhání batch po doručeném sample se vypořádá po fázi** | vzorek byl dodaný a spotřebovaný, takže plná refundace objednávky je chybná; bez náhradního jobu se batch zruší a agregát skončí `partially_fulfilled` | vždy `cancelled → refunded` celé objednávky | zpřesňuje #63 a #74 |
| 80 | **`rezerva_pretisk` zahrnuje opakovanou amortizaci** | zmetek spotřebuje životnost stroje stejně jako úspěšný tisk; při nenulové amortizaci by jinak cena neunesla druhý stroj ani síťovou ekonomiku | rezervovat jen materiál, variabilní stroj a práci | zpřesňuje #59 |
| 81 | **Odeslání hlídá zůstatky aktuálního cenového snapshotu, ne název platebního stavu** | snížení ceny může po vrácení přeplatku legitimně nechat `payment_status = partially_refunded`; nuly `amount_due` a `refundable_balance` dokazují, že není co vybrat ani vrátit | vyžadovat vždy `payment_status = paid` | zpřesňuje #64, #68 a #77 |
| 82 | **Cenová podlaha zahrnuje dotovanou dopravu před marží a hrubuje poplatek brány** | doprava zdarma ani procentní/fixní poplatek nesmějí změnit nominálně maržovou objednávku na zápornou CM; práh se vyhodnotí před subvencí, aby se nekvalifikovala sama | odečíst dopravu a bránu až při reportingu CM | zpřesňuje #19, #34, #61 a #67 |
| 83 | **Jedna retence platí pro všechny zdrojové formáty `ModelFile`** | 3MF a zvlášť STEP mohou nést přinejmenším stejně citlivá data jako STL; přípona nesmí rozhodovat, zda se upload někdy smaže | plánovat mazání jen pro STL | platí |
| 84 | **Způsobilost i rezervace inventáře jsou gramážové, ne booleovské** | přítomnost barvy neznamená dost materiálu pro celou dávku; `available_g` odečítá aktivní rezervace a capture smí začít až po atomické rezervaci `required_material_g` na jednom uzlu; další maker ji musí převzít před nabídkou jobu | filtrovat jen podle přítomnosti barvy a rezervovat až po platbě | zpřesňuje #78 |
| 85 | **Minimální reprodukční artefakt se drží nejméně do `claim_until`** | zdrojový CAD lze po 90 dnech smazat, ale claim v podporované lhůtě musí stále umět vytvořit shodný náhradní job z kanonické geometrie a immutable slice vstupů | držet celý zdroj do konce claimů nebo po 90 dnech ponechat jen nereprodukovatelný hash | zpřesňuje #73 a #83 |
| 86 | **Osobní odběr není bez vlastního privacy-preserving workflow součástí ekonomiky** | navržený checkout posílá přes dopravce a maker zákazníka nevidí; geografickou úsporu proto nelze započíst do síťové brány dřív, než existuje anonymizované předání | přičíst síti ~105 Kč úspory bez implementovaného procesu | zpřesňuje #32 |
| 87 | **Každý náhradní job potřebuje novou produkční rezervaci** | materiál původního pokusu je po přijetí jobu spotřeba a jeho kapacita proběhla; `ReplacementRequest` drží recovery povinnost, ale job vznikne až s čerstvou gramáží a intervaly | znovu použít spotřebovanou rezervaci původního jobu | zpřesňuje #63, #73 a #84 |
| 88 | **Revize batch vždy znovu ověřuje a nahrazuje produkční rezervaci** | nižší cena nemusí znamenat méně materiálu ani kratší strojový čas; aktivace závisí na čerstvé gramáži a kapacitě nezávisle na tom, zda vznikl doplatek | revalidovat jen zdraženou revizi před capture | zpřesňuje #68 a #77 |
| 89 | **`ProductionReservation` atomicky spojuje materiál i strojové intervaly** | dost filamentu nebrání dvěma souběžným checkoutům slíbit tentýž termín jednoho stroje; oba zdroje se musí zamknout, držet, převádět i uvolnit jako jeden celek | rezervovat před platbou jen inventář | zpřesňuje #21 a #84 |

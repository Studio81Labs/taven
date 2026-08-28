# Taven --- maker economics a settlement v0.1

**Status:** gate-scoped produktová baseline; rozhodnutí zapsána v
`taven-rozhodovaci-log.md` #177–#179, #181 a #183–#198; aktivace až po kapacitní
bráně v `taven-specifikace-v1.3.md` §11\
**Datum:** 2026-08-28

## 1. Účel

Tento dokument definuje ekonomický a doménový vztah mezi:

-   zákazníkem,
-   provozovatelem služby Taven --- **Studio81 Labs, s.r.o.**,
-   makerem, který fyzicky zajišťuje výrobu.

Model není součástí implementačního scope v0. Aktivuje se až tehdy, když
kapacitní brána v `taven-specifikace-v1.3.md` §11 rozhodne pro externího
makera nebo síť. V0 zůstává na jediném vlastním stroji, ručním provozu a
účetním vypořádání mimo produktový maker subsystém; tento dokument
definuje budoucí smluvní a ekonomický vztah předem.

Základní princip:

> **Studio81 Labs prodává zákazníkovi službu. Maker prodává Studio81
> Labs výrobní plnění.**

Taven není zprostředkovatel mezi zákazníkem a makerem.

------------------------------------------------------------------------

## 2. Role a odpovědnost

### 2.1 Studio81 Labs / Taven

Studio81 Labs je vůči zákazníkovi prodávající a odpovědný provozovatel
služby.

Zajišťuje zejména:

-   zákaznickou objednávku,
-   stanovení zákaznické ceny,
-   přijetí platby,
-   vystavení zákaznického dokladu,
-   komunikaci se zákazníkem,
-   reklamace a refundace,
-   komunikaci s dopravci,
-   přepravní štítky a tracking,
-   routing výrobních zakázek,
-   kontrolu pravidel sítě,
-   finanční vypořádání s makery.

Zákazník neuzavírá smluvní vztah s makerem a v zákaznickém rozhraní
nevidí jeho identitu, stroj ani neveřejné místo výroby.

### 2.2 Maker

Maker je samostatný dodavatel výrobní služby pro Studio81 Labs.

Maker:

-   přijímá nebo odmítá nabídnuté výrobní joby,
-   vyrábí podle závazných výrobních podkladů Tavenu,
-   provádí předepsanou kontrolu,
-   připravuje zásilku podle provozních pravidel,
-   předává zásilku do logistického procesu,
-   získává za dokončené výrobní plnění předem známou odměnu.

Prvním `Maker` v systému je až externí dodavatel přijatý po kapacitní
bráně. Provozovatel vlastního stroje ve v0 se pouze kvůli dogfoodingu
nemodeluje jako `Maker` a nevzniká mu produktový compensation,
settlement ani payout workflow.

------------------------------------------------------------------------

## 3. Oddělení zákaznické ceny a maker compensation

Zákaznická cena a odměna makera jsou dvě nezávislé cenové domény.

### Customer price

Je cena, za kterou Studio81 Labs prodává službu zákazníkovi.

Vychází z pravidel zákaznického pricingu, například:

-   referenční slicing,
-   materiál,
-   výrobní čas,
-   handling,
-   obchodní minimum,
-   surcharge,
-   množstevní sleva,
-   doprava,
-   express,
-   marže.

### Maker compensation

Je cena výrobního plnění, které maker poskytuje Studio81 Labs.

Nesmí být definována jako:

`customer_price × pevné procento`

ani jako:

`zůstatek zákaznické ceny po odečtení provize`.

Platí:

> **Customer price určuje ekonomiku prodeje zákazníkovi. Maker
> compensation určuje ekonomiku nákupu výrobní kapacity.**

Rozdíl mezi zákaznickou cenou a náklady včetně maker compensation tvoří
ekonomiku Studio81 Labs.

------------------------------------------------------------------------

## 4. Maker compensation

### 4.1 Základ

Odměna za job se vypočítá podle verzované `MakerCompensationPolicy`.

Konceptuálně:

``` text
maker_compensation =
    production_base
  × performance_modifier
  + explicit_surcharges
  + approved_adjustments
```

Přesná struktura `production_base` je konfigurovatelná a verzovaná.

Může zohledňovat zejména:

-   materiál,
-   výrobní čas,
-   počet podložek,
-   aktivní handling,
-   post-processing,
-   náročnost předání,
-   specifické výrobní požadavky.

Maker compensation nesmí být ručně určována podle toho, kolik prostředků
chce Studio81 Labs vyplatit konkrétnímu makerovi.

### 4.2 Compensation snapshot

Před přijetím jobu maker vidí minimálně:

-   identifikátor jobu,
-   materiál,
-   barvu,
-   očekávaný výrobní čas,
-   počet podložek,
-   deadline / SLA,
-   požadované výrobní operace,
-   **maker compensation**.

Přijetím jobu se vytvoří immutable snapshot:

`MakerCompensationSnapshot`

Acceptance příkaz je idempotentní podle `production_assignment_id`; při
souběhu ani retry nesmí vzniknout více než jeden snapshot a příkaz vždy
vrátí tentýž zamčený výsledek.

Kompozitní reference `(production_assignment_id, maker_id)` vyžaduje makera
skutečně přijatého assignmentu ještě před výpočtem a zamknutím odměny;
neshoda proto nemůže vytvořit snapshot ani změnit
`Job.(payout_amount, payout_currency)`.

Přijetí současně zamkne `Job` i všechny jeho assignmenty a vyžaduje, aby
dosud žádný neměl `accepted_at`. Částečný unikátní constraint nad `job_id`
pro přijaté assignmenty dovolí právě jedno přijetí v celé historii jobu;
pozdní acceptance starého offeru proto skončí konfliktem, uzavře se a
nevytvoří snapshot ani `Job.(payout_amount, payout_currency)`.

Snapshot obsahuje minimálně:

-   `production_assignment_id`,
-   `maker_id`,
-   `policy_version`,
-   vstupní výrobní parametry,
-   `base_compensation`,
-   `performance_snapshot_id`,
-   `performance_modifier`,
-   explicitní surcharge/adjustments,
-   `currency`,
-   `agreed_compensation`,
-   `claim_hold_policy_version`,
-   `maker_claim_hold_days`,
-   timestamp přijetí.

`performance_snapshot_id` odkazuje přesné immutable metriky, ze kterých byl
modifier odvozen. Pozdější změna performance score nebo compensation policy
nesmí zpětně změnit odměnu již přijatého jobu.

Kompozitní reference `(performance_snapshot_id, maker_id)` navíc vyžaduje
performance snapshot stejného makera a acceptance ověří, že jeho
`resulting_modifier` je totožný s uloženým `performance_modifier`.

U přijatého externího maker-owned assignmentu zapíše acceptance transakce
tutéž částku a měnu současně jako
`MakerCompensationSnapshot.(agreed_compensation, currency)` a
`Job.(payout_amount, payout_currency)`; nejde o dvě cenové veličiny. Offer a
routing pracují s budoucí agreed compensation v této měně a přijetí odmítne
jakoukoli neshodu. Settlement pak čte immutable snapshot, jehož částka i měna
se rovnají jobovým polím. Post-gate job na platform-owned fallbacku si dál
ukládá interní `Job.payout_amount` a `Job.payout_currency`, ale bez
`ProductionAssignment`, compensation snapshotu nebo maker settlementu.

------------------------------------------------------------------------

## 5. Performance modifier

### 5.1 Princip

Taven může spolehlivější makery motivovat lepšími ekonomickými
podmínkami.

Performance modifier není nástroj pro arbitrární penalizaci.

Výchozí model:

> **base compensation + bonus za nadstandardní výkon**

Preferovaný rozsah je například:

`1.00–1.15`

nikoli široký penalizační rozsah typu `0.70–1.20`.

Maker, který dlouhodobě nesplňuje minimální standard, se řeší primárně:

1.  nižší routing prioritou,
2.  remediation / probation,
3.  dočasným pozastavením node,
4.  případně ukončením spolupráce.

Ne systematickým snižováním odměny pod ekonomicky obhajitelnou základní
sazbu.

### 5.2 Sledované metriky

Performance se nesmí ukládat pouze jako jeden neprůhledný rating.

Systém uchovává jednotlivé metriky, například:

-   `first_pass_yield`,
-   `maker_caused_reprint_rate`,
-   `claim_rate`,
-   `maker_caused_claim_rate`,
-   `on_time_rate`,
-   `handoff_delay`,
-   `acceptance_rate`,
-   `response_time`.

Metriky musí mít definovaný denominator a minimální velikost vzorku.

### 5.3 Příklad policy

``` text
MakerCompensationPolicy v3

base_multiplier = 1.00

quality_bonus:
  FPY >= 99.5 %                    +0.05

fulfilment_bonus:
  on_time_rate >= 98 %             +0.03

claim_bonus:
  maker_caused_claim_rate <= 0.5 % +0.02

max_multiplier = 1.10
```

Konkrétní hranice jsou parametry, nikoli invarianty specifikace.

------------------------------------------------------------------------

## 6. Routing a ekonomická hodnota makera

Performance modifier a routing priority jsou dvě oddělené páky.

Příklad:

  Maker     Compensation       Kvalita      Včasnost Routing
  ------- -------------- ------------- ------------- ---------------------
  A                vyšší        vysoká        vysoká vysoká priorita
  B             základní        vysoká      průměrná standardní
  C             základní   pod limitem   pod limitem probation / suspend

Routing nemá optimalizovat pouze nejnižší maker compensation.

Budoucí routing může pracovat s očekávaným fulfilment cost:

``` text
expected_fulfilment_cost =
    maker_compensation
  + expected_claim_cost
  + expected_reprint_cost
  + expected_delay_cost
  + logistics_effect
```

Maker s vyšší nominální odměnou může být pro Studio81 Labs ekonomicky
výhodnější, pokud má nižší zmetkovitost, méně reklamací a spolehlivější
handoff.

------------------------------------------------------------------------

## 7. Settlement a payout

### 7.1 Terminologie

Tyto pojmy se nesmějí zaměňovat:

-   **Maker compensation** --- ekonomická cena konkrétního výrobního
    plnění.
-   **Maker settlement** --- souhrn uznaných plnění a úprav za období.
-   **Maker payout** --- skutečný finanční převod makerovi.

### 7.2 Settlement

`MakerSettlement` obsahuje například:

-   `maker_id`,
-   settlement period,
-   immutable řádky dokončených a uznaných assignments,
-   gross compensation,
-   approved adjustments,
-   deductions pouze podle explicitních pravidel,
-   payable amount,
-   settlement status.

Při přijetí assignmentu se do compensation snapshotu uloží také
`order_claim_policy_version` přijatá zákazníkem a z ní odvozená
`maker_claim_hold_days` --- podle aktuálních parametrů 7 dní, nikdy však
kratší než zákaznické okno této verze. `payout_eligible_at` se jednou a
neměnně nastaví prostřednictvím právě jedné ze dvou vzájemně výlučných cest:

-   po doručení s `payout_eligibility_basis = delivered_claim_window` jako
    maximum `delivered_at + maker_claim_hold_days` a všech `claim_until`
    slotů plněných assignmentem,
-   bez doručení s
    `payout_eligibility_basis = non_maker_handoff_incident` teprve poté, co
    existuje ověřené předání zásilky dopravci, incident skončil terminálním
    refund/replacement rozhodnutím a jeho konečné zavinění je
    `non_maker_caused`; tehdy se rovná `incident_resolved_at` a makerovi
    zůstává plná accepted compensation.

Druhou cestu nesmí použít případ před předáním dopravci, neuzavřený incident
ani maker-caused výsledek. Pozdější globální parametr se nečte. Assignment
smí vstoupit do payable amount jen tehdy, když nastal jeho uložený
`payout_eligible_at` a žádný claim, který se assignmentu dotýká, není v
neuzavřeném stavu jako `opened`, `investigating` nebo `awaiting_resolution`.
Guard blokuje i claim, jehož zavinění ještě nebylo určeno. Uvolní jej až
zamítnutí, stažení nebo konečné rozhodnutí; u maker-caused výsledku navíc
vyžaduje schválenou adjustment zahrnutou v settlement line. Aktivní legal
hold jej blokuje i po datu. Do té doby zůstává compensation v zádržném a
nesmí přejít do payoutu.

Každý assignment se do settlementu zařadí přes immutable
`MakerSettlementLine`, který jednoznačně odkazuje právě jeden
`ProductionAssignment` a jeho `MakerCompensationSnapshot`. Assignment ani
snapshot nesmí být členem druhého settlementu. Řádek uchová gross
compensation, každou schválenou adjustment s odkazem na zdrojový claim a
výsledný payable amount; uzavřením settlementu se tato množina i částky
zamknou. Opakované vytvoření, překryv období ani pozdě způsobilý assignment
tak nesmějí vést k dvojímu zahrnutí.

Při vytvoření line se `gross_compensation` i `currency` kopírují přesně z
`MakerCompensationSnapshot.(agreed_compensation, currency)` a guard vyžaduje
jejich rovnost. Teprve potom se odvodí
`payable_amount = gross_compensation + Σ approved adjustments`; odlišný
ručně zadaný gross ani nevysvětlený rozdíl nesmí projít.

Settlement, každý jeho line, odkazovaný assignment i compensation snapshot
musejí mít stejné `maker_id`. Kompozitní referenční constraint tuto shodu
vynucuje při vložení řádku; cizí plnění proto nelze připsat na self-billing
doklad ani payout jiného makera.

Další kompozitní reference
`(compensation_snapshot_id, production_assignment_id, maker_id)` vyžaduje
právě snapshot uvedeného assignmentu, nikoli jen libovolný snapshot stejného
makera. Každý `adjustment_source_ref` musí obdobně odkazovat claim, který se
tohoto assignmentu skutečně dotýká.

V první etapě po aktivaci maker modelu se settlement a platformní
self-billing uzavírají **měsíčně**. Konkrétní cutoff, časové pásmo a pravidlo
pro assignment způsobilý až po cutoffu jsou provozní parametry této měsíční
periody, nikoli volba jiné cadence.

Jeden settlement obsahuje jen lines stejného makera a jedné měny. Jeho
`currency` se musí rovnat currency každého compensation snapshotu a line;
doklad i payout tuto měnu dále pouze přebírají. Různé měny proto vytvářejí
oddělené settlements, i když mají stejné období.

### 7.3 Payout po aktivaci maker modelu

Automatické payouty nejsou požadavkem první etapy externí maker sítě.

Přípustný provozní model:

1.  Taven uzavře settlement období pouze nad assignments, které prošly
    maker claim hold guardem.
2.  Studio81 Labs v dohodnutém self-billing režimu vystaví makerovi
    settlement statement a účetní/daňový doklad.
3.  Maker obdrží dokumenty a řeší případný spor před payoutem.
4.  Taven pro settlement vytvoří nebo znovu použije právě jeden
    `MakerPayout`; jeho částka se musí rovnat zamčenému `payable_amount` a
    každý pokus používá stejný idempotency key.
5.  Studio81 Labs provede ruční bankovní platbu a uloží unikátní bankovní
    referenci. Tentýž payout lze označit jako dokončený jen jednou a součet
    úspěšných převodů nikdy nesmí překročit `payable_amount`; payout zůstává
    spojený se settlementem a jeho self-billing dokladem.

Kompozitní reference `(self_billing_document_id, settlement_id)` vyžaduje
doklad vystavený právě pro tento settlement. Vytvoření payoutu současně
ověří, že součet immutable settlement lines odpovídá jeho zamčenému
`payable_amount` i částce dokladu. Vystavení dokladu immutable uloží jeho
měnu, gross compensation, adjustment total, payable amount a hash přesného
payloadu; payout proto neparsuje ani nedůvěřuje později nahraditelnému
artefaktu.

Vystavení dokladu nastaví settlement na `issued`, uloží stejné
`dispute_deadline_at` na settlement i doklad a odvodí je jako
`issued_at + maker_settlement_dispute_days`; aktuální parametr je ⚠ 5
kalendářních dní. Bez otevřeného sporu přejde settlement z `issued` do
`payable` buď explicitním potvrzením makera, které uloží `acknowledged_at`,
nebo idempotentním workerem po uplynutí `dispute_deadline_at`. Doklad přitom
zůstává `issued`. `MakerPayout` smí vzniknout nebo pokračovat jen pro
`payable` settlement s aktivním `issued` dokladem. Otevření sporu a deadline
worker zamykají stejné řádky; spor přijatý před touto tranzicí má přednost a
pozdní námitka už toto běžné dispute window znovu neotevře a používá
samostatný auditovaný correction proces podle stavu bankovního převodu.

#### Oprava sporu před payoutem

Otevření sporu vytvoří immutable `MakerDispute`, který jako
`challenged_settlement_id` a `challenged_document_id` odkazuje právě napadený
settlement a jeho doklad, přepne oba do `disputed` a zablokuje vytvoření nebo
provedení payoutu. Jeden settlement lze tímto běžným window napadnout nejvýše
jednou. Je-li spor zamítnut, auditované rozhodnutí vrátí nezměněný settlement
do `payable` a jeho doklad do `issued`; rejected `MakerDispute` zůstane v
historii. Je-li spor uznán ještě před zahájením bankovního převodu, jedna
transakce:

1.  nastaví původní immutable settlement a doklad na `voided`, uzavře
    `MakerDispute` jako `accepted` a zavře případný neprovedený payout pokus,
2.  vytvoří replacement `MakerSettlement` se
    `supersedes_settlement_id`, immutable `origin_dispute_id`, opravenými
    immutable lines a novým `payable_amount`,
3.  vystaví nový self-billing doklad s `corrects_document_id`,
    `corrects_settlement_id`, stejným `origin_dispute_id` a novými
    strukturovanými částkami,
4.  povolí payout pouze nad replacement settlementem a jeho novým dokladem.

Replacement settlement musí kompozitní self-referencí zachovat `maker_id` a
`currency` svého superseded settlementu a jeho `origin_dispute_id` musí
odkazovat spor, který právě tento superseded settlement a doklad napadl.
U původního settlementu jsou `supersedes_settlement_id` i `origin_dispute_id`
`null`; u replacementu musejí být obě hodnoty vyplněné.
Correcting dokument váže vlastní settlement, `corrects_settlement_id`,
`corrects_document_id` a `origin_dispute_id` ke stejnému trojúhelníku
referencí. U původního dokladu jsou všechny tři correction hodnoty `null`, u
correcting dokladu musejí být všechny vyplněné. Nelze proto propojit
replacement s dokumentem jiného settlementu, makera, měny ani sporu.

`origin_dispute_id` popisuje výhradně spor, který replacement vytvořil, a po
vystavení se nikdy nepřepisuje. Je-li ve vlastním pětidenním okně napaden
correcting settlement, vznikne nový `MakerDispute` s tímto settlementem a
jeho dokladem jako novým challenged párem. Uznání vytvoří další replacement,
který přímo superseduje právě napadeného předchůdce a jako origin uloží nový
spor. Libovolně dlouhá correction chain je proto auditovatelná po jednotlivých
hranách a žádný další spor nepřepisuje původ předchozího článku.

Unikátní assignment membership se vyhodnocuje jen mezi nevoidovanými
settlements, takže historický voided line zůstane auditovatelný, ale nemůže
být znovu vyplacen. Po zahájení nebo dokončení bankovního převodu tento
pre-payout flow není povolen; případná oprava musí projít samostatným
účetním reconciliation procesem, nikoli přepsáním dokladu nebo payoutu.

Budoucí síť může tento proces automatizovat, ale ekonomický model se
nemění.

------------------------------------------------------------------------

## 8. Doménové entity

### Maker

``` text
Maker
- id
- legal_identity
- status
- compensation_policy_id
- routing_policy_id
- created_at
```

### Node

``` text
Node
- id
- owner_type (`platform` | `maker`)
- maker_id (nullable; povinné jen pro `owner_type = maker`)
- location / service area
- status
- capabilities
```

`ProductionAssignment` smí odkazovat jen `Node(owner_type = maker)` a jeho
`maker_id` se musí shodovat s vlastníkem uzlu. Kompozitní reference
`(node_id, maker_id)` tuto vazbu vynucuje. Platform-owned uzel zůstává
interním `Job` scope bez fiktivního `ProductionAssignment`.

### ProductionAssignment

``` text
ProductionAssignment
- id
- job_id (nejvýše jeden assignment s `accepted_at`)
- maker_id
- node_id
- constraint `(node_id, maker_id)` → maker-owned `Node`
- status
- offered_at
- accepted_at
- delivered_at (nullable)
- verified_handoff_at (nullable)
- incident_resolved_at (nullable)
- payout_eligibility_basis (`delivered_claim_window` |
  `non_maker_handoff_incident`, nullable; po nastavení immutable)
- payout_eligible_at (nullable; po nastavení basis immutable)
- deadline
```

### MakerCompensationPolicy

``` text
MakerCompensationPolicy
- id
- version
- valid_from
- base calculation rules
- performance rules
- caps
```

### MakerCompensationSnapshot

``` text
MakerCompensationSnapshot
- id
- production_assignment_id (unique)
- maker_id
- constraint `(production_assignment_id, maker_id)` → `ProductionAssignment`
- policy_version
- performance_snapshot_id
- constraint `(performance_snapshot_id, maker_id)` → `MakerPerformanceSnapshot`
- production_inputs (immutable material, time, plates, handling,
  post-processing, handoff and special-requirement inputs)
- base_compensation
- performance_modifier
- surcharges
- adjustments
- currency
- agreed_compensation
- order_claim_policy_version
- claim_hold_policy_version
- maker_claim_hold_days
- created_at
```

### MakerPerformanceSnapshot

``` text
MakerPerformanceSnapshot
- id
- maker_id
- period
- sample_size
- first_pass_yield
- maker_caused_reprint_rate
- claim_rate
- maker_caused_claim_rate
- on_time_rate
- handoff_delay
- acceptance_rate
- response_time
- resulting_modifier
```

### MakerSettlement

``` text
MakerSettlement
- id
- maker_id
- supersedes_settlement_id (nullable; vyplněné právě s `origin_dispute_id`)
- origin_dispute_id (nullable; unique; vyplněné právě se
  `supersedes_settlement_id`; po vytvoření immutable)
- constraint `(supersedes_settlement_id, maker_id, currency)`
  → `MakerSettlement.(id, maker_id, currency)`
- constraint `(origin_dispute_id, supersedes_settlement_id, maker_id)`
  → `MakerDispute.(id, challenged_settlement_id, maker_id)`
- period_from
- period_to
- issued_at (nullable)
- dispute_deadline_at (nullable; po vystavení immutable)
- acknowledged_at (nullable)
- currency
- gross_compensation
- adjustments
- payable_amount
- status (`draft` | `issued` | `disputed` | `payable` | `voided` | `paid`)
```

### MakerDispute

``` text
MakerDispute
- id
- maker_id
- challenged_settlement_id (unique)
- challenged_document_id (unique)
- constraint `(challenged_document_id, challenged_settlement_id)`
  → `MakerSelfBillingDocument.(id, settlement_id)`
- opened_at
- dispute_deadline_at
- resolved_at (nullable)
- status (`opened` | `rejected` | `accepted`)
```

### MakerSettlementLine

``` text
MakerSettlementLine
- id
- settlement_id
- maker_id (musí se shodovat se settlementem, assignmentem i snapshotem)
- production_assignment_id (unique mezi nevoidovanými settlements)
- compensation_snapshot_id (unique mezi nevoidovanými settlements)
- constraint `(compensation_snapshot_id, production_assignment_id, maker_id)`
  → `MakerCompensationSnapshot`
- gross_compensation (= snapshot.agreed_compensation)
- currency
- adjustment_source_refs (claim ID + explicit amount)
- payable_amount (= gross_compensation + Σ approved adjustments)
- created_at
```

### MakerSelfBillingDocument

``` text
MakerSelfBillingDocument
- id
- settlement_id (unique)
- document_number (unique)
- corrects_document_id (nullable; unique)
- corrects_settlement_id (nullable)
- origin_dispute_id (nullable; po vystavení immutable)
- constraint `(settlement_id, corrects_settlement_id, origin_dispute_id)`
  → `MakerSettlement.(id, supersedes_settlement_id, origin_dispute_id)`
- constraint `(origin_dispute_id, corrects_settlement_id,
  corrects_document_id)`
  → `MakerDispute.(id, challenged_settlement_id, challenged_document_id)`
- currency
- gross_compensation
- adjustment_total
- payable_amount
- payload_hash (immutable)
- artifact_ref (immutable content-addressed)
- issued_at
- dispute_deadline_at (immutable; shodné se settlementem)
- voided_at (nullable)
- status (`issued` | `disputed` | `voided` | `paid`)
```

### MakerPayout

``` text
MakerPayout
- id
- settlement_id (unique)
- self_billing_document_id (unique)
- constraint `(self_billing_document_id, settlement_id)`
  → `MakerSelfBillingDocument`
- transfer_idempotency_key (unique)
- currency
- amount
- payment_reference (unique; nullable do provedení převodu)
- paid_at
- status
```

------------------------------------------------------------------------

## 9. V0 scope a aktivační hranice

Ve v0 existuje:

-   Studio81 Labs jako jediný seller of record,
-   jeden vlastní `Node/Machine` podle kanonické specifikace,
-   povinné immutable `Job.payout_amount` a `Job.payout_currency`
    snapshotované při každém přijetí, i když je příjemcem provozovatel,
-   ruční účetní zacházení mimo produktový maker subsystém.

Ve v0 se **nestaví**:

-   `Maker` a `ProductionAssignment`,
-   `MakerCompensationPolicy` a compensation snapshoty,
-   maker performance data a modifier,
-   `MakerSettlement` a `MakerPayout`,
-   veřejný maker onboarding,
-   automatický routing mezi více makery,
-   marketplace,
-   bidding,
-   automatické bankovní payouty,
-   komplexní maker tiers,
-   automatická penalizační ekonomika,
-   optimalizační engine expected fulfilment cost.

Datový šev pro budoucí `Node` scope zůstává zachován, ale žádná z těchto
maker entit ani workflow nevzniká před kapacitní bránou.
`Job.(payout_amount, payout_currency)` však bránu přežívá: u externího
assignmentu je přesným immutable aliasem
`MakerCompensationSnapshot.(agreed_compensation, currency)`.

------------------------------------------------------------------------

## 10. Přechod na síť

Pokud kapacitní brána později rozhodne pro externího makera nebo síť,
aktivuje se smluvní a ekonomický model z tohoto dokumentu.

Teprve potom se mění produktová topologie:

``` text
v0:
0 Maker
1 owned Node/Machine
manual operation
no maker settlement/payout domain

first stage after gate:
N Maker
N Node
platform-owned and maker-owned nodes
manual assignment or limited policy routing
performance-based priority
settlement records
platform self-billing and manual bank-transfer payout

later network:
automatic routing
automated settlement/payout
```

První externí maker používá od začátku stejný typ policy a snapshotů
jako každý další maker; výjimka pro interní dogfooding nevzniká.

------------------------------------------------------------------------

## 11. Invarianty

1.  Studio81 Labs je seller of record vůči zákazníkovi.
2.  Maker je dodavatel Studio81 Labs, nikoli zákazníka.
3.  Zákazník nevidí identitu makera ani jeho neveřejné výrobní místo.
4.  Customer price a maker compensation jsou nezávislé veličiny.
5.  Maker compensation se neurčuje jako procentní zbytek zákaznické
    ceny.
6.  Maker před přijetím jobu zná svou odměnu.
7.  Přijetím jobu se compensation snapshot zamkne.
8.  Změna policy nebo performance nesmí zpětně měnit přijaté joby.
9.  První externí maker po kapacitní bráně používá stejný ekonomický
    model jako každý další nezávislý maker.
10. Performance je transparentně odvozena z jednotlivých metrik, ne z
    neprůhledného ručního ratingu.
11. Podstandardní maker se řeší routingem/probation/suspension, ne
    arbitrárním snižováním odměny.
12. Maker settlement a maker payout jsou oddělené od compensation
    konkrétního jobu.
13. Účetní a daňové plnění mezi Studio81 Labs a makerem musí odpovídat
    skutečně poskytnuté službě a předem definovaným podmínkám.
14. Platform-owned `Node` zůstává po aktivaci sítě platný bez
    fiktivního `Maker`; maker-owned `Node` naopak vždy odkazuje svého
    dodavatele.
15. Claim-hold policy a délka se snapshotují při přijetí assignmentu;
    settlement používá jednou odvozený `payout_eligible_at`, ne pozdější
    hodnotu parametru.
16. Každý způsobilý assignment patří nejvýše do jednoho immutable
    settlement line; řádek odkazuje jeho compensation snapshot i zdrojové
    claim adjustments.
17. Compensation snapshot uchovává immutable vstupy výpočtu dostatečné k
    reprodukci `base_compensation`, i když se zdrojová job data později
    změní nebo expirují.
18. Každý payout odkazuje přesný platformou vystavený self-billing doklad
    pro svůj settlement.
19. Přijatá compensation odkazuje immutable performance snapshot, ze
    kterého byl její modifier odvozen.
20. Pro jeden settlement existuje nejvýše jeden payout se stabilním
    idempotency key; jeho úspěšná částka se musí rovnat zamčenému
    `payable_amount` a nesmí být převedena podruhé.
21. Každý assignment má právě jeden compensation snapshot vytvořený
    idempotentním acceptance příkazem.
22. Maker na settlementu, každém jeho line, assignmentu a compensation
    snapshotu musí být totožný a shoda je vynucena referenčním constraintem.
23. Production assignment smí použít jen maker-owned uzel téhož makera;
    platform-owned uzel assignment ani compensation workflow nevytváří.
24. `Job.(payout_amount, payout_currency)` maker-owned assignmentu se po
    maker gate rovná
    `MakerCompensationSnapshot.(agreed_compensation, currency)`;
    platform-owned fallback zůstává interním jobem bez maker snapshotu a
    settlementu.
25. Každý neuzavřený claim dotýkající se assignmentu blokuje settlement bez
    ohledu na dosud neurčené zavinění; maker-caused výsledek vyžaduje
    schválenou adjustment.
26. Jeden `Job` smí mít v celé historii nejvýše jeden přijatý production
    assignment; pozdní acceptance konkurenčního offeru nevytvoří finanční
    závazek.
27. Compensation snapshot smí odkazovat performance snapshot téhož makera a
    jeho uložený modifier se musí rovnat `resulting_modifier`.
28. Settlement line musí odkazovat compensation snapshot právě svého
    assignmentu a každá claim adjustment musí mít zdroj v claimu dotýkajícím
    se tohoto assignmentu.
29. Payout smí odkazovat jen self-billing doklad svého settlementu; částka
    settlementu, součet jeho lines, doklad i payout se musejí shodovat.
30. Vydaný self-billing doklad immutable ukládá měnu, strukturované částky a
    hash payloadu; payout se musí shodovat v částce i měně.
31. Maker payout eligibility se odvozuje z claim policy přijaté s Orderem a
    nesmí nastat před nejpozdějším `claim_until` plněných slotů; aktivní
    legal hold settlement dál blokuje.
32. Uznaný spor před převodem voidne původní settlement a doklad a vytvoří
    propojený replacement/correcting chain; žádný vydaný řádek, doklad ani
    payout se nepřepisuje.
33. Compensation snapshot musí kompozitní referencí odkazovat assignment i
    jeho skutečného makera ještě před zamknutím odměny a jobového payoutu.
34. Compensation snapshot zamyká také měnu; jobový payout, settlement line,
    settlement, self-billing doklad a payout se s ní musejí shodovat a jeden
    settlement nesmí míchat měny.
35. Settlement line přebírá gross compensation přesně z accepted snapshotu
    a payable amount smí změnit jen součtem explicitních schválených
    adjustments.
36. Assignment bez `delivered_at` je payout-eligible jen po ověřeném předání
    dopravci a terminálním non-maker-caused incidentu; eligibility basis i
    okamžik se nastaví jednou a plná accepted compensation zůstává zachována.
37. Settlement přejde bez sporu z `issued` do `payable` jen explicitním
    potvrzením makera nebo idempotentně po uloženém dispute deadline; otevřený
    spor přijatý před tranzicí má přednost.
38. Correcting doklad musí odkazovat právě doklad superseded settlementu a
    replacement settlement, oba pro stejného makera, měnu a spor; všechny
    correction reference jsou společně null nebo společně vyplněné.
39. Každý settlement má nejvýše jeden vlastní `MakerDispute`; replacement
    immutable uchová spor svého vzniku jako `origin_dispute_id`, zatímco jeho
    případné napadení vytváří nový dispute a další článek correction chain.

------------------------------------------------------------------------

## 12. Rozhodovací log --- zapsané záznamy

Záznamy #176 a #180 byly zrušeny rozhodnutím #183. Záznamy #177–#179 a
#181 platí až po aktivační bráně #183. Vlastnictví uzlů, první ruční
payout fázi, immutable payout eligibility a settlement membership doplňují
#184–#198.

  ------------------------------------------------------------------------------------------
  \#             Rozhodnutí                Zdůvodnění       Zamítnutá         Stav
                                                            alternativa       
  -------------- ------------------------- ---------------- ----------------- --------------
  176            Studio81 Labs je seller   sjednocuje       vlastní tiskárna  zrušeno #183
                 of record a maker je jeho právní, provozní s.r.o. ve v0 a    
                 samostatný výrobní        a ekonomický     maker model až se 
                 dodavatel už ve v0        model v0 s       sítí              
                                           případnou                          
                                           budoucí sítí;                      
                                           zákazník má                        
                                           jednoho                            
                                           odpovědného                        
                                           partnera                           

  177            Customer price a maker    cena pro         maker dostává     platí
                 compensation jsou         zákazníka a cena pevné procento    
                 nezávislé cenové domény   výrobní kapacity zákaznické ceny   
                                           řeší jiný                          
                                           ekonomický                         
                                           problém; rozdíl                    
                                           tvoří ekonomiku                    
                                           platformy                          

  178            Maker compensation je     maker musí znát  odměna dopočítaná platí
                 známá před přijetím jobu  ekonomiku práce  až při měsíčním   
                 a přijetím se zamyká      před závazkem;   settlementu       
                                           pozdější změna                     
                                           ratingu/policy                     
                                           nesmí měnit již                    
                                           přijatou dohodu                    

  179            Performance modifier je   motivuje         široké finanční   platí
                 primárně bonusový;        kvalitní a       penalizace za     
                 podstandard se řeší       rychlé makery    horší performance 
                 routingem a suspendováním bez závodu ke                      
                                           dnu; špatný                        
                                           maker není                         
                                           levnější výrobní                   
                                           kapacita, ale                      
                                           provozní riziko                    

  180            První OSVČ maker používá  personální       zvláštní interní  zrušeno #183
                 stejnou                   propojení nesmí  sazba prvního     
                 MakerCompensationPolicy   měnit ekonomická makera            
                 jako budoucí nezávislí    pravidla; v0 tak                   
                 makeři                    reálně testuje                     
                                           budoucí network                    
                                           economics                          

  181            Compensation, settlement  odděluje cenu    jeden             platí
                 a payout jsou tři         konkrétního      `payout_amount`   
                 samostatné koncepty       plnění,          na Job            
                                           periodické                         
                                           účetní                             
                                           vypořádání a                       
                                           skutečný převod                    
                                           peněz                              
  ------------------------------------------------------------------------------------------

------------------------------------------------------------------------

## 13. Otevřené body

Před aktivací externího maker modelu po kapacitní bráně doplnit:

-   přesný vzorec `production_base`,
-   výchozí `MakerCompensationPolicy` pro první síťovou etapu,
-   minimální sample size pro performance bonusy,
-   přesný cutoff, časové pásmo a late-eligibility pravidlo měsíčního
    settlementu,
-   pravidla pro maker-caused reprint a claim adjustments,
-   právní a účetní potvrzení konkrétní podoby self-billing dokladu,
-   potvrzení účetního/daňového zacházení u propojených osob.

Poslední bod je právní/daňová validace provozního modelu; nemění
produktový invariant, že první externí maker po gate musí mít předem
definované a obhajitelné podmínky stejného typu jako každý další maker.

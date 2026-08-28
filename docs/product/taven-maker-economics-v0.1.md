# Taven --- maker economics a settlement v0.1

**Status:** gate-scoped produktová baseline; rozhodnutí zapsána v
`taven-rozhodovaci-log.md` #177–#179, #181 a #183–#190; aktivace až po kapacitní
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

Snapshot obsahuje minimálně:

-   `production_assignment_id`,
-   `maker_id`,
-   `policy_version`,
-   vstupní výrobní parametry,
-   `base_compensation`,
-   `performance_snapshot_id`,
-   `performance_modifier`,
-   explicitní surcharge/adjustments,
-   `agreed_compensation`,
-   `claim_hold_policy_version`,
-   `maker_claim_hold_days`,
-   timestamp přijetí.

`performance_snapshot_id` odkazuje přesné immutable metriky, ze kterých byl
modifier odvozen. Pozdější změna performance score nebo compensation policy
nesmí zpětně změnit odměnu již přijatého jobu.

Po aktivaci maker modelu zapíše acceptance transakce tutéž částku současně
jako `MakerCompensationSnapshot.agreed_compensation` a
`Job.payout_amount`; nejde o dvě cenové veličiny. Offer a routing pracují s
budoucí agreed compensation a přijetí odmítne jakoukoli neshodu. Settlement
pak čte immutable snapshot, jehož částka se rovná jobovému poli.

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

Při přijetí assignmentu se do compensation snapshotu uloží také verze
claim-hold policy a její `maker_claim_hold_days` --- podle aktuálních
parametrů 7 dní. Doručení jednou a neměnně odvodí
`payout_eligible_at = delivered_at + maker_claim_hold_days` z tohoto
snapshotu. Assignment smí vstoupit do payable amount jen tehdy, když nastal
jeho uložený `payout_eligible_at` a žádný claim, který se assignmentu dotýká,
není v neuzavřeném stavu jako `opened`, `investigating` nebo
`awaiting_resolution`. Guard blokuje i claim, jehož zavinění ještě nebylo
určeno. Uvolní jej až zamítnutí, stažení nebo konečné rozhodnutí; u
maker-caused výsledku navíc vyžaduje schválenou adjustment zahrnutou v
settlement line. Settlement guard nikdy znovu nečte aktuální parametr. Do té
doby zůstává compensation v zádržném a nesmí přejít do payoutu.

Každý assignment se do settlementu zařadí přes immutable
`MakerSettlementLine`, který jednoznačně odkazuje právě jeden
`ProductionAssignment` a jeho `MakerCompensationSnapshot`. Assignment ani
snapshot nesmí být členem druhého settlementu. Řádek uchová gross
compensation, každou schválenou adjustment s odkazem na zdrojový claim a
výsledný payable amount; uzavřením settlementu se tato množina i částky
zamknou. Opakované vytvoření, překryv období ani pozdě způsobilý assignment
tak nesmějí vést k dvojímu zahrnutí.

Settlement, každý jeho line, odkazovaný assignment i compensation snapshot
musejí mít stejné `maker_id`. Kompozitní referenční constraint tuto shodu
vynucuje při vložení řádku; cizí plnění proto nelze připsat na self-billing
doklad ani payout jiného makera.

V první etapě po aktivaci maker modelu se settlement a platformní
self-billing uzavírají **měsíčně**. Konkrétní cutoff, časové pásmo a pravidlo
pro assignment způsobilý až po cutoffu jsou provozní parametry této měsíční
periody, nikoli volba jiné cadence.

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
- job_id
- maker_id
- node_id
- constraint `(node_id, maker_id)` → maker-owned `Node`
- status
- offered_at
- accepted_at
- delivered_at (nullable)
- payout_eligible_at (nullable; po doručení immutable)
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
- policy_version
- performance_snapshot_id
- production_inputs (immutable material, time, plates, handling,
  post-processing, handoff and special-requirement inputs)
- base_compensation
- performance_modifier
- surcharges
- adjustments
- agreed_compensation
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
- period_from
- period_to
- gross_compensation
- adjustments
- payable_amount
- status
```

### MakerSettlementLine

``` text
MakerSettlementLine
- id
- settlement_id
- maker_id (musí se shodovat se settlementem, assignmentem i snapshotem)
- production_assignment_id (unique)
- compensation_snapshot_id (unique)
- gross_compensation
- adjustment_source_refs (claim ID + explicit amount)
- payable_amount
- created_at
```

### MakerSelfBillingDocument

``` text
MakerSelfBillingDocument
- id
- settlement_id (unique)
- document_number (unique)
- artifact_ref
- issued_at
- status
```

### MakerPayout

``` text
MakerPayout
- id
- settlement_id (unique)
- self_billing_document_id (unique)
- transfer_idempotency_key (unique)
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
-   povinný immutable `Job.payout_amount` snapshotovaný při každém přijetí,
    i když je příjemcem provozovatel,
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
`Job.payout_amount` však bránu přežívá: u externího assignmentu je přesným
immutable aliasem `MakerCompensationSnapshot.agreed_compensation`.

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
24. `Job.payout_amount` se po maker gate rovná
    `MakerCompensationSnapshot.agreed_compensation` stejného assignmentu.
25. Každý neuzavřený claim dotýkající se assignmentu blokuje settlement bez
    ohledu na dosud neurčené zavinění; maker-caused výsledek vyžaduje
    schválenou adjustment.

------------------------------------------------------------------------

## 12. Rozhodovací log --- zapsané záznamy

Záznamy #176 a #180 byly zrušeny rozhodnutím #183. Záznamy #177–#179 a
#181 platí až po aktivační bráně #183. Vlastnictví uzlů, první ruční
payout fázi, immutable payout eligibility a settlement membership doplňují
#184–#190.

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

# Taven — launch approvals v0.1

**Status:** vývojové vstupy potvrzeny — **nejde o schválení veřejného spuštění**

**Datum záznamu:** 2026-09-04

**Vlastník rozhodnutí:** `@akadlec`

**Související issue:** [#38](https://github.com/Studio81Labs/taven/issues/38)

Tento registr odděluje skutečně potvrzené vstupy od návrhů, které nesmějí být
použity jako závazný zákaznický slib. Není právním posouzením a nenahrazuje
kontrolu českým právním poradcem.

## 1. Právní identita prodávajícího

Vlastník dodal pro veřejnou právní identifikaci služby tyto údaje:

| Údaj | Schválená hodnota | Původ a stav |
|---|---|---|
| Obchodní firma | Studio81 Labs, s.r.o. | dodáno vlastníkem; název a IČ ověřeny v ARES 2026-09-04 |
| Role | jediný prodávající a odpovědný provozovatel Tavenu | schváleno vlastníkem; odpovídá rozhodnutí #174 |
| Sídlo | Nové sady 988/2, 602 00 Brno, Česká republika | dodáno vlastníkem; standardizovaná adresa ověřena v ARES 2026-09-04 |
| IČ | 29508291 | dodáno vlastníkem; ověřeno v ARES 2026-09-04 |
| DIČ | CZ29508291 | dodáno vlastníkem a schváleno k publikaci 2026-09-04 |
| Veřejný zákaznický e-mail | `zakaznici@taven.cz` | schváleno vlastníkem 2026-09-04; měnitelné runtime konfigurací |
| Veřejný zákaznický telefon | nezveřejňovat | vlastník zvolil pouze elektronické veřejné kontakty |
| Kontakt správce osobních údajů | `legal@taven.cz` | schváleno vlastníkem 2026-09-04; měnitelné runtime konfigurací; právní text stále čeká na kontrolu |

Zdroj externího ověření firmy, IČ a sídla:
[ARES — ekonomický subjekt 29508291](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/29508291).
Sídlo právnické osoby není adresou neveřejné dílny; konkrétní místo výroby se
nezveřejňuje.

## 2. Potvrzené značky

Vlastník 2026-09-04 výslovně vybral směr **02 — TEČKA**:

| Použití | Konstrukce | Stav |
|---|---|---|
| Primární wordmark | `TAVEN.` v IBM Plex Mono 600; na světlém podkladu písmena `#1A1A16`, tečka `#1B44E8` | schváleno vlastníkem |
| Inverzní wordmark | `TAVEN.` na `#1A1A16`; písmena `#EFEFEA`, tečka `#5C7CFF` | schváleno vlastníkem |
| Compact mark | `TV.` se stejnou typografickou a barevnou konstrukcí | schváleno vlastníkem |
| Jednobarevná varianta | celý wordmark včetně tečky černě nebo bíle podle podkladu | dříve schváleno v identitě v1.1 |

Vlastník následně potvrdil `TAVEN.`, `TV.` a `taven.cz` jako finální veřejnou
identitu. Toto produktové rozhodnutí samo neprovádí registraci domény ani právní
clearance názvu nebo známky.
Referenční screenshot a HTML jsou designovým podkladem; jejich popisné texty,
inline layout a editorové `data-*` atributy nejsou požadavky na výsledný kód.

## 3. Právní texty — pouze placeholdery

Vlastník povolil dočasné dummy texty nebo placeholdery a může dodat jejich
pracovní návrhy během přípravy systému. Každý takový artefakt
musí být viditelně označen `NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI`, nesmí mít
datum účinnosti a nesmí být přijatelnou verzí pro API snapshot, checkout ani
veřejné spuštění.

| Oblast | Rezervovaný placeholder ID | Účinnost | Vlastník dokončení | Launch závažnost |
|---|---|---|---|---|
| Všeobecné obchodní podmínky | `terms-pending` | — | vlastník + český právní poradce | blokující |
| Reklamační řád a nápravy | `claims-pending` | — | vlastník + český právní poradce | blokující |
| Zásady zpracování osobních údajů | `privacy-pending` | — | vlastník + český právní poradce | blokující |
| Zakázaný obsah a ruční preview | `prohibited-content-pending` | — | vlastník + český právní poradce | blokující |
| Retence, mazání a opuštěné výrobky | `retention-pending` | — | vlastník + český právní poradce | blokující |
| Souhlas s fotografiemi a NDA hranice | `photo-consent-pending` | — | vlastník + český právní poradce | blokující |

Vlastník 2026-09-04 dodal pracovní návrhy všech šesti oblastí. Web je zobrazuje
pro vývoj a právní připomínkování pod rezervovanými `*-pending` ID, s trvalým
varováním a bez data účinnosti nebo možnosti přijetí. Kontaktní placeholdery
využívají schválené runtime měnitelné elektronické kontakty. Návrhové retenční
lhůty zůstávají výslovně neschválené a produkční toky zůstávají blokované.

Právní kontrola musí pokrýt také roli prodávajícího, DPH, capture/refund a
settlement, výjimku z odstoupení u zboží na míru, hranici model versus výtisk,
záruku a reklamace, delivery promise a individuální zálohu/doplatek. Texty
konkurence mohou sloužit jen jako checklist nebo struktura; žádná jejich próza
se nekopíruje.

## 4. Clearance názvu a domény

Výběr TEČKA ani ověření právnické osoby nejsou name clearance. Před registrací
a veřejným spuštěním zůstávají povinné všechny čtyři kroky ze specifikace
§13.1:

| Krok | Stav | Požadovaný důkaz |
|---|---|---|
| Český trh a subjekty v relevantních oborech | čeká | datovaný výsledek hledání Taven/Taviro a fonetických sousedů |
| TMview/ÚPV/EUIPO, třídy 40 a 42 a sousední 35, 7, 20 | čeká | datované dotazy včetně `tav*`, `*aven` a fonetických variant |
| `taven.cz` a sociální handles | doména finální; registrace čeká | registrovat `taven.cz`; sociální handles ověřit před použitím |
| Telefonní test | čeká | zaznamenaný výsledek a rozhodnutí vlastníka |

`taven.cz` je finální, dosud neregistrovaná doména. Dřívější RDAP kontrola bez
nalezeného záznamu je jen bodový signál dostupnosti, nikoli rezervace nebo
clearance. Vlastník 2026-09-04 výslovně potvrdil, že nevyřízená registrace a
externí clearance neblokují vývoj pod touto identitou; zůstávají launch akcemi.

## 5. Závazné obchodní vstupy

`strop_spend_v0 = 5 000 Kč` je již schválen. Ostatní hodnoty označené ⚠ v
`taven-parametry.md`, které ovlivňují cenu, platbu, reklamaci, retenci nebo
zákaznický slib, zůstávají návrhy. Patří sem zejména:

- 72hodinový delivery promise a podmínky expresu,
- 15minutová rezervace a 60minutové capture okno,
- platnost individuální nabídky, výše zálohy a sedmidenní deadline doplatku,
- 30denní dispozice s opuštěným výrobkem,
- zákaznické reklamační okno a přesná retence reprodukčního artefaktu,
- 90denní retence fotografií a nedoručeného reprodukčního artefaktu,
- hodnotový a kusový strop automatu a všechny nedopočítané cenové vstupy.

Vlastník 2026-09-04 výslovně rozhodl, že všechny dosud neschválené ⚠ hodnoty
zůstanou vypnuté, dokud nebude každá z nich samostatně schválena. Do té doby
musí být každý dotčený direct flow blokovaný. Jde o explicitní direct-flow
block pro acceptance criterion issue #38; není to schválení žádné z návrhových
hodnot. Placeholder ani pracovní návrh právního textu není souhlas s těmito
hodnotami.

Backend proto používá tři nezávislé, výchozím stavem vypnuté přepínače:
`TAVEN_BINDING_QUOTE_FLOWS_ENABLED` pro vytvoření závazné automatické ceny,
vydání individuální nabídky a její přijetí a
`TAVEN_QUOTE_PHOTO_UPLOADS_ENABLED` pro založení a dokončení uploadu fotografie
a `TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED` pro založení nového platebního pokusu.
Pouze přesná hodnota `true` tok povolí; chybějící, prázdná nebo jiná hodnota jej
blokuje. Expirace, odmítnutí nabídek a retenční úklid zůstávají dostupné.

Web používá samostatný výchozím stavem vypnutý přepínač
`NUXT_PUBLIC_AUTOMATIC_QUOTE_ENABLED`. I přes jeho přesnou hodnotu `true`
(nebo runtime boolean `true`) zůstává veřejné získávání objednávek vypnuté,
dokud manifest v repozitáři neobsahuje schválené právní a obchodní vstupy. Tento
webový přepínač nenahrazuje žádný backendový přepínač ani neautorizuje veřejné
spuštění.

Studio81 Labs, s.r.o. aktuálně není plátcem DPH. Ve v0 se proto zákazníkovi
účtuje konečná cena bez vyčíslené DPH; zveřejněné DIČ samo o sobě neznamená
registraci k DPH. Cenový systém ukládá daňový režim do verzovaného ceníku a do
každého závazného cenového snapshotu. Budoucí přechod na plátcovství vyžaduje
novou revizi ceníku s výslovnou sazbou; nové nabídky pak zobrazí cenu bez DPH,
DPH a konečnou cenu, zatímco dříve vydané nabídky se nezmění.

## 6. Stav acceptance criteria issue #38

| Kritérium | Stav | Co chybí |
|---|---|---|
| `TAVEN.`/`TV.` a Studio81 Labs jako seller/operator | splněno | vlastník potvrdil značky i odpovědný subjekt |
| Clearance a finální veřejné jméno/doména | splněno pro rozhodnutí | `TAVEN.`/`TV.`/`taven.cz` jsou finální; registrace a externí clearance zůstávají launch akcemi |
| Verzované účinné právní texty | blokováno | counsel-approved text, verze a data účinnosti |
| Přijaté závazné v0 hodnoty nebo direct-flow blok | splněno přímým blokem | všechny neschválené ⚠ hodnoty zůstávají vypnuté do samostatného schválení |
| Nekopírovat právní prózu třetích stran | splněno pro tento záznam | zachovat při přípravě finálních textů |

Issue #38 zůstává otevřená a tento dokument sám o sobě neautorizuje registraci
domény, zveřejnění placeholderů ani produkční checkout.

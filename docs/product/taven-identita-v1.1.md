# Taven — identita v1.1

**Frekvence změn:** zřídka. Změna zde je změnou značky, ne parametru — patří do rozhodovacího logu.
**Vztah k ostatním souborům:** `taven-design-brief-v1.2.md` tenhle dokument cituje, nekopíruje.
**Status:** identita a hlavní vizuální systém odsouhlaseny z aktuální sady mockupů.
**Datum:** 2026-08-28

**Poslední potvrzení:** 2026-09-04 — právní identita provozovatele, konstrukce varianty TEČKA a `taven.cz` jako finální doména.

> Vlastník potvrdil `TAVEN.`, `TV.` a `taven.cz` jako finální veřejnou identitu.
> Doména dosud není registrovaná a registrace ani právní clearance tímto
> záznamem nejsou provedeny.

---

## 1. Co značka je

**Taven je česká služba zakázkového 3D tisku, kde zákazník nahraje model, dostane závaznou cenu vypočtenou ze skutečného slicingu a objedná bez e-mailového ping-pongu.**

**Brand claim:** `Nahraj. Zaplať. Hotovo.`  
**Hlavní homepage proposition:** `Nahraj model. Cena platí.`

Kořen `tav-` odkazuje na tavení — na fyzický proces, ne na technologii. České ucho ho slyší, cizinec vidí značku. Nepopisné, ale rezonující.

## 2. Co značka není

| Není | Takže se nikde neobjeví |
|---|---|
| marketplace | výběr dodavatele, nabídky více tiskařů, bidding |
| síť | „network", mapa uzlů, počty makerů, „přidej se jako maker" |
| komunita | avatary, jména tiskařů, profily |
| startup | „early access", waitlist, odpočty, growth jazyk |
| mezinárodní projekt | angličtina, zahraniční města |

**Zákazník nikdy nevidí, kdo a na čem konkrétně tiskne.** Taven je obchodní
označení služby; prodávajícím a odpovědným provozovatelem je Studio81 Labs,
s.r.o. Konkrétní maker, stroj a neveřejné místo výroby jsou interní výrobní
detail.

Vlastník dodal tyto identifikační údaje; položka označená jako čekající se před
zveřejněním ještě ověří:

| Údaj | Hodnota | Stav |
|---|---|---|
| Obchodní firma | Studio81 Labs, s.r.o. | připraveno pro veřejnou identifikaci |
| Sídlo | Nové sady 988/2, 602 00 Brno | připraveno pro veřejnou identifikaci |
| Stát | Česká republika | připraveno pro veřejnou identifikaci |
| IČ | 29508291 | připraveno pro veřejnou identifikaci |
| DIČ | CZ29508291 | schváleno vlastníkem k publikaci |
| Zákaznický e-mail | zakaznici@taven.cz | schváleno; měnitelné runtime konfigurací |
| Kontakt správce osobních údajů | legal@taven.cz | schváleno; měnitelné runtime konfigurací |
| Veřejný telefon | nezveřejňovat | komunikace pouze elektronicky |

Sídlo právnické osoby se může zobrazovat v trust sekci, footeru, VOP,
dokladech a kontaktech. Není tím zveřejněna adresa dílny: **soukromé místo
výroby se nepublikuje.** Veřejné kontakty jsou elektronické; Taven nezveřejňuje
zákaznický telefon a nepoužívá vývojový kontakt z metadat repozitáře.

## 3. Tón

**Přesný, klidný, konkrétní.** Mluvíme čísly, ne přídavnými jmény.

| Ano | Ne |
|---|---|
| „Cena platí. Zaplať a tiskneme." | „Nejlepší kvalita za skvělé ceny" |
| „Termín odeslání vidíš před platbou." | „Rychle a spolehlivě" |
| „Tahle stěna je tenčí než dvě housenky materiálu" | „Detekován potenciální problém" |
| „Tiskneme věrně podle tvého modelu" | „Garantujeme perfektní výsledek" |

Tykání. Žádné vykřičníky, žádné superlativy. Riziko se říká rovnou — je to součást produktu (nálezy před tiskem), ne otrava.

## 4. Vizuální směr

**Technický výkres převedený do spotřebitelské výrobní služby.**

Estetika inženýrské dokumentace: tenké linky, kótovací šipky, milimetrový rastr, mono číslice, řezy. Sedí to na produkt, který se prodává přesností, a v českém 3D tisku to nepoužívá nikdo — konkurence jede stock fotky tiskáren nebo generický e-shop.

**Nosným prvkem identity není logo, ale sazba čísel.** Každé číslo v rozhraní je mono: cena, gramáž, rozměry, čas, číslo zakázky.

> **Technický prvek má pokud možno nést informaci, ne být dekorací.**

Orientační poměr plochy: **80 %** typografie/whitespace/neutrální plochy, **15 %** linky/metadata/rastr, **5 %** akcent.

## 5. Barvy

| Token | Hex | Použití |
|---|---|---|
| `--paper` | `#EFEFEA` | podklad |
| `--surface` | `#FFFFFF` | karty, plátno |
| `--ink` | `#1A1A16` | text, kóty |
| `--ink-2` | `#54554C` | sekundární text |
| `--ink-3` | `#66675F` | mikrotexty; kontrast 5,72 : 1 na `--surface` a 4,96 : 1 na `--paper` |
| `--rule` | `#D9D9D2` | linky |
| `--accent` | `#1B44E8` | závazná cena, primární akce, tečka v logu |
| `--warn` | `#925B10` | dotaz na jednotky, varování; kontrast 5,64 : 1 na `--surface` a 4,89 : 1 na `--paper` |
| `--stop` | `#B4441A` | odmítnutí, blokující nález |

**Akcent nepřesáhne přibližně 5 % plochy.** Modrá `#1B44E8` je finální primární akcent a používá se významově pro aktivní krok, vybranou variantu, závaznou cenu, primární CTA a tečku v logu.

**Jedna barva pro „primární a vybráno".** Ne černá pro vybranou platební metodu a modrá pro hlavní tlačítko na téže obrazovce. Viz §7.

## 6. Typografie

| Token | Písmo a řez | Použití |
|---|---|---|
| `--type-hero` | IBM Plex Sans 600 / 38 px / −0,02em | jeden nadpis na stránku |
| `--type-section` | IBM Plex Sans 600 / 20 px | nadpisy sekcí |
| `--type-body` | IBM Plex Sans 400 / 14–15 px | běžný text |
| `--type-number` | **IBM Plex Mono 600** | **všechna čísla, bez výjimky** |
| `--type-label` | IBM Plex Mono 10 px / 0,1em | popisky polí, mikrotexty |

Nadpisy nejsou obří — 38 px je strop. Velikostní kontrast se dělá rastrem a barvou, ne velikostí písma.

**Rastr a linky:** `--grid-minor` 16 px, `--grid-major` 80 px, `--rule-w` 1 px, `--rule-strong` 2 px.

## 7. Logo

### Primární wordmark

**`TAVEN.`**

Schválená varianta **TEČKA** je slovní značka v IBM Plex Mono 600 zakončená
akcentní tečkou. Tečka představuje konec rozhodování: **platí / potvrzeno /
hotovo**. Stejnou významovou logiku používá akcentní modrá v rozhraní.

Na světlém podkladu jsou písmena v `--ink` (`#1A1A16`) a tečka v `--accent`
(`#1B44E8`). Inverzní varianta na `--ink` používá písmena v `--paper`
(`#EFEFEA`) a světlejší modrou tečku `#5C7CFF`. Referenční HTML a mockup určují
vizuální směr; jejich inline styly, rozměry karty a `data-*` atributy nejsou
implementačním kontraktem.

### Compact mark

**`TV.`** — stejná konstrukce a barevná pravidla pro favicon a prostory, kde
celý wordmark není čitelný.

### Jednobarevná varianta

Celý wordmark včetně tečky může být jednobarevný v černé nebo bílé podle podkladu.

Kótovací linka zůstává prvkem vizuálního systému, nikoli součástí primárního loga. Varianta s prořezáním vrstvami tisku se nepoužívá kvůli horší čitelnosti v malých velikostech.

Zakázané motivy: tiskárna, ozubené kolo, 3D kostka, vrstvený válec, kapka, nozzle jako logo.

## 8. Dokumentační gramatika a shells

Schválené prvky systému:

- `REV. 01`, `LIST 02 / 05`, `ZÁZNAM 01`, `ŘEZ A–A`, `DETAIL A`
- čísla zakázek typu `TV-2604`
- identifikátory realizací typu `D-0142`
- kótovací linky, osy XYZ, leader annotations, milimetrový rastr
- indexované procesní kroky

Číslované kroky jsou povolené v **aplikační navigaci**, například:

`01 SOUBOR — 02 KONFIGURACE — 03 DOPRAVA — 04 PLATBA — 05 VÝROBA`

Nejde o generickou marketingovou sekci „4 jednoduché kroky“, ale o skutečnou orientaci v procesu.

### Public shell

Plný veřejný header, indexovaná navigace, CTA `NAHRÁT MODEL` a plný engineering `TitleBlockFooter`.

### Application shell

`ProcessHeader`, stabilní dvousloupcová geometrie a kompaktní engineering footer.

- vlevo `--paper`: model / pracovní úloha,
- vpravo persistentní `--surface`: kontext procesu.

Pravý panel mění význam `STAV SOUBORU → KONFIGURACE/CENA → OBJEDNÁVKA → SHRNUTÍ`, ale jeho geometrie a background zůstávají stabilní.

### Account shell

Účet není SaaS dashboard. Je to **zákaznický archiv / registr výrobních zakázek** s jazykem `ZÁZNAM`, `TV-XXXX`, `REV.`, stav, datum, položky a částka.

### Footer

Plný footer je webová interpretace popisového pole technického výkresu. Application/account používají kompaktní variantu. Footer nezveřejňuje soukromou adresu výroby.

### Otevřený bod

Formální clearance názvu Taven. Logo, modrá a základní engineering-document language jsou od v1.1 **uzavřené**.

## 9. Kontrola pro jakýkoli artefakt

- Je někde vidět konkrétní maker nebo stroj? → musí být ne
- Je někde zveřejněna neveřejná dílna? → musí být ne
- Je někde volba mezi dodavateli nebo cenami? → musí být ne
- Je všechen text česky? → musí být ano
- Jsou všechna čísla v mono? → musí být ano
- Je akcent pod 5 % plochy? → musí být ano
- Používá se jedna barva pro primární i vybrané? → musí být ano
- Jsou kontaktní údaje, IČO a jména **skutečné**? → musí být ano; vymyšlené údaje v mockupu se přepíšou do kódu a nikdo si toho nevšimne

- Nese technický prvek informaci? → pokud ne, pravděpodobně ho odstranit
- Působí rozhraní jako výrobní služba, ne CAD/ERP/e-shop/SaaS dashboard? → musí být ano

export const LEGAL_DRAFT_STATUS = "NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI";

export type LegalDraftSection = Readonly<{
  title: string;
  paragraphs?: readonly string[];
  items?: readonly string[];
  note?: string;
}>;

export type LegalDraft = Readonly<{
  sourceDocumentId: string;
  status: typeof LEGAL_DRAFT_STATUS;
  sections: readonly LegalDraftSection[];
}>;

type LegalDraftKey =
  | "terms"
  | "claims"
  | "privacy"
  | "prohibitedContent"
  | "retention"
  | "photoConsent";

export const legalDrafts: Record<LegalDraftKey, LegalDraft> = {
  terms: {
    sourceDocumentId: "terms-pending",
    status: LEGAL_DRAFT_STATUS,
    sections: [
      {
        title: "1. Provozovatel",
        paragraphs: [
          "Službu Taven provozuje Studio81 Labs, s.r.o., IČ 29508291, DIČ CZ29508291, se sídlem Nové sady 988/2, 602 00 Brno, Česká republika. Zápis v obchodním rejstříku bude doplněn po právní revizi. Elektronický kontakt je uveden v identifikační části této stránky (dále jen „Provozovatel“).",
          "Taven je služba umožňující zákazníkům objednat výrobu fyzických výrobků zejména metodou 3D tisku na základě digitálního modelu dodaného zákazníkem nebo vytvořeného konkrétně pro něj v rámci individuální modelářské práce. Verze v0 nenabízí katalog modelů ani automatické generování modelů z textu nebo fotografií.",
          "Provozovatel vystupuje vůči zákazníkovi jako prodávající a smluvní strana zákazníka. Vystavuje doklady k objednávce, odpovídá za sjednanou kvalitu výrobku a vyřizuje reklamace.",
          "Podle aktuálních podkladů pro verzi v0 není Provozovatel plátcem DPH; zveřejnění DIČ samo o sobě neznamená registraci k DPH. Tento status musí být znovu ověřen bezprostředně před právním schválením a zveřejněním účinného znění.",
          "Výrobu ve verzi v0 technicky zajišťuje Provozovatel na vlastním zařízení.",
        ],
      },
      {
        title: "2. Objednávka",
        paragraphs: [
          "Zákazník vytvoří objednávku prostřednictvím služby Taven zejména:",
        ],
        items: [
          "nahráním nebo výběrem digitálního modelu",
          "volbou dostupných parametrů výroby",
          "uvedením požadovaného množství",
          "výběrem způsobu doručení",
          "zadáním požadovaných kontaktních a fakturačních údajů",
          "uhrazením nebo potvrzením objednávky podle zvoleného způsobu platby",
        ],
        note: "Před dokončením objednávky je zákazníkovi zobrazena výsledná cena. Objednávka se stává závaznou způsobem uvedeným v objednávkovém procesu. Provozovatel může objednávku odmítnout zejména tehdy, pokud výrobek není technicky realizovatelný, porušuje pravidla služby, existuje důvodné podezření na porušení práv třetích osob nebo výroba představuje nepřiměřené bezpečnostní či právní riziko. V takovém případě bude již uhrazená částka vrácena, pokud již nevznikl jiný oprávněný nárok Provozovatele.",
      },
      {
        title: "3. Výroba",
        paragraphs: [
          "Údaje o době výroby jsou odhadem, není-li u konkrétní objednávky výslovně uvedena garantovaná lhůta.",
          "3D tisk je výrobní proces, při kterém mohou vznikat běžné technologické odchylky, zejména:",
        ],
        items: [
          "viditelné vrstvy",
          "drobné stopy po podpěrách",
          "mírné barevné rozdíly",
          "drobné rozměrové tolerance",
          "rozdíly v orientaci vrstev nebo povrchu",
        ],
        note: "Takové vlastnosti samy o sobě nepředstavují vadu, pokud odpovídají běžným vlastnostem zvolené výrobní technologie a nebrání sjednanému použití výrobku. Provozovatel může z technických důvodů upravit orientaci modelu, rozmístění na tiskové podložce, podpůrné struktury a další výrobní parametry, pokud tím není podstatně změněn objednaný výrobek.",
      },
      {
        title: "4. Cena a platba",
        paragraphs: [
          "Cena je zákazníkovi zobrazena před dokončením objednávky.",
          "Cena může zahrnovat zejména cenu materiálu, výrobní čas, přípravu výroby, dokončovací práce, balení, dopravu a další zvolené služby.",
          "Objednávka založená na automatické nabídce se hradí v plné výši předem.",
          "U individuální nabídky nebo modelářské práce může přijatá nabídka rozdělit cenu na zálohu a doplatek. Zákazník uhradí zálohu podle podmínek nabídky a doplatek před odesláním výrobku.",
          "Každá plná platba, záloha a doplatek se evidují jako samostatná platební transakce. Případné částečné nebo úplné vrácení peněz se přiřadí ke konkrétní zachycené platbě, aby bylo zřejmé, jaká část ceny byla uhrazena, vrácena a zbývá k finančnímu vypořádání.",
          "Platba zachycená až po uzavření příslušného platebního okna nebo po zrušení objednávky sama o sobě objednávku neobnoví a bude v plné výši vrácena.",
          "Platby mohou být zpracovávány prostřednictvím externího poskytovatele platebních služeb.",
          "Provozovatel neuchovává kompletní údaje platebních karet, pokud jejich zpracování zajišťuje poskytovatel platebních služeb.",
        ],
      },
      {
        title: "5. Dodání",
        paragraphs: [
          "Výrobek bude dodán způsobem zvoleným při objednávce.",
          "Předpokládaný termín výroby nebo dodání uvedený službou je orientační, pokud není výslovně označen jako garantovaný.",
          "Provozovatel nenese odpovědnost za prodlení způsobené okolnostmi mimo jeho přiměřenou kontrolu, zejména výpadkem dopravce nebo mimořádnou událostí.",
          "Tím nejsou dotčena zákonná práva spotřebitele.",
        ],
      },
      {
        title: "6. Výrobky vyrobené podle požadavků zákazníka",
        paragraphs: [
          "Významná část výrobků poskytovaných prostřednictvím Taven je vyráběna podle specifikace zákazníka nebo přizpůsobena jeho požadavkům.",
          "Na takové výrobky se může vztahovat zákonná výjimka z práva spotřebitele odstoupit od smlouvy ve 14denní lhůtě.",
          "Pokud se výjimka na konkrétní objednávku vztahuje, musí být zákazník před objednáním srozumitelně informován a její použití výslovně potvrdit.",
          "Toto omezení nemá vliv na práva zákazníka z vadného plnění.",
        ],
      },
      {
        title: "7. Odpovědnost zákazníka za digitální obsah",
        paragraphs: [
          "Zákazník odpovídá za to, že má právo digitální model použít k objednané výrobě.",
          "Nahráním modelu zákazník prohlašuje, že jeho použití neporušuje zejména:",
        ],
        items: [
          "autorská práva",
          "práva k ochranným známkám",
          "průmyslová práva",
          "obchodní tajemství",
          "osobnostní práva",
          "jiná práva třetích osob",
        ],
        note: "Provozovatel není povinen aktivně ověřovat vlastnictví práv ke každému nahranému modelu, může však provádět automatickou nebo manuální kontrolu podle pravidel služby.",
      },
      {
        title: "8. Zakázaný obsah",
        paragraphs: [
          "Prostřednictvím Taven není dovoleno objednávat výrobu předmětů zakázaných pravidly služby nebo právními předpisy.",
          "Podrobnosti stanoví dokument Pravidla zakázaného obsahu a manuální kontroly.",
        ],
      },
      {
        title: "9. Reklamace",
        paragraphs: [
          "Práva zákazníka z vadného plnění a postup při reklamaci upravuje dokument Reklamační řád.",
        ],
      },
      {
        title: "10. Odpovědnost",
        paragraphs: [
          "Provozovatel odpovídá za řádné poskytnutí objednané služby v rozsahu stanoveném právními předpisy.",
          "Informace poskytované službou o vlastnostech materiálů a výrobků mají obecný charakter, není-li výslovně sjednáno jinak.",
          "Zákazník nesmí bez odpovídajícího ověření předpokládat, že výrobek je vhodný pro bezpečnostně kritické, zdravotnické, potravinářské, tlakové, elektrické nebo jiné regulované použití.",
        ],
      },
      {
        title: "11. Změny objednávky",
        paragraphs: [
          "Po zahájení výroby nemusí být možné objednávku změnit nebo zrušit.",
          "Pokud výroba ještě nebyla zahájena, může Provozovatel podle okolností změnu nebo zrušení umožnit.",
        ],
      },
      {
        title: "12. Rozhodné právo",
        paragraphs: [
          "Právní vztahy mezi Provozovatelem a zákazníkem se řídí právem České republiky.",
          "Je-li zákazník spotřebitelem, nejsou tím dotčena jeho práva vyplývající z kogentních ustanovení spotřebitelského práva.",
        ],
      },
      {
        title: "13. Mimosoudní řešení spotřebitelských sporů",
        paragraphs: [
          "Spotřebitel má právo na mimosoudní řešení spotřebitelského sporu u příslušného subjektu podle platných právních předpisů.",
        ],
        note: "[DOPLNIT FINÁLNÍ INFORMACE O ADR DLE PRÁVNÍ REVIZE]",
      },
    ],
  },
  claims: {
    sourceDocumentId: "claims-pending",
    status: LEGAL_DRAFT_STATUS,
    sections: [
      {
        title: "1. Účel",
        paragraphs: [
          "Tento reklamační řád stanoví postup při uplatnění práv z vadného plnění u výrobků objednaných prostřednictvím Taven a při řešení ztracené nebo vrácené zásilky.",
          "Reklamace vyřizuje Studio81 Labs, s.r.o. jako Provozovatel a smluvní strana zákazníka.",
        ],
      },
      {
        title: "2. Co lze reklamovat",
        paragraphs: ["Zákazník může reklamovat zejména:"],
        items: [
          "nesprávný výrobek",
          "nesprávný počet kusů",
          "významnou rozměrovou odchylku",
          "chybějící nebo poškozené části",
          "výrobní vadu",
          "nesoulad s potvrzenými parametry objednávky",
          "poškození vzniklé před předáním zákazníkovi",
          "zásilku, kterou dopravce označil jako ztracenou nebo vrácenou před řádným doručením",
        ],
      },
      {
        title: "3. Běžné vlastnosti 3D tisku",
        paragraphs: [
          "Za vadu se zpravidla nepovažují technologicky běžné vlastnosti 3D tisku, které nemají podstatný vliv na sjednané vlastnosti výrobku, například viditelnost jednotlivých vrstev nebo drobné stopy po odstranění podpůrných struktur.",
          "Konkrétní posouzení vždy závisí na objednaných parametrech a účelu výrobku, který byl mezi stranami sjednán.",
          "Provozovatel odpovídá za věrnost výtisku potvrzenému modelu, nikoli bez dalšího za vhodnost nebo lícování modelu pro konkrétní použití. Model laděný na jiné tiskárně může obsahovat vlastní rozměrové kompenzace; odlišné lícování výtisku, který jinak věrně odpovídá dodanému modelu, proto samo o sobě není vadou tisku.",
        ],
      },
      {
        title: "4. Uplatnění reklamace",
        paragraphs: [
          "Reklamaci lze uplatnit prostřednictvím elektronického zákaznického kontaktu uvedeného v identifikační části této stránky. Zákazník by měl uvést:",
        ],
        items: [
          "číslo objednávky",
          "popis vady",
          "kdy se vada projevila",
          "podle možností fotografie vady",
        ],
        note: "Fotografie slouží k rychlejšímu prvotnímu posouzení. Provozovatel může požadovat zaslání výrobku, pokud bez jeho fyzické kontroly nelze reklamaci řádně posoudit.",
      },
      {
        title: "5. Vyřízení reklamace",
        paragraphs: [
          "Podle povahy vady a zákonných práv zákazníka může být reklamace vyřízena zejména:",
          "Incident ztracené nebo vrácené zásilky lze řešit již před jinak očekávaným dokončením objednávky. Podle stavu zakázky může vést k náhradní výrobě nebo zásilce, anebo k finančně vypořádanému zrušení a odpovídajícímu vrácení peněz. Každý výsledek se samostatně eviduje a nemění zpětně již dosažený stav původního plnění.",
        ],
        items: [
          "odstraněním vady",
          "novou výrobou",
          "dodáním chybějící části",
          "přiměřenou slevou",
          "vrácením ceny",
        ],
        note: "Volba konkrétního způsobu vyřízení se řídí platnými právními předpisy a povahou vady.",
      },
      {
        title: "6. Náklady",
        paragraphs: [
          "Je-li reklamace oprávněná, má zákazník právo na náhradu účelně vynaložených nákladů v rozsahu stanoveném právními předpisy.",
        ],
      },
      {
        title: "7. Lhůta",
        paragraphs: [
          "Reklamace spotřebitele bude vyřízena v zákonné lhůtě, není-li se zákazníkem v souladu se zákonem dohodnuta lhůta delší.",
          "Při přijetí objednávky se uloží verze reklamačních pravidel, kterou zákazník přijal. Pro každou doručenou položku nebo samostatně doručenou část objednávky se podle ní stanoví konkrétní lhůta pro standardní uplatnění reklamace.",
          "Požadavek podaný po této lhůtě bude předán k individuálnímu právnímu posouzení; tím nejsou dotčeny zákonné nebo smluvní výjimky ani práva, která nelze omezit.",
        ],
        note: "[FINÁLNÍ PROCES A LHŮTY OVĚŘIT PRÁVNÍKEM]",
      },
    ],
  },
  privacy: {
    sourceDocumentId: "privacy-pending",
    status: LEGAL_DRAFT_STATUS,
    sections: [
      {
        title: "1. Správce",
        paragraphs: [
          "Správcem osobních údajů je Studio81 Labs, s.r.o., IČ 29508291, DIČ CZ29508291, se sídlem Nové sady 988/2, 602 00 Brno, Česká republika. Elektronický kontakt pro ochranu osobních údajů je uveden v identifikační části této stránky.",
        ],
      },
      {
        title: "2. Jaké údaje zpracováváme",
        paragraphs: [
          "Podle způsobu používání Taven můžeme zpracovávat zejména:",
        ],
        items: [
          "jméno a příjmení",
          "e-mail",
          "telefonní číslo",
          "fakturační údaje",
          "doručovací adresu",
          "údaje o objednávkách",
          "komunikaci se zákaznickou podporou",
          "informace o reklamacích",
          "technické údaje o používání služby",
          "IP adresu a bezpečnostní logy",
          "nahrané digitální modely",
          "fotografie související s objednávkou nebo reklamací",
        ],
      },
      {
        title: "3. Účely zpracování",
        paragraphs: ["Osobní údaje zpracováváme zejména za účelem:"],
        items: [
          "vytvoření a správy objednávky",
          "výroby a doručení výrobku",
          "zpracování platby",
          "zákaznické podpory",
          "reklamací",
          "plnění účetních a právních povinností",
          "ochrany služby před zneužitím",
          "řešení bezpečnostních incidentů",
          "případné marketingové komunikace, pokud pro ni existuje odpovídající právní základ",
        ],
      },
      {
        title: "4. Právní základy",
        paragraphs: ["Údaje zpracováváme podle okolností zejména na základě:"],
        items: [
          "plnění smlouvy",
          "plnění právních povinností",
          "oprávněného zájmu",
          "souhlasu",
        ],
      },
      {
        title: "5. Příjemci údajů",
        paragraphs: [
          "Údaje mohou být v nezbytném rozsahu zpřístupněny zejména:",
        ],
        items: [
          "poskytovatelům platebních služeb",
          "dopravcům",
          "poskytovatelům hostingových a cloudových služeb",
          "poskytovatelům komunikačních služeb",
          "účetním, daňovým nebo právním poradcům",
          "orgánům veřejné moci, pokud to vyžaduje zákon",
        ],
        note: "Každý příjemce obdrží pouze údaje nezbytné pro svůj konkrétní účel. Rozsah předávaných údajů bude minimalizován podle technického a logistického procesu Taven.",
      },
      {
        title: "6. Digitální modely",
        paragraphs: [
          "Nahrané digitální modely jsou zpracovávány za účelem kontroly, přípravy a realizace výroby.",
          "Přístup k modelu mohou získat pouze pověřené osoby Provozovatele, pokud je to nezbytné pro realizaci zakázky nebo manuální kontrolu.",
          "Model nebude bez dalšího právního důvodu používán k výrobě pro jiné zákazníky.",
        ],
      },
      {
        title: "7. Doba uchování",
        paragraphs: [
          "Jednotlivé kategorie údajů uchováváme pouze po dobu potřebnou pro příslušný účel nebo po dobu vyžadovanou právními předpisy.",
          "Konkrétní pravidla pro digitální modely a nedokončené objednávky stanoví Pravidla uchování dat a opuštěných položek.",
        ],
      },
      {
        title: "8. Práva subjektu údajů",
        paragraphs: ["Za podmínek stanovených GDPR máte zejména právo:"],
        items: [
          "na přístup k osobním údajům",
          "na opravu",
          "na výmaz",
          "na omezení zpracování",
          "na přenositelnost údajů",
          "vznést námitku proti zpracování",
          "odvolat udělený souhlas",
          "podat stížnost u příslušného dozorového úřadu",
        ],
        note: "V České republice je dozorovým orgánem Úřad pro ochranu osobních údajů.",
      },
      {
        title: "9. Automatizované zpracování",
        paragraphs: [
          "Taven může používat automatizované nástroje pro technickou analýzu modelů, kalkulaci výroby, detekci rizikového obsahu nebo prevenci zneužití.",
          "Pokud by bylo zavedeno automatizované rozhodování s právními nebo obdobně významnými účinky ve smyslu GDPR, budou zákazníkovi poskytnuty odpovídající informace a práva vyžadovaná právními předpisy.",
        ],
      },
      {
        title: "10. Bezpečnost",
        paragraphs: [
          "Provozovatel používá přiměřená technická a organizační opatření k ochraně osobních údajů před neoprávněným přístupem, ztrátou, změnou nebo zveřejněním.",
        ],
      },
    ],
  },
  prohibitedContent: {
    sourceDocumentId: "prohibited-content-pending",
    status: LEGAL_DRAFT_STATUS,
    sections: [
      {
        title: "1. Účel",
        paragraphs: [
          "Taven nesmí být používán k výrobě předmětů, jejichž výroba, držení, distribuce nebo zamýšlené použití je protiprávní, porušuje práva třetích osob nebo představuje nepřijatelné bezpečnostní či právní riziko.",
          "Provozovatel může odmítnout zakázku také tehdy, pokud není možné s přiměřenou jistotou určit, zda je její realizace v souladu s těmito pravidly nebo právními předpisy.",
        ],
      },
      {
        title: "2. Zakázané zakázky",
        paragraphs: ["Ve verzi v0 jsou zakázány zejména zakázky zahrnující:"],
        items: [
          "předměty, jejichž výroba nebo distribuce je protiprávní",
          "střelné zbraně a jejich části, bez ohledu na to, zda konkrétní část sama podléhá zvláštní regulaci",
          "předměty zjevně určené k výrobě, úpravě nebo zvýšení účinnosti zbraní",
          "výbušniny nebo komponenty zjevně určené k jejich výrobě",
          "předměty určené k neoprávněnému překonávání fyzických nebo technických bezpečnostních mechanismů",
          "padělky nebo předměty zjevně porušující práva duševního vlastnictví",
          "předměty porušující práva k ochranným známkám, průmyslovým vzorům nebo jiným chráněným označením",
          "obsah porušující osobnostní práva třetích osob",
          "předměty obsahující nezákonný nenávistný, extremistický nebo jinak protiprávní obsah",
          "sexuální obsah zahrnující nezletilé osoby",
          "předměty, jejichž výroba by představovala nepřijatelné bezpečnostní riziko",
          "jiné předměty, jejichž výrobu Provozovatel nesmí nebo nechce z právních či bezpečnostních důvodů prostřednictvím Taven zajišťovat",
        ],
        note: "Tento seznam není vyčerpávající. Provozovatel takovou zakázku nepřijme nebo ji odmítne.",
      },
      {
        title: "3. Regulované a bezpečnostně kritické použití",
        paragraphs: [
          "Taven není bez předchozího individuálního schválení určen k výrobě komponent, u kterých může jejich selhání přímo způsobit újmu na zdraví, životě nebo významnou škodu na majetku. Individuální schválení se ve verzi v0 nevztahuje na zdravotnické prostředky určené pro styk s tělem ani na jinou kategorii výslovně zakázanou těmito pravidly. Zvýšené riziko se může týkat zejména:",
        ],
        items: [
          "zdravotnických prostředků určených pro styk s tělem, které jsou ve verzi v0 zakázané",
          "ochranných prostředků",
          "kritických automobilových nebo motocyklových součástí",
          "leteckých komponent",
          "tlakových systémů",
          "elektrických bezpečnostních komponent",
          "zařízení určených pro styk s potravinami",
          "konstrukčních prvků s významnou nosnou funkcí",
        ],
        note: "Skutečnost, že Taven technicky umožní nahrání, nacenění nebo objednání modelu, sama o sobě neznamená potvrzení jeho vhodnosti pro konkrétní použití nebo splnění příslušných norem a regulatorních požadavků.",
      },
      {
        title: "4. Práva třetích osob",
        paragraphs: [
          "Zákazník smí prostřednictvím Taven zadat výrobu pouze tehdy, pokud má potřebná práva k použití příslušného digitálního modelu.",
          "Provozovatel nemusí aktivně ověřovat právní stav každého modelu.",
          "Pokud však existuje důvodné podezření, že model porušuje práva třetí osoby, může být objednávka pozastavena nebo odmítnuta a zákazník může být vyzván k doložení oprávnění model použít.",
        ],
      },
      {
        title: "5. Automatická kontrola",
        paragraphs: [
          "Nahrané soubory a údaje objednávky mohou být podrobeny automatizované technické nebo bezpečnostní kontrole. Kontrola může vyhodnocovat například:",
        ],
        items: [
          "technickou vyrobitelnost",
          "parametry modelu",
          "rizikové charakteristiky",
          "metadata souboru",
          "předchozí bezpečnostní signály",
          "jiné indikátory možného porušení pravidel",
        ],
        note: "Automatická kontrola nemusí být schopna spolehlivě určit povahu nebo zamýšlené použití každého modelu.",
      },
      {
        title: "6. Manuální kontrola",
        paragraphs: [
          "Ve verzi v0 prochází manuální kontrolou náhledu každá objednávka.",
          "Rozšířenou manuální kontrolu mohou vyžadovat zejména případy, kdy:",
        ],
        items: [
          "ji označí automatický systém",
          "oprávněná osoba při přípravě výroby upozorní na potenciální problém",
          "charakter modelu není jednoznačný",
          "vznikne podezření na porušení práv třetí osoby",
          "vznikne bezpečnostní nebo právní pochybnost",
        ],
        note: "Za účelem manuální kontroly může oprávněná osoba získat přístup k nahranému modelu, náhledu modelu a souvisejícím údajům objednávky pouze v rozsahu nezbytném pro posouzení.",
      },
      {
        title: "7. Pozastavení objednávky",
        paragraphs: [
          "Po dobu manuální kontroly může být objednávka pozastavena. Provozovatel může zákazníka požádat o doplňující informace, například o:",
        ],
        items: [
          "účel výrobku",
          "licenci k modelu",
          "doklad o vlastnictví práv",
          "technické informace",
          "vysvětlení zamýšleného použití",
        ],
        note: "Zákazník není povinen takové informace dodat, jejich neposkytnutí však může vést k odmítnutí objednávky.",
      },
      {
        title: "8. Odmítnutí objednávky",
        paragraphs: [
          "Provozovatel si vyhrazuje právo odmítnout výrobu, pokud existuje důvodné právní, bezpečnostní nebo provozní riziko.",
          "Odmítnutí výroby neznamená tvrzení, že zákazník jedná protiprávně.",
          "Pokud byla odmítnutá objednávka již zaplacena a výroba nebyla zahájena, bude uhrazená částka vrácena, pokud neexistuje jiný oprávněný důvod k jejímu zadržení.",
        ],
      },
      {
        title: "9. Oznámení problematického obsahu",
        paragraphs: [
          "Osoba, která se domnívá, že prostřednictvím Taven dochází k porušování jejích práv, může kontaktovat Provozovatele prostřednictvím elektronického právního kontaktu uvedeného v identifikační části této stránky.",
          "Oznámení by mělo obsahovat dostatek informací umožňujících identifikaci příslušného obsahu a důvodu oznámení.",
        ],
      },
      {
        title: "10. Evidence kontroly",
        paragraphs: [
          "Provozovatel může uchovávat záznam o výsledku bezpečnostní nebo manuální kontroly, pokud je to nezbytné pro ochranu služby, řešení sporů, prevenci opakovaného zneužití nebo splnění právních povinností.",
          "Doba uchování se řídí pravidly ochrany osobních údajů a retenční politikou Taven.",
        ],
      },
    ],
  },
  retention: {
    sourceDocumentId: "retention-pending",
    status: LEGAL_DRAFT_STATUS,
    sections: [
      {
        title: "1. Účel",
        paragraphs: [
          "Tento dokument popisuje základní pravidla, podle kterých Taven uchovává nahrané soubory, rozpracované objednávky a další data související s výrobou.",
          "Cílem je neuchovávat zákaznické výrobní podklady déle, než je nezbytné.",
        ],
      },
      {
        title: "2. Nahrané modely",
        paragraphs: [
          "Digitální model nahraný zákazníkem může být uchováván po dobu potřebnou k:",
          "Zdrojová CAD data jsou citlivější než běžný export STL. Retenční a mazací pravidla se však nevážou na příponu souboru: vztahují se na všechny podporované zdrojové formáty, včetně STL, 3MF a STEP, a na jejich odvozené soubory.",
        ],
        items: [
          "vytvoření nabídky",
          "technické analýze",
          "výrobě",
          "kontrole výsledku",
          "řešení reklamace",
          "jinému účelu souvisejícímu s objednávkou",
        ],
        note: "Pro každý úspěšně nahraný zdrojový model se stanoví plánované datum odstranění. Základní lhůta činí 90 dní od úspěšného nahrání; vytvoření platné nabídky ji může prodloužit, aktivní objednávka odstranění dočasně pozastaví a výslovný právní hold může lhůtu dále prodloužit. Po skončení aktivní objednávky nebo právního holdu se datum odstranění znovu určí podle retenčních pravidel. [ČEKÁ NA PRÁVNÍ REVIZI — 90 DNÍ]",
      },
      {
        title: "3. Dokončené objednávky a reklamační podklad",
        paragraphs: [
          "Plánované datum odstranění zdrojových uploadů a jejich odvozených pracovních souborů se při ukončení objednávky nastaví nejméně na 90 dní od jejího ukončení. Výslovný právní hold může odstranění dále odložit, nikdy však uspíšit.",
          "Nezávisle na zdrojových souborech uchovává Provozovatel u přijaté objednávky oddělený šifrovaný reprodukční podklad potřebný k posouzení nebo nápravě dodaného výrobku. U doručeného výrobku zůstane tento podklad zachován alespoň do konce příslušné reklamační lhůty; běžící reklamace, incident zásilky nebo právní hold mohou jeho odstranění dále odložit.",
          "Reprodukční podklad smí být použit pouze k posouzení a nápravě původní objednávky, nikoli jako skrytá dlouhodobá archivace pro novou objednávku. Po uplynutí jeho lhůty a skončení všech oprávněných překážek se odstraní rekonstruovatelné podklady a zůstanou jen nereverzibilní kontrolní otisky a auditní metadata.",
          "U objednávky ukončené bez doručení se navrhuje samostatná devadesátidenní lhůta reprodukčního podkladu od ukončení objednávky; aktivní incident, reklamace nebo právní hold ji mohou prodloužit.",
        ],
        note: "[ČEKÁ NA PRÁVNÍ REVIZI — 90 DNÍ PRO ZDROJOVÉ SOUBORY] [NÁVRH — 90 DNÍ PRO NEDORUČENÝ REPRODUKČNÍ PODKLAD NENÍ SCHVÁLENO] Tyto lhůty se nevztahují automaticky na účetní a transakční dokumentaci.",
      },
      {
        title: "4. Nedokončené uploady a objednávky",
        paragraphs: ["Za nedokončený zákaznický postup se považuje zejména:"],
        items: [
          "nahraný model bez dokončené objednávky",
          "nedokončená kalkulace",
          "nedokončený košík",
          "rozpracovaná objednávka, která nebyla potvrzena nebo zaplacena",
        ],
        note: "Výrobní zdrojové soubory z nedokončeného postupu se řídí plánovaným datem odstranění stanoveným při úspěšném nahrání, jehož základní lhůta činí 90 dní. Platná nabídka může tuto lhůtu prodloužit; samotná neaktivita nesmí bez dalšího převést soubor do odlišné třicetidenní kategorie. [ČEKÁ NA PRÁVNÍ REVIZI — 90 DNÍ]",
      },
      {
        title: "5. Opuštěné fyzické výrobky",
        paragraphs: [
          "Pokud již vyrobený výrobek zůstane po finančně vypořádaném zrušení objednávky u Provozovatele, může být po skončení retenční lhůty bezpečně recyklován nebo zničen.",
          "Odstranění fyzického výrobku musí být evidováno tak, aby bylo možné doložit datum a způsob naložení s výrobkem.",
        ],
        note: "[NÁVRH — 30 DNÍ NENÍ SCHVÁLENO] Navrhovaná lhůta pro opuštěný fyzický výrobek je 30 dní od finančního vypořádání zrušené objednávky. Toto pravidlo se nevztahuje na nahrané digitální modely.",
      },
      {
        title: "6. Zamítnuté objednávky",
        paragraphs: [
          "Modely související se zamítnutou objednávkou budou odstraněny bez zbytečného odkladu poté, co přestanou být potřebné pro:",
        ],
        items: [
          "dokončení refundace",
          "řešení komunikace se zákazníkem",
          "bezpečnostní kontrolu",
          "řešení právního nároku",
          "prevenci závažného zneužívání služby",
        ],
        note: "Je-li nutné uchovat informaci o bezpečnostním incidentu, Provozovatel se může pokusit uchovat pouze minimální informace potřebné k danému účelu namísto původního výrobního souboru.",
      },
      {
        title: "7. Reklamace",
        paragraphs: [
          "Pokud je k objednávce zahájena reklamace, může být po dobu jejího řešení uchován oddělený reprodukční podklad a fotografie v rozsahu potřebném pro posouzení nebo nápravu reklamovaného výrobku.",
          "Reklamace sama o sobě automaticky neprodlužuje uchování původního zdrojového uploadu; ten se nadále řídí vlastní lhůtou, ledaže je na něj z konkrétního právního důvodu uplatněn výslovný právní hold.",
          "Po vyřešení reklamace se plánovaná data odstranění přepočítají. Další uchování může odůvodnit pouze trvající ochrana konkrétního právního nároku nebo jiný výslovný právní hold.",
        ],
      },
      {
        title: "8. Fotografie",
        paragraphs: [
          "Fotografie výrobků pořízené v rámci kontroly kvality, dokumentace reklamace, manuální kontroly nebo komunikace se zákazníkem jsou provozní dokumentací.",
          "Každá uložená provozní fotografie musí už při úspěšném nahrání dostat datum nahrání a konečné plánované datum odstranění. Bez stanoveného data odstranění se nesmí v produkci trvale uložit originál, náhled ani odvozená kopie.",
          "Platná nabídka může datum odstranění prodloužit pouze o schválenou omezenou dobu. Aktivní objednávka jej může dočasně pozastavit; při ukončení objednávky se datum přepočítá nejméně do příslušné reklamační lhůty.",
          "Po ukončení objednávky smí odstranění dále odložit pouze probíhající reklamace v odpovídajícím rozsahu nebo výslovný právní hold. Po jejich skončení se odstraní originál, transformace, náhledy i vložená metadata a zůstane pouze nereverzibilní kontrolní otisk a auditní metadata.",
          "Použití fotografie pro marketing, portfolio nebo veřejnou prezentaci se řídí samostatným souhlasem.",
        ],
        note: "[NÁVRH — 90 DNÍ NENÍ SCHVÁLENO] Do schválení konkrétní lhůty zůstává produkční ukládání referenčních fotografií zákazníka vypnuté.",
      },
      {
        title: "9. Účetní a transakční údaje",
        paragraphs: [
          "Daňové doklady, účetní záznamy, údaje o platbách a další dokumentace podléhající zákonným archivačním povinnostem mohou být uchovávány déle než výrobní soubory.",
          "Jejich uchování se řídí příslušnými právními předpisy.",
        ],
      },
      {
        title: "10. Zálohy",
        paragraphs: [
          "Odstraněná data mohou po omezenou dobu přetrvávat v technických zálohách.",
          "Data v zálohách nejsou po odstranění z produkčního systému běžně dostupná a budou odstraněna v rámci standardního cyklu rotace záloh.",
        ],
        note: "[DOBU UCHOVÁNÍ ZÁLOH DOPLNIT PODLE KONFIGURACE COOLIFY/R2]",
      },
      {
        title: "11. Požadavek na výmaz",
        paragraphs: [
          "Zákazník může požádat o výmaz osobních údajů podle podmínek GDPR prostřednictvím elektronického kontaktu správce uvedeného v identifikační části této stránky.",
          "Právo na výmaz není absolutní. Některé údaje může být Provozovatel povinen nebo oprávněn dále uchovávat například kvůli právním, účetním nebo bezpečnostním povinnostem.",
        ],
      },
      {
        title: "12. Technická implementace",
        paragraphs: ["Produkční systém by měl evidovat minimálně:"],
        items: [
          "typ uloženého objektu",
          "datum vytvoření",
          "datum poslední aktivity",
          "vazbu na objednávku",
          "retenční kategorii",
          "plánované datum odstranění",
          "případný retention hold",
        ],
        note: "Retention hold musí zabránit automatickému odstranění dat například během reklamace nebo právního sporu.",
      },
    ],
  },
  photoConsent: {
    sourceDocumentId: "photo-consent-pending",
    status: LEGAL_DRAFT_STATUS,
    sections: [
      {
        title: "1. Provozní fotografie",
        paragraphs: [
          "Provozovatel může v přiměřeném rozsahu pořizovat fotografie výrobku, pokud je to potřebné pro:",
        ],
        items: [
          "kontrolu kvality",
          "doložení stavu před odesláním",
          "řešení výrobního problému",
          "reklamaci",
          "podporu zákazníka",
          "řešení sporu",
        ],
        note: "Takové fotografie jsou provozní dokumentací. Jejich pořízení není marketingovým souhlasem a fotografie nebudou pouze na tomto základě zveřejněny.",
      },
      {
        title: "2. Veřejné použití fotografií",
        paragraphs: [
          "Provozovatel může zákazníka samostatně požádat o souhlas s použitím fotografie dokončeného výrobku například pro:",
        ],
        items: [
          "web Taven",
          "portfolio",
          "sociální sítě",
          "případové studie",
          "propagační materiály",
        ],
        note: "Tento souhlas je dobrovolný. Odmítnutí souhlasu nemá vliv na cenu, zpracování nebo kvalitu objednávky.",
      },
      {
        title: "3. Forma souhlasu",
        paragraphs: [
          "Souhlas nesmí být předem zaškrtnutý ani být podmínkou dokončení objednávky.",
          "Příklad produktového nastavení: [ ] Souhlasím, aby Taven mohl použít fotografie výsledného výrobku ve svém portfoliu a marketingové komunikaci.",
          "Před udělením souhlasu musí mít zákazník možnost získat informace o jeho rozsahu a způsobu odvolání.",
        ],
      },
      {
        title: "4. Rozsah zveřejnění",
        paragraphs: [
          "Není-li výslovně dohodnuto jinak, veřejná prezentace výrobku nebude obsahovat:",
        ],
        items: [
          "jméno zákazníka",
          "kontaktní údaje",
          "adresu",
          "číslo objednávky",
          "původní neveřejný digitální model ke stažení",
          "jiné údaje umožňující identifikovat zákazníka",
        ],
        note: "Provozovatel by měl před zveřejněním přiměřeně odstranit nebo skrýt informace, které nejsou potřebné pro prezentaci výrobku.",
      },
      {
        title: "5. Odvolání souhlasu",
        paragraphs: [
          "Zákazník může souhlas s budoucím používáním fotografie odvolat prostřednictvím elektronického kontaktu správce uvedeného v identifikační části této stránky.",
          "Odvolání souhlasu nemá vliv na zákonnost zpracování provedeného před jeho odvoláním.",
          "Po odvolání Provozovatel okamžitě přestane fotografii používat pro nové marketingové účely a odstraní ji z míst pod svou přímou kontrolou.",
          "Marketingový souhlas neprodlužuje retenční lhůtu provozní zdrojové fotografie. Veřejná nebo marketingová kopie musí být odstraněna nejpozději při uplynutí lhůty zdrojové fotografie, i když souhlas nebyl odvolán, nebo okamžitě po odvolání souhlasu.",
        ],
        note: "[PRÁVNÍ REVIZE POTŘEBNÁ PRO JIŽ VYDANÉ NEBO DISTRIBUOVANÉ MATERIÁLY]",
      },
      {
        title: "6. Důvěrnost zákaznických modelů",
        paragraphs: [
          "Digitální model dodaný zákazníkem je považován za neveřejný, pokud zákazník výslovně neurčí jinak.",
          "Zdrojová CAD data jsou citlivější než běžný export STL. Stejná pravidla důvěrnosti a retence se bez ohledu na příponu vztahují na všechny podporované zdrojové formáty, včetně STL, 3MF a STEP, i na jejich odvozené soubory.",
          "Provozovatel jej neposkytne jiným zákazníkům ani jej nepoužije k výrobě pro třetí osoby bez odpovídajícího právního důvodu.",
          "Přístup k modelu mohou získat pouze osoby, které jej potřebují pro:",
        ],
        items: [
          "kalkulaci",
          "technickou kontrolu",
          "přípravu výroby",
          "samotnou výrobu",
          "kontrolu kvality",
          "zákaznickou podporu",
          "reklamaci",
          "bezpečnostní nebo právní kontrolu",
        ],
      },
      {
        title: "7. Důvěrné zakázky",
        paragraphs: [
          "Taven může umožnit označení objednávky jako důvěrné zakázky.",
          "Důvěrná zakázka je určena zejména pro neveřejné prototypy, vývojové díly, obchodně citlivé návrhy a jiné modely, u kterých zákazník požaduje zvýšenou ochranu výrobních podkladů a informací o zakázce.",
          "Označení zakázky jako důvěrné samo o sobě nepřevádí na Provozovatele žádná práva duševního vlastnictví k modelu.",
        ],
      },
      {
        title: "7.1 Přístup k důvěrné zakázce",
        paragraphs: [
          "Přístup k důvěrné zakázce bude omezen pouze na osoby, které jej potřebují pro její zpracování, zejména za účelem:",
        ],
        items: [
          "technické kontroly",
          "přípravy výroby",
          "samotné výroby",
          "kontroly kvality",
          "řešení technického problému",
          "zákaznické podpory nebo reklamace",
          "bezpečnostní nebo právní kontroly, je-li nezbytná",
        ],
        note: "Každé pověřené osobě bude zpřístupněn pouze rozsah informací potřebný k realizaci konkrétní zakázky. Pokud výrobní nebo logistický proces nevyžaduje znalost identity zákazníka, tato informace se pověřené osobě nezpřístupní.",
      },
      {
        title: "7.2 Povinnosti pověřených osob",
        paragraphs: [
          "Pověřená osoba, která zpracovává důvěrnou zakázku, je povinna zachovávat mlčenlivost o jejím obsahu a nesmí zejména:",
        ],
        items: [
          "pořizovat fotografie nebo video výrobku, s výjimkou případů nezbytných pro výrobu, kontrolu kvality nebo řešení problému",
          "zveřejnit fotografie nebo jiné informace o zakázce",
          "zveřejnit skutečnost, že konkrétní zakázku realizoval",
          "použít model nebo jeho část pro vlastní projekty",
          "vyrobit další kusy mimo rozsah přidělené zakázky",
          "model kopírovat nebo archivovat nad rámec nezbytný pro realizaci zakázky",
          "předat model nebo informace o zakázce jiné osobě bez oprávnění Provozovatele",
          "použít výrobek, model nebo informace o něm ve svém portfoliu, na sociálních sítích nebo v jiné veřejné prezentaci",
        ],
        note: "Tyto povinnosti musí být odpovídajícím způsobem zahrnuty v pracovním, dodavatelském nebo jiném smluvním vztahu pověřené osoby k Provozovateli.",
      },
      {
        title: "7.3 Fotografie a dokumentace",
        paragraphs: [
          "U důvěrné zakázky se standardně nepředpokládá pořizování fotografií pro marketingové nebo prezentační účely.",
          "Je-li fotografie nezbytná pro kontrolu kvality, reklamaci nebo řešení výrobního problému, může být pořízena a zpracována pouze pro tento provozní účel.",
          "Taková fotografie nesmí být použita pro portfolio, marketing ani jinou veřejnou prezentaci bez samostatného výslovného souhlasu zákazníka.",
        ],
      },
      {
        title: "7.4 Uchování výrobních podkladů",
        paragraphs: [
          "Výrobní podklady důvěrné zakázky budou uchovávány pouze po dobu nezbytnou pro její realizaci a následné splnění oprávněných provozních nebo právních účelů.",
          "Pokud není jejich další uchování potřebné například z důvodu reklamace, právního sporu nebo zákonné povinnosti, budou odstraněny podle retenčních pravidel Taven.",
          "Pověřené osoby jsou po dokončení zakázky povinny odstranit lokální kopie výrobních podkladů, pokud jejich další uchování není výslovně povoleno Provozovatelem.",
        ],
      },
      {
        title: "7.5 Důvěrnost ze strany Provozovatele",
        paragraphs: [
          "Provozovatel nebude bez právního důvodu zveřejňovat ani poskytovat třetím osobám:",
        ],
        items: [
          "digitální model",
          "technickou dokumentaci zákazníka",
          "fotografie výrobku",
          "informace o účelu výrobku",
          "jiné neveřejné informace získané v souvislosti s důvěrnou zakázkou",
        ],
        note: "Tím není dotčeno zpřístupnění informací osobám nezbytným pro realizaci služby, právním nebo odborným poradcům vázaným odpovídající povinností důvěrnosti nebo orgánům veřejné moci, pokud jejich poskytnutí vyžadují právní předpisy.",
      },
      {
        title: "7.6 Individuální NDA",
        paragraphs: [
          "Vyžaduje-li zákazník vyšší úroveň smluvní ochrany, může být před předáním výrobních podkladů sjednána samostatná dohoda o mlčenlivosti (NDA).",
          "Samotné označení objednávky jako důvěrné zakázky nenahrazuje individuálně sjednanou NDA, pokud ji zákazník vyžaduje.",
          "Dostupnost individuální NDA, případné dodatečné podmínky a způsob jejího uzavření mohou záviset na charakteru a hodnotě zakázky.",
        ],
      },
      {
        title: "7.7 Bezpečnostní a právní kontrola",
        paragraphs: [
          "Režim důvěrné zakázky nevylučuje kontrolu podle Pravidel zakázaného obsahu a manuální kontroly.",
          "Pokud je kontrola nezbytná pro splnění právních povinností nebo ochranu bezpečnosti služby, může být důvěrný model zpřístupněn oprávněné osobě v minimálním rozsahu potřebném pro posouzení.",
        ],
      },
      {
        title: "7.8 Omezení ochrany",
        paragraphs: [
          "Provozovatel přijme přiměřená technická a organizační opatření k ochraně důvěrných zakázek, nemůže však bez individuální dohody garantovat konkrétní stupeň informační bezpečnosti, certifikaci nebo režim odpovídající zvláštním regulatorním požadavkům.",
          "Zákazník by proto prostřednictvím standardní služby neměl předávat informace podléhající zvláštním bezpečnostním režimům, utajované informace nebo jiné údaje, pro jejichž zpracování jsou vyžadována specifická zákonná či smluvní bezpečnostní opatření, pokud jejich zpracování nebylo s Provozovatelem předem individuálně dohodnuto.",
        ],
      },
    ],
  },
};

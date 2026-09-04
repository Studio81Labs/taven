export const LEGAL_DRAFT_STATUS = "DRAFT / NEÚČINNÉ";

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
    sourceDocumentId: "terms-of-service",
    status: LEGAL_DRAFT_STATUS,
    sections: [
      {
        title: "1. Provozovatel",
        paragraphs: [
          "Službu Taven provozuje Studio81 Labs, s.r.o., IČ 29508291, DIČ CZ29508291, se sídlem Nové sady 988/2, 602 00 Brno, Česká republika. Zápis v obchodním rejstříku bude doplněn po právní revizi. Elektronický kontakt je uveden v identifikační části této stránky (dále jen „Provozovatel“).",
          "Taven je služba umožňující zákazníkům objednat výrobu fyzických výrobků zejména metodou 3D tisku na základě zákazníkem dodaného nebo prostřednictvím služby získaného digitálního modelu.",
          "Provozovatel vystupuje vůči zákazníkovi jako poskytovatel služby a smluvní strana zákazníka.",
          "Výroba může být technicky zajištěna Provozovatelem nebo třetími osobami zapojenými do výrobní sítě Taven („Výrobci“). Zákazník nevstupuje uzavřením objednávky do samostatného smluvního vztahu s Výrobcem.",
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
    sourceDocumentId: "complaints-policy",
    status: LEGAL_DRAFT_STATUS,
    sections: [
      {
        title: "1. Účel",
        paragraphs: [
          "Tento reklamační řád stanoví postup při uplatnění práv z vadného plnění u výrobků objednaných prostřednictvím Taven.",
          "Reklamace vyřizuje Studio81 Labs, s.r.o., bez ohledu na to, který Výrobce fyzicky realizoval výrobu.",
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
        ],
      },
      {
        title: "3. Běžné vlastnosti 3D tisku",
        paragraphs: [
          "Za vadu se zpravidla nepovažují technologicky běžné vlastnosti 3D tisku, které nemají podstatný vliv na sjednané vlastnosti výrobku, například viditelnost jednotlivých vrstev nebo drobné stopy po odstranění podpůrných struktur.",
          "Konkrétní posouzení vždy závisí na objednaných parametrech a účelu výrobku, který byl mezi stranami sjednán.",
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
        ],
        note: "[FINÁLNÍ PROCES A LHŮTY OVĚŘIT PRÁVNÍKEM]",
      },
    ],
  },
  privacy: {
    sourceDocumentId: "privacy-policy",
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
          "Výrobcům realizujícím konkrétní zakázku",
          "poskytovatelům platebních služeb",
          "dopravcům",
          "poskytovatelům hostingových a cloudových služeb",
          "poskytovatelům komunikačních služeb",
          "účetním, daňovým nebo právním poradcům",
          "orgánům veřejné moci, pokud to vyžaduje zákon",
        ],
        note: "Výrobce obdrží pouze údaje nezbytné pro realizaci konkrétní zakázky. Rozsah předávaných údajů bude minimalizován podle technického a logistického procesu Taven.",
      },
      {
        title: "6. Digitální modely",
        paragraphs: [
          "Nahrané digitální modely jsou zpracovávány za účelem kontroly, přípravy a realizace výroby.",
          "Přístup k modelu mohou získat pracovníci Provozovatele a Výrobce, pokud je to nezbytné pro realizaci zakázky nebo manuální kontrolu.",
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
    sourceDocumentId: "prohibited-content-policy",
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
        paragraphs: ["Provozovatel může odmítnout zejména zakázky zahrnující:"],
        items: [
          "předměty, jejichž výroba nebo distribuce je protiprávní",
          "nelegální zbraně nebo regulované součásti zbraní",
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
        note: "Tento seznam není vyčerpávající.",
      },
      {
        title: "3. Regulované a bezpečnostně kritické použití",
        paragraphs: [
          "Taven není bez předchozího individuálního schválení určen k výrobě komponent, u kterých může jejich selhání přímo způsobit újmu na zdraví, životě nebo významnou škodu na majetku. To se může týkat zejména:",
        ],
        items: [
          "zdravotnických prostředků",
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
          "Objednávka může být předána k manuální kontrole zejména pokud:",
        ],
        items: [
          "ji označí automatický systém",
          "Výrobce upozorní na potenciální problém",
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
    sourceDocumentId: "retention-policy",
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
        ],
        items: [
          "vytvoření nabídky",
          "technické analýze",
          "výrobě",
          "kontrole výsledku",
          "řešení reklamace",
          "jinému účelu souvisejícímu s objednávkou",
        ],
        note: "Pokud zákazník model pouze nahraje, ale objednávku nedokončí, vztahují se na něj pravidla pro opuštěné položky.",
      },
      {
        title: "3. Dokončené objednávky",
        paragraphs: [
          "Výrobní soubory související s dokončenou objednávkou budou podle dosud neschváleného návrhu odstraněny po 90 dnech od dokončení objednávky, pokud není jejich další uchování nezbytné například z důvodu:",
        ],
        items: [
          "probíhající reklamace",
          "právního sporu",
          "bezpečnostního incidentu",
          "zákonné povinnosti",
          "výslovného požadavku zákazníka v rámci funkce služby umožňující dlouhodobé uložení",
        ],
        note: "[NÁVRH — 90 DNÍ NENÍ SCHVÁLENO] Tato lhůta se vztahuje na výrobní podklady, nikoli automaticky na účetní a transakční dokumentaci.",
      },
      {
        title: "4. Opuštěné položky",
        paragraphs: ["Za opuštěnou položku se považuje zejména:"],
        items: [
          "nahraný model bez dokončené objednávky",
          "nedokončená kalkulace",
          "nedokončený košík",
          "rozpracovaná objednávka, která nebyla potvrzena nebo zaplacena",
        ],
        note: "[NÁVRH — 30 DNÍ NENÍ SCHVÁLENO] Taková data mohou být automaticky odstraněna po 30 dnech od poslední aktivity, není-li technicky nebo právně potřebné jejich kratší či delší uchování.",
      },
      {
        title: "5. Zamítnuté objednávky",
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
        title: "6. Reklamace",
        paragraphs: [
          "Pokud je k objednávce zahájena reklamace, mohou být související výrobní soubory a fotografie uchovány po dobu jejího řešení a následně po dobu nezbytnou pro ochranu právních nároků Provozovatele nebo zákazníka.",
        ],
      },
      {
        title: "7. Fotografie",
        paragraphs: [
          "Fotografie výrobků pořízené v rámci kontroly kvality, dokumentace reklamace, manuální kontroly nebo komunikace se zákazníkem jsou provozní dokumentací a mohou být uchovávány po dobu nezbytnou pro příslušný účel.",
          "Použití fotografie pro marketing, portfolio nebo veřejnou prezentaci se řídí samostatným souhlasem.",
        ],
      },
      {
        title: "8. Účetní a transakční údaje",
        paragraphs: [
          "Daňové doklady, účetní záznamy, údaje o platbách a další dokumentace podléhající zákonným archivačním povinnostem mohou být uchovávány déle než výrobní soubory.",
          "Jejich uchování se řídí příslušnými právními předpisy.",
        ],
      },
      {
        title: "9. Zálohy",
        paragraphs: [
          "Odstraněná data mohou po omezenou dobu přetrvávat v technických zálohách.",
          "Data v zálohách nejsou po odstranění z produkčního systému běžně dostupná a budou odstraněna v rámci standardního cyklu rotace záloh.",
        ],
        note: "[DOBU UCHOVÁNÍ ZÁLOH DOPLNIT PODLE KONFIGURACE COOLIFY/R2]",
      },
      {
        title: "10. Požadavek na výmaz",
        paragraphs: [
          "Zákazník může požádat o výmaz osobních údajů podle podmínek GDPR prostřednictvím elektronického kontaktu správce uvedeného v identifikační části této stránky.",
          "Právo na výmaz není absolutní. Některé údaje může být Provozovatel povinen nebo oprávněn dále uchovávat například kvůli právním, účetním nebo bezpečnostním povinnostem.",
        ],
      },
      {
        title: "11. Technická implementace",
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
    sourceDocumentId: "photo-consent-and-confidentiality",
    status: LEGAL_DRAFT_STATUS,
    sections: [
      {
        title: "1. Provozní fotografie",
        paragraphs: [
          "Provozovatel nebo Výrobce může v přiměřeném rozsahu pořizovat fotografie výrobku, pokud je to potřebné pro:",
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
          "Po odvolání Provozovatel přestane fotografii používat pro nové marketingové účely a odstraní ji z míst pod svou přímou kontrolou, pokud je to přiměřeně možné.",
        ],
        note: "[PRÁVNÍ REVIZE POTŘEBNÁ PRO JIŽ VYDANÉ NEBO DISTRIBUOVANÉ MATERIÁLY]",
      },
      {
        title: "6. Důvěrnost zákaznických modelů",
        paragraphs: [
          "Digitální model dodaný zákazníkem je považován za neveřejný, pokud zákazník výslovně neurčí jinak.",
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
        title: "7. Výrobci",
        paragraphs: [
          "Pokud výrobu realizuje Výrobce zapojený do sítě Taven, může mu Provozovatel zpřístupnit výrobní podklady potřebné k realizaci konkrétní zakázky.",
          "Výrobce nesmí zákaznický model:",
        ],
        items: [
          "používat pro vlastní potřebu",
          "poskytovat třetím osobám",
          "veřejně publikovat",
          "prodávat",
          "používat k výrobě dalších kusů mimo přidělenou zakázku",
          "uchovávat déle, než je potřebné podle pravidel Taven",
        ],
        note: "Tyto povinnosti musí být odpovídajícím způsobem zahrnuty také ve smluvním vztahu mezi Provozovatelem a Výrobcem.",
      },
      {
        title: "8. Důvěrné zakázky",
        paragraphs: [
          "Taven může umožnit označení objednávky jako důvěrné zakázky.",
          "Důvěrná zakázka je určena zejména pro neveřejné prototypy, vývojové díly, obchodně citlivé návrhy a jiné modely, u kterých zákazník požaduje zvýšenou ochranu výrobních podkladů a informací o zakázce.",
          "Označení zakázky jako důvěrné samo o sobě nepřevádí na Provozovatele ani Výrobce žádná práva duševního vlastnictví k modelu.",
        ],
      },
      {
        title: "8.1 Přístup k důvěrné zakázce",
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
        note: "Výrobci bude zpřístupněn pouze rozsah informací potřebný k realizaci konkrétní zakázky. Pokud výrobní nebo logistický proces nevyžaduje znalost identity zákazníka, nemusí být Výrobci tato informace zpřístupněna.",
      },
      {
        title: "8.2 Povinnosti Výrobce",
        paragraphs: [
          "Výrobce, kterému je důvěrná zakázka přidělena, je povinen zachovávat mlčenlivost o jejím obsahu a nesmí zejména:",
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
        note: "Tyto povinnosti musí být odpovídajícím způsobem zahrnuty ve smluvním vztahu mezi Provozovatelem a Výrobcem.",
      },
      {
        title: "8.3 Fotografie a dokumentace",
        paragraphs: [
          "U důvěrné zakázky se standardně nepředpokládá pořizování fotografií pro marketingové nebo prezentační účely.",
          "Je-li fotografie nezbytná pro kontrolu kvality, reklamaci nebo řešení výrobního problému, může být pořízena a zpracována pouze pro tento provozní účel.",
          "Taková fotografie nesmí být použita pro portfolio, marketing ani jinou veřejnou prezentaci bez samostatného výslovného souhlasu zákazníka.",
        ],
      },
      {
        title: "8.4 Uchování výrobních podkladů",
        paragraphs: [
          "Výrobní podklady důvěrné zakázky budou uchovávány pouze po dobu nezbytnou pro její realizaci a následné splnění oprávněných provozních nebo právních účelů.",
          "Pokud není jejich další uchování potřebné například z důvodu reklamace, právního sporu nebo zákonné povinnosti, budou odstraněny podle retenčních pravidel Taven.",
          "Výrobce je povinen po dokončení zakázky odstranit lokální kopie výrobních podkladů, pokud jejich další uchování není výslovně povoleno Provozovatelem.",
        ],
      },
      {
        title: "8.5 Důvěrnost ze strany Provozovatele",
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
        title: "8.6 Individuální NDA",
        paragraphs: [
          "Vyžaduje-li zákazník vyšší úroveň smluvní ochrany, může být před předáním výrobních podkladů sjednána samostatná dohoda o mlčenlivosti (NDA).",
          "Samotné označení objednávky jako důvěrné zakázky nenahrazuje individuálně sjednanou NDA, pokud ji zákazník vyžaduje.",
          "Dostupnost individuální NDA, případné dodatečné podmínky a způsob jejího uzavření mohou záviset na charakteru a hodnotě zakázky.",
        ],
      },
      {
        title: "8.7 Bezpečnostní a právní kontrola",
        paragraphs: [
          "Režim důvěrné zakázky nevylučuje kontrolu podle Pravidel zakázaného obsahu a manuální kontroly.",
          "Pokud je kontrola nezbytná pro splnění právních povinností nebo ochranu bezpečnosti služby, může být důvěrný model zpřístupněn oprávněné osobě v minimálním rozsahu potřebném pro posouzení.",
        ],
      },
      {
        title: "8.8 Omezení ochrany",
        paragraphs: [
          "Provozovatel přijme přiměřená technická a organizační opatření k ochraně důvěrných zakázek, nemůže však bez individuální dohody garantovat konkrétní stupeň informační bezpečnosti, certifikaci nebo režim odpovídající zvláštním regulatorním požadavkům.",
          "Zákazník by proto prostřednictvím standardní služby neměl předávat informace podléhající zvláštním bezpečnostním režimům, utajované informace nebo jiné údaje, pro jejichž zpracování jsou vyžadována specifická zákonná či smluvní bezpečnostní opatření, pokud jejich zpracování nebylo s Provozovatelem předem individuálně dohodnuto.",
        ],
      },
    ],
  },
};

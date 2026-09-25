<script setup lang="ts">
import { publicSite } from "../content/public-site";

definePageMeta({ layout: "public" });
const contacts = usePublicContacts();

usePublicPageMeta({
  path: "/kontakt",
  title: "Kontakt",
  description:
    "Kontakt a identifikace provozovatele služby zakázkového 3D tisku " +
    publicSite.brand.name +
    ".",
});
</script>

<template>
  <article class="public-page public-page--contact">
    <div class="sheet-utility sheet-utility--inset">
      <span>LIST 05 / KONTAKT</span
      ><span>ADRESÁŘ KOMUNIKACE A PROVOZOVATEL</span>
    </div>
    <header class="contact-intro">
      <p class="public-page__index">PŘÍMÝ KONTAKT / PODLE TYPU DOTAZU</p>
      <h1>KONTAKT / TAVEN — Napiš nám.</h1>
      <p>
        Pro dotazy k zakázce použij číslo objednávky. Nestandardní zadání pošli
        individuální poptávkou; ostatní zákaznické dotazy vyřídíme e-mailem.
      </p>
    </header>
    <div class="contact-layout">
      <div class="contact-cards">
        <section class="contact-card contact-card--primary">
          <p class="public-page__index">CELA 01 / DOTAZ K ZAKÁZCE</p>
          <h2>Běžící zakázka</h2>
          <p>
            Potřebuješ se zeptat na stav, doručení nebo změnu? Uveď číslo své
            objednávky z potvrzovacího e-mailu.
          </p>
          <div class="contact-card__action">
            <span>ZÁKAZNICKÝ KONTAKT</span
            ><a :href="contacts.customer.href">{{ contacts.customer.email }}</a>
          </div>
        </section>
        <section class="contact-card">
          <p class="public-page__index">CELA 02 / OBECNÝ DOTAZ</p>
          <h2>Před objednáním</h2>
          <p>
            Na materiál, dostupné možnosti nebo postup se zeptej přes zákaznický
            kontakt. Bez hotového modelu je vhodná individuální poptávka.
          </p>
          <div class="contact-card__action">
            <span>ZÁKAZNICKÝ KONTAKT</span
            ><a :href="contacts.customer.href">{{ contacts.customer.email }}</a>
          </div>
        </section>
        <section class="contact-card">
          <p class="public-page__index">CELA 03 / INDIVIDUÁLNÍ ZADÁNÍ</p>
          <h2>Nemáš 3D model?</h2>
          <p>
            Popiš účel, rozměry a přilož dostupné podklady. Zadání posoudí
            člověk; automatická cena touto cestou nevzniká.
          </p>
          <NuxtLink class="public-link" to="/poptavka" no-prefetch
            >Otevřít individuální poptávku ↗</NuxtLink
          >
        </section>
        <div class="contact-cards__foot">
          U DOTAZU K ZAKÁZCE UVEĎ ČÍSLO OBJEDNÁVKY · KOMUNIKACE PROBÍHÁ
          ELEKTRONICKY
        </div>
      </div>
      <aside class="contact-operator">
        <div class="contact-operator__identity">
          <p class="public-page__index">PRÁVNÍ SUBJEKT A IDENTIFIKACE</p>
          <dl>
            <div>
              <dt>Společnost</dt>
              <dd>{{ publicSite.seller.legalName }}</dd>
            </div>
            <div>
              <dt>IČ</dt>
              <dd>{{ publicSite.seller.companyId }}</dd>
            </div>
            <div>
              <dt>DIČ</dt>
              <dd>{{ publicSite.seller.vatId }}</dd>
            </div>
            <div>
              <dt>Sídlo</dt>
              <dd>{{ publicSite.seller.address.join(", ") }}</dd>
            </div>
            <div>
              <dt>Zákaznický kontakt</dt>
              <dd>
                <a :href="contacts.customer.href">{{
                  contacts.customer.email
                }}</a>
              </dd>
            </div>
            <div>
              <dt>Právní a privacy dotazy</dt>
              <dd>
                <a :href="contacts.dataController.href">{{
                  contacts.dataController.email
                }}</a>
              </dd>
            </div>
          </dl>
          <div class="contact-operator__notice">
            <strong>UPOZORNĚNÍ PROVOZU</strong>
            <p>
              Sídlo společnosti není veřejným výdejním místem ani adresou dílny.
              Osobní odběr není součástí současné služby.
            </p>
          </div>
        </div>
        <div class="contact-operator__secondary">
          <p class="public-page__index">DORUČENÍ</p>
          <p>
            Dostupné možnosti a jejich aktuální cenu vybereš při objednávce před
            platbou.
          </p>
        </div>
      </aside>
    </div>
    <div class="contact-bottom">
      <span>VEŘEJNÝ KONTAKT · {{ publicSite.seller.legalName }}</span
      ><NuxtLink class="public-action" to="/objednavka" no-prefetch
        >Přejít k nahrání modelu</NuxtLink
      >
    </div>
  </article>
</template>

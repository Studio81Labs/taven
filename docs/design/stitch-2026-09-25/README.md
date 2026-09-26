# Final website design reference — 2026-09-25

The owner supplied `stitch_taven_design_system.zip` and requested implementation
preparation while the backend work continues. This is the immutable source
package, not application code or approved commercial/legal copy.

- Archive SHA-256: `b6678ec24f068e856d4f6105fc19856aef6d5e578d08b059872416733ac23aaf`.
- Inventory: 78 files, including 24 HTML/screenshot pairs; 104 ZIP entries including
  directories. [manifest.json](manifest.json) records every file hash, size and PNG
  dimensions.
- The archive contains generated HTML, screenshots, page specifications, a
  component JSON catalogue and the Precision Blueprint design system.
- Extract into a temporary directory with `unzip stitch_taven_design_system.zip -d
/tmp/taven-design-reference`. Do not copy the exported HTML into Nuxt pages or
  execute its scripts as part of the application.
- References below are paths inside `stitch_taven_design_system/` after extraction.
  The export's own README links use missing hyphenated filenames; use this index.

Implementation: [Epic #264](https://github.com/Studio81Labs/taven/issues/264),
[orchestration #271](https://github.com/Studio81Labs/taven/issues/271), and the
[repository plan](../../plans/2026-09-25-final-web-design.md).

## Reference index

| Screen                   | Screenshot/HTML directory                                  | Page specification                                 |
| ------------------------ | ---------------------------------------------------------- | -------------------------------------------------- |
| 01 Landing               | `01_landing_taven`                                         | `01_landing.md`                                    |
| 02 How it works          | `02_jak_to_funguje_taven`                                  | `02_jak_to_funguje.md`                             |
| 03 Pricing               | `03_cen_k_taven`                                           | `03_cenik.md`                                      |
| 04 Examples              | `04_uk_zky_taven`                                          | `04_ukazky.md`                                     |
| 05 Example detail        | `05_detail_uk_zky_d_0142_taven`                            | `05_ukazka_detail.md`                              |
| 06 Assisted request      | `06_pot_ebuji_model_taven`                                 | `06_potrebuji_model.md`                            |
| 07 Contact               | `07_kontakt_taven`                                         | `07_kontakt.md`                                    |
| 08 Configurator          | `08_konfigur_tor_taven`                                    | `08_konfigurator.md`                               |
| 09 Checkout              | `09_checkout_taven`                                        | `09_checkout.md`                                   |
| 10 Received              | `10_p_ijato_taven`                                         | `10_prijato.md`                                    |
| 11 Tracking              | `11_sledov_n_zak_zky_taven`                                | `11_sledovani.md`                                  |
| 12 Login                 | `12_p_ihl_en_taven`                                        | `12_prihlaseni.md`                                 |
| 13 Activation            | `13_aktivace_tu_taven`                                     | `13_aktivace.md`                                   |
| 14 Orders                | `14_moje_zak_zky_taven`                                    | `14_moje_zakazky.md`                               |
| 15 Settings              | `15_nastaven_taven`                                        | `15_nastaveni.md`                                  |
| 16 Terms                 | `16_vop_taven`                                             | `16_vop.md`                                        |
| 17 Complaints            | `17_reklamace_taven`                                       | `17_reklamace.md`                                  |
| 18 Privacy variants      | `18_ochrana_soukrom_taven_1`, `18_ochrana_soukrom_taven_2` | `18_soukromi.md_1.md`, `18_soukromi.md_2.md`       |
| 19 Responsive board      | `19_responzivn_taven`                                      | `19_responzivne.md_1.md`, `19_responzivne.md_2.md` |
| 20 Logo board            | `20_logo_taven`, `taven_logo`                              | `20_logo.md_1.md`, `20_logo.md_2.md`               |
| 21 Tokens/components     | `21_tokeny_a_komponenty_taven`                             | `21_tokeny.md_1.md`, `21_tokeny.md_2.md`           |
| 22 Dialogs/notifications | `22_dialogy_mod_ln_okna_a_notifikace_taven`                | component JSON; no separate page specification     |

Each directory above contains `screen.png` and `code.html`. System references are
`design.md`, `taven_precision_blueprint/DESIGN.md` and
`taven_komponentov_knihovna_json.json`.

## Interpretation

[ADR 0030](../../decisions/0030-use-nuxt-ui-for-presentation.md) amends the
implementation approach: use Nuxt UI for standard elements with a Taven theme,
and custom product components/layouts. Existing mock-era markup and CSS may be
replaced to achieve the target; neither the archive's generated HTML nor library
defaults prescribe production component structure. Visual references and the
product/contract corrections below remain authoritative. Adoption is pending
implementation, not evidence that the design is finished.

The implementation plan reconciles this package with the current product brief,
identity, decisions and actual API. The numbered screenshots are the hard visual
reference, not alternate mock variants or permission to change domain rules.
The plan documents necessary factual and contract-driven deviations. In
particular, QC is view-only, shipping uses
the Czech Packeta widget, and configuration retains infill. The primary logo is
Plex Mono `TAVEN.` / compact `TV.`. Use the repository's corrected accessible ink
and warning colors.

The export contains contradictory logo/privacy/token variants, fictitious
identities, certification claims, prices, factory information and old product
behavior. It references absent original `Taven.dc.html` files. These are recorded
limitations, not additional inputs required before starting the UI work.

23 HTML files load Tailwind/Google Fonts remotely; 15 reference 17 unique Google
image URLs. No reusable source-photo files or licenses are supplied. Keep the
existing locally packaged IBM Plex fonts. Do not introduce those CDN scripts,
remote images, tracking or HTML templates into production. Screenshots remain
reference artifacts. Use existing model rendering and approved assets; generated
fixtures for visual tests must remain isolated from public content.

Accounts and tracking retain their existing feature owners (#48 and #41). Their
screens are accounted for by the plan, but are not implemented through mock
authentication or operator API access. No final legal approval is needed for
private development/staging using the approved v0.1 baseline.

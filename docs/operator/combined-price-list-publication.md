# Publish a combined CZK price list for assisted offers

The selected `automatic-v0-czk` development list supports automatic quotes but
has no individual balance policy. Until a complete successor is activated,
assisted offer preview and issue return
`INDIVIDUAL_PAYMENT_POLICY_UNAVAILABLE` (409). Existing automatic quotes and
previously issued offers remain on their original immutable lists.

1. In **Catalog → Ceníky a obchodní pravidla**, refresh the CZK selection and
   open the selected list's detail. Record its ID and selection version.
2. Choose **Vytvořit revizi ceníku**. The editor copies the selected list's
   complete `sellerTaxPolicy` and `automaticQuote` JSON. Preserve those values
   exactly, including tax, rates, provider configuration and shipment limits.
   Give the successor a distinct revision name and retain the appropriate
   terms provenance revision.
3. Confirm `balance_payment_days` and the earned component selection. For the
   established development baseline, use **7** and exactly
   `ITEM_PRODUCTION`, `ITEM_QUANTITY`, `ITEM_POSTPROCESSING`. A different
   business policy requires its own approval. Create with a stable command
   key. A lost response can be retried with the same key and identical body.
4. Inspect the new immutable detail. Enter a publication reason and explicitly
   activate it. Activation uses the observed `expectedSelectionVersion` and a
   stable key. If the version changed, refresh and review the current selection
   before deciding whether to activate; never overwrite another publication
   automatically.
5. Refresh the selection and verify automatic preview, then assisted composer
   readiness, preview and issuance. Confirm previously issued binding IDs and
   their price snapshots did not change.

The equivalent supported HTTP sequence is `GET
/admin/catalog/commercial-policy-selections/CZK`, `GET
/admin/catalog/price-lists/{id}`, `POST /admin/catalog/price-lists`, then
`POST /admin/catalog/price-lists/{id}/activate`. Use an
authorized catalog operator session, the normal CSRF header and separate
stable `Idempotency-Key` values for create and activate. Do not edit price-list
rows through SQL or mutate the existing revision. Before deploying the new
publication contract, drain old catalog writers that could still activate an
automatic-only list. Public production approval remains separate.

# Full template catalog

`template-catalog.json` lists all 69 rebranded HTML files under `templates/`, including primary designs, alternate/API designs and the source loading template. `loading.html` is the rebranded source loading template, used as the default loader. Filenames are independent numbered names. The original design layouts, JavaScript and embedded artwork are retained, with identity/config isolation changes.

The database starts empty intentionally. No prior design IDs, prices, order records, user records or payments are imported. Upload the chosen primary/alternate files through Admin Designs, assign new names/prices and enable them. A file being in the source catalog does not automatically publish it to clients. Use the title and role in the catalog to select the intended variant.

Former Firebase project identifiers, keys and account fields are removed. Builds bootstrap the new server runtime bridge BEFORE template listeners, so the template uses the new backend rather than an old Firebase account. Original registration defaults are `example.invalid` placeholders; configure the intended destination when placing the new build order.

Not every arbitrary design/runtime behavior has been browser/device-tested. The automated suite parses inline scripts for all bundled templates before/after injection and checks bridge initialization. It does not certify each template UI, third-party result feed, Android JavaScript interface or device playback. Real build/install acceptance remains mandatory.

# Supported baseline mapping

Root-owned hosted run [35693019507](https://github.com/grtwrn/yale-shuttle/actions/runs/35693019507) rebuilt the unchanged deployed `05a988194af3c376e5aa5da16682c29f797db2b2` Docker frontend stage and exactly reproduced these captured bytes:

| File | Bytes | SHA256 |
| --- | ---: | --- |
| index.html | 1174 | 02dd90560d74374a8e826cd56e36e0d31e4325937f8ed6751899224bc75bd008 |
| assets/rider-U6Gl7ugq.js | 472476 | de3217094fc8eca240035b8562189c7f28891068e4936b0a80a92ca7ccf4e18d |
| assets/geo-BjWFh9tz.js | 198769 | 5d804a22578f34121b98c45d5b614c6e92ebc354d5423109c4d5421ca8203a5f |

Web tree `39e7e9738975f45dfb5c443cc99961a39e9aa4ef` equals this adapter's source tree at `1e8b13e`. Source/bundle identity is established for this baseline. This does not validate the adapter or any candidate. Unknown future bundles remain unsupported. Only the small provenance JSON was read; no prospective outcomes were opened.

September 22 qualification boundary: production subsequently moved through `b00823130aa5e4fcf795b24c44ab7d1859953ca6` (tree `1a0e49bdcba405fa96081318327c8039d7c1c383`) to `e7784c03b8c739eaa603fb231fe5ce80d2d71e82` (tree `c86bcf558a276752ed35b1145bd7c7fc33f7d4cf`). Root reported the latter served `rider-CiwwGOPJ.js`, matching its hosted production build, with successful deployment/browser/API smoke. Its MakeHaven/icon and initial walking-threshold changes do not inherit this adapter's qualification. This file records the boundary, not a new accepted source proof. The [full synthetic benchmark](STREAMING-RESULTS.md) remains frozen on initial `05a9881`; subsequent sources require separate source/bundle/parity review before replay.

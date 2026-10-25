The same original Green payloads and clocks rendered at 390 × 844 in the shipped baseline and the corrected app. These screenshots check bus/clock attribution; they do not establish physical arrival or ETA accuracy.

| Recorded case | Before | After |
| --- | --- | --- |
| Bus 330 has its own 15-second rest; bus 308 has a different 45-second rest at the same stop. | ![330 with the wrong 45-second clock](before-290-phone.png) | ![330 with its own 15-second clock](after-290-phone.png) |
| Bus 308 has no model rest at this stop; bus 330 supplies the other clock. | ![308 borrowing the other bus's clock](before-299-phone.png) | ![308 without a borrowed pause clock](after-299-phone.png) |

The browser gate also checks all four recorded payloads in both raw-bus orders at 307, 390 and 1280 pixels, including matching-clock positive controls. [Original frame hashes and render details](preview.json).

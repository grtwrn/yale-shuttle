# Recency in recorded trip comparisons

Recent observed trips have darker, thicker hollow dots. Every observation remains at its measured time with one dot per completed journey. Historical summary uses a weighted median, with weight halving every two days from the server comparison timestamp. This is a descriptive UI preference, not a fitted forecast parameter.

The summary requires an effective sample size of five, calculated as squared total weight divided by the sum of squared weights. A large collection of old records cannot disguise a single dominant recent record. Observations, matching constraints, and live ETA arithmetic are unchanged. The comparison remains frozen until reopened or refreshed.

Validation: helper tests cover half-life, weighted median, input order, sparse weighted evidence, invalid data, and unchanged observations. Recorded September 17 Winchester → Division/Prospect → Rosenkranz browser verification checks all 37 dots across nine dates against their weights, complete dated rows, and phone layouts at 320/390/430 pixels.

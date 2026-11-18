# Token Radar

![Token Radar bounty](https://make.fun/badge/token-radar-01.svg)
![Rank](https://make.fun/badge/token-radar-01/JefaCVC/token-radar/rank.svg)
![Reward](https://make.fun/badge/token-radar-01/JefaCVC/token-radar/reward.svg)

An entry for [token-radar-01](https://make.fun/bounty/token-radar-01): a
launch radar for pre-token protocols, built from a sealed DefiLlama snapshot of
758 protocols.

The program fits a comps model on the 128 tokens that already trade —
log10(market cap) against log10(TVL), with shrunk family offsets, a capped
7-day growth carry, and launch odds read off the snapshot's own age curve —
then ranks all 198 pre-token protocols (the 40-protocol watchlist plus 158
early finds below the $50M TVL floor) by implied launch value. Every row
carries a P25–P75 / P10–P90 band and a rank range from 200 refits, plus a
farm plan netted to the dollar at a $1,000 ticket: slice if launched, gas,
forgone T-bill yield, break-even odds, net per hands-on hour, and a FARM /
THIN / SKIP verdict.

The model is validated out of sample on the page itself: leave-one-out median
miss ×3.36 and walk-forward ×3.05, against ×5.07 for a flat TVL multiple.
The dashboard re-derives the board in the browser and seals itself against
`board.json`, so the page the judge reads is provably the board the program
wrote.

Run it (Node 22, standard library only, no network):

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

That writes `board.json`, `data.js`, the dashboard, the screenshots and
`dossier.json` into `out/`. Two runs from the same snapshot produce
byte-identical output.

# Grading v2

This revision separates move quality from special chess events and adds a second Stockfish principal variation for position context.

## Engine data

Each non-terminal position is searched with `MultiPV=2` at the selected node budget. The analyzer records the best move, second-best move, their evaluations, and the gap between them. This does not add a second search per position; both PVs come from the same Stockfish search.

## Positive grades

- **Great** — the played move is effectively Stockfish's best move and the position-adjusted gap to the second-best move is at least 125 cp.
- **Best** — the played move is Stockfish's PV move, or is within 10 raw cp of the best evaluation as a small stability tolerance.
- **Good** — not Best/Great and the position-adjusted loss is under 75 cp.

## Negative grades

The dashboard keeps its practical position adjustment:

`factor = 0.30 + 0.70 * max(0, 1 - abs(eval_before_cp) / 1000)`

`adjusted_loss = raw_loss * factor`

- **Inaccuracy** — 75–149 adjusted cp
- **Mistake** — 150–299 adjusted cp
- **Blunder** — 300+ adjusted cp

## Special events

Special events are stored as flags in addition to the move's quality grade.

- **Conversion error** — evaluation before the move is at least +3.00, the move loses at least 1.00 raw pawn, and the player remains at least +1.00 afterward. This identifies degradation of an already winning position without treating every small winning-position fluctuation as a conversion failure.
- **Missed opportunity: advantage** — best play preserves at least +1.00, but the played move falls below +1.00 and loses at least 1.00 raw pawn.
- **Missed opportunity: defense** — best play keeps the position roughly equal (better than -1.00), but the played move falls to -2.00 or worse with a loss of at least 1.50 pawns.
- **Missed mate** — Stockfish has a forced mate and the played move does not continue a mating line. If the resulting position is below +3.00, it is also counted as a practical blunder.

## New move fields

- `adjusted_loss_cp`
- `best_move_gap_cp`
- `best_move_uci`
- `second_best_move_uci`
- `second_best_after_cp`
- `quality_category`
- `is_best_move`
- `great_move`
- `missed_opportunity_type`

## New game fields

For both player and opponent:

- `*_great_moves`
- `*_best_moves`
- `*_good_moves`

## Reanalysis

The analyzer version is now `browser-v2-grading`. Existing `browser-v1` records remain readable, but their historical grades cannot be upgraded without rerunning Stockfish. Use **Full rescan** once for an account when you want all existing games graded under v2.
